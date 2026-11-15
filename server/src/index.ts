import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { Pool } from 'pg';
import { databaseUrl, db, PERMISSIONS } from './db.js';
import { createMessageHistoryCursor } from './message-history.js';
import { shouldNotifyChannelMention } from './mention-policy.js';
import { passwordWithinBcryptLimit } from './password-policy.js';
import { canDirectMessagePeer as canDirectMessagePeerByPolicy } from './dm-policy.js';
import { storeUpload, readUpload, deleteUpload, persistentStorageEnabled, missingStorageEnvironment } from './storage.js';
import { verifyStripeWebhookSignature } from './boost.js';
import {DEFAULT_USER_SETTINGS,userSettingsPatchSchema,mergeUserSettings,normalizeSettingsForEntitlement,requiresBoostSettings} from './user-settings.js';

const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = new Set(
  [origin, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      try { return new URL(value).origin; }
      catch { throw new Error(`Invalid Relay allowed origin: ${value}`); }
    })
);
const isProd = process.env.NODE_ENV === 'production';
const deploymentOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
function isAllowedOrigin(value?: string) {
  return !!value && (allowedOrigins.has(value) || value === deploymentOrigin);
}
const cookieSecure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd;
const cookieSameSite = process.env.COOKIE_SAME_SITE === 'lax' ? 'lax' : process.env.COOKIE_SAME_SITE === 'none' ? 'none' : (isProd ? 'none' : 'lax');
const PORT = Number(process.env.PORT || 3001);
const sessionSecret = process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying';
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Production requires a SESSION_SECRET of at least 32 characters.');
function positiveSetting(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}
const maxUpload = positiveSetting('MAX_UPLOAD_MB', 10) * 1024 * 1024;
const maxUserStorageBytes = positiveSetting('MAX_USER_STORAGE_MB', 500) * 1024 * 1024;
const stagedUploadTtlHours = positiveSetting('STAGED_UPLOAD_TTL_HOURS', 24);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || '../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

app.set('trust proxy', isProd ? 1 : false);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
    objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'https:', 'data:', 'blob:'], fontSrc: ["'self'", 'https:', 'data:'],
    connectSrc: ["'self'", 'https:', 'wss:'], mediaSrc: ["'self'", 'blob:']
  }}
}));
app.use(cors({
  origin: (requestOrigin, callback) => callback(null, isAllowedOrigin(requestOrigin)),
  credentials: true
}));

/* Stripe must receive the exact raw body to verify its signature. */
const webhookAsyncRoute=(fn:(req:Request,res:Response)=>Promise<unknown>) =>
  (req:Request,res:Response,next:NextFunction)=>{void Promise.resolve(fn(req,res)).catch(next);};

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), webhookAsyncRoute(async (req: Request,res: Response) => {
  const secret=process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if(!secret)return res.status(503).json({error:'Stripe Boost webhooks are not configured.'});
  const payload=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
  if(!verifyStripeWebhookSignature(payload,req.header('stripe-signature')||'',secret))return fail(res,400,'Invalid Stripe webhook signature.');
  let event:any;
  try{event=JSON.parse(payload.toString('utf8'));}catch{return fail(res,400,'Invalid webhook payload.');}
  if(typeof event?.id!=='string'||typeof event?.type!=='string')return fail(res,400,'Invalid Stripe event.');

  if(event.type==='checkout.session.completed'&&event.data?.object?.mode==='subscription'){
    const session=event.data.object;
    const userId=String(session.metadata?.userId||session.client_reference_id||'');
    const subscriptionId=typeof session.subscription==='string'?session.subscription:session.subscription?.id;
    const customerId=typeof session.customer==='string'?session.customer:session.customer?.id;
    const stripeKey=process.env.STRIPE_SECRET_KEY?.trim();
    if(userId&&subscriptionId&&stripeKey){
      // Do not grant based only on a completed Checkout page. Read the
      // subscription's authoritative status from Stripe first.
      const response=await fetch('https://api.stripe.com/v1/subscriptions/'+encodeURIComponent(subscriptionId),{headers:{Authorization:'Bearer '+stripeKey}});
      if(!response.ok)throw new Error('Stripe subscription lookup failed; webhook will retry.');
      const subscription:any=await response.json();
      const rawStatus=String(subscription.status||'');
      const status=rawStatus==='active'?'active':rawStatus==='trialing'?'trialing':rawStatus==='past_due'?'past_due':'inactive';
      const periodEnd=Number(subscription.current_period_end)>0?new Date(Number(subscription.current_period_end)*1000).toISOString():null;
      const transaction=db.transaction(()=>{
        const previous=db.prepare('SELECT created FROM stripe_webhook_events WHERE id=?').get(event.id);
        if(previous)return;
        db.prepare(`INSERT INTO user_boosts(user_id,stripe_customer_id,stripe_subscription_id,status,current_period_end,last_event_created,created_at,updated_at)
          VALUES(?,?,?,?,?,?,NOW(),NOW())
          ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=COALESCE(EXCLUDED.stripe_customer_id,user_boosts.stripe_customer_id),
          stripe_subscription_id=EXCLUDED.stripe_subscription_id,status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,
          last_event_created=EXCLUDED.last_event_created,updated_at=NOW()
          WHERE EXCLUDED.last_event_created>=user_boosts.last_event_created`)
          .run(userId,customerId||null,subscriptionId,status,periodEnd,Number(event.created)||0);
        db.prepare('INSERT INTO stripe_webhook_events(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(event.id);
      });
      transaction();
    }
  }else if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
    const subscription=event.data?.object||{};
    const subscriptionId=String(subscription.id||'');
    const existing=subscriptionId?db.prepare('SELECT user_id FROM user_boosts WHERE stripe_subscription_id=?').get(subscriptionId) as any:null;
    const userId=String(subscription.metadata?.userId||existing?.user_id||'');
    if(userId&&subscriptionId){
      const rawStatus=String(subscription.status||'');
      const status=rawStatus==='active'?'active':rawStatus==='trialing'?'trialing':rawStatus==='past_due'?'past_due':'canceled';
      const periodEnd=Number(subscription.current_period_end)>0?new Date(Number(subscription.current_period_end)*1000).toISOString():null;
      const customerId=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
      const transaction=db.transaction(()=>{
        const previous=db.prepare('SELECT created FROM stripe_webhook_events WHERE id=?').get(event.id);
        if(previous)return;
        db.prepare(`INSERT INTO user_boosts(user_id,stripe_customer_id,stripe_subscription_id,status,current_period_end,last_event_created,created_at,updated_at)
          VALUES(?,?,?,?,?,?,NOW(),NOW())
          ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=COALESCE(EXCLUDED.stripe_customer_id,user_boosts.stripe_customer_id),
          stripe_subscription_id=EXCLUDED.stripe_subscription_id,status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,
          last_event_created=EXCLUDED.last_event_created,updated_at=NOW()
          WHERE EXCLUDED.last_event_created>=user_boosts.last_event_created`)
          .run(userId,customerId||null,subscriptionId,status,periodEnd,Number(event.created)||0);
        db.prepare('INSERT INTO stripe_webhook_events(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(event.id);
      });
      transaction();
    }else{
      db.prepare('INSERT INTO stripe_webhook_events(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(event.id);
    }
  }else{
    db.prepare('INSERT INTO stripe_webhook_events(id) VALUES(?) ON CONFLICT(id) DO NOTHING').run(event.id);
  }
  return res.json({received:true});
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// API responses contain account, message, and conversation data. Never let a
// browser or shared intermediary reuse an authenticated response.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Cookie-authenticated writes use a shared Postgres quota across instances.
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const databaseRateLimit = (scope: string, limit: number, windowMs: number) => (req: Request, res: Response, next: NextFunction) => {
  if (safeMethods.has(req.method)) return next();
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const bucketKey = crypto.createHash('sha256').update(`${scope}\\0${address}`).digest('hex');
  void realtimePool.query(`
    INSERT INTO api_rate_limits(bucket_key, request_count, expires_at)
    VALUES($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
    ON CONFLICT(bucket_key) DO UPDATE SET
      request_count = CASE WHEN api_rate_limits.expires_at <= NOW() THEN 1 ELSE api_rate_limits.request_count + 1 END,
      expires_at = CASE WHEN api_rate_limits.expires_at <= NOW() THEN NOW() + ($2 * INTERVAL '1 millisecond') ELSE api_rate_limits.expires_at END,
      updated_at = NOW()
    WHERE api_rate_limits.expires_at <= NOW() OR api_rate_limits.request_count < $3
    RETURNING request_count
  `, [bucketKey, windowMs, limit]).then(result => {
    if (!result.rowCount) { res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000))); return fail(res,429,'Too many requests. Please try again shortly.'); }
    next();
  }).catch(error => {
    console.error('Relay distributed rate limiter failed:', error instanceof Error ? error.message : 'Unknown error');
    fail(res,503,'Request protection is temporarily unavailable. Please try again shortly.');
  });
};
app.use('/api', databaseRateLimit('api-mutation',120,60_000), (req, res, next) => {
  if (safeMethods.has(req.method)) return next();
  const requestOrigin = req.get('origin');
  if (!isAllowedOrigin(requestOrigin) || req.get('x-relay-request') !== '1') {
    return fail(res, 403, 'This request did not pass Relay origin verification.');
  }
  return next();
});

function directRealtimeConnectionString() {
  const configured=process.env.RELAY_REALTIME_DATABASE_URL?.trim();
  if(configured)return configured;
  try {
    const parsed=new URL(databaseUrl);
    if(parsed.hostname.endsWith('.neon.tech')) {
      parsed.hostname=parsed.hostname.replace('-pooler.','.');
    }
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}
const realtimePool=new Pool({
  connectionString:directRealtimeConnectionString(),
  max:4,
  connectionTimeoutMillis:10_000,
  idleTimeoutMillis:10_000,
  keepAlive:true
});
realtimePool.on('error',error=>console.error('Relay realtime database connection error:',error.message));
const io = new SocketServer(server, {
  cors: { origin: (requestOrigin, callback) => callback(null, isAllowedOrigin(requestOrigin)), credentials: true },
  allowRequest: (request, callback) => {
    const requestOrigin = request.headers.origin;
    callback(null, typeof requestOrigin === 'string' && isAllowedOrigin(requestOrigin));
  },
  maxHttpBufferSize: 1e6
});
io.adapter(createAdapter(realtimePool,{tableName:'socket_io_attachments'}));
function disconnectSessionSockets(sessionId: string) {
  io.in(`session:${sessionId}`).disconnectSockets(true);
}
function disconnectUserSockets(userId: string) {
  io.in(`user:${userId}`).disconnectSockets(true);
}
type AuthedRequest = Request & { user?: { id: string; username: string; email: string } };
const sha = (value: string) => crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
const id = () => nanoid(16);
const now = () => new Date().toISOString();
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const asyncRoute = (fn: (req: AuthedRequest, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req as AuthedRequest, res, next)).catch(next);

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.relay_session;
  if (!token) return fail(res, 401, 'Sign in to continue.');
  const session = db.prepare(`SELECT s.id AS session_id,s.user_id,s.expires_at,u.username,u.email
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token)) as any;
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(session.session_id);
    res.clearCookie('relay_session', { httpOnly: true, sameSite: cookieSameSite, secure: cookieSecure, path: '/' });
    return fail(res, 401, 'Your session expired. Sign in again.');
  }
  req.user = { id: session.user_id, username: session.username, email: session.email };
  db.prepare('UPDATE sessions SET last_active=? WHERE id=?').run(now(), session.session_id);
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(), session.user_id);
  next();
}
const requireAuth = [auth];
function membership(serverId: string, userId: string) {
  return db.prepare(`SELECT m.*,r.name AS role_name,r.permissions,r.position FROM memberships m LEFT JOIN roles r ON r.id=m.role_id WHERE m.server_id=? AND m.user_id=?`).get(serverId, userId) as any;
}
function hasPermission(serverId: string, userId: string, permission: string) {
  const owner = db.prepare('SELECT owner_id FROM servers WHERE id=?').get(serverId) as any; if(owner?.owner_id===userId) return true;
  const member = membership(serverId, userId);
  if (!member) return false;
  try { return (JSON.parse(member.permissions || '[]') as string[]).includes(permission); } catch { return false; }
}
function canReadChannel(channelId: string, userId: string) {
  const channel = db.prepare('SELECT server_id FROM channels WHERE id=?').get(channelId) as any;
  return !!channel && !!membership(channel.server_id, userId) && hasPermission(channel.server_id, userId, 'view_channels');
}
function isTimedOut(serverId: string, userId: string) {
  const member = membership(serverId, userId);
  return !!member?.timeout_until && new Date(member.timeout_until).getTime() > Date.now();
}
function canJoinVoiceChannel(channelId: string, userId: string) {
  const channel = db.prepare('SELECT server_id,type FROM channels WHERE id=?').get(channelId) as any;
  return !!channel && channel.type === 'voice' && canReadChannel(channelId, userId) && !isTimedOut(channel.server_id, userId);
}
async function revokeServerMemberRooms(userId: string, channels: Array<{id:string;type:string}>, voiceOnly = false) {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const channel of channels) {
    const channelRoom = `channel:${channel.id}`;
    const voiceRoom = `voice:${channel.id}`;
    for (const socket of sockets) {
      if (channel.type === 'voice' && socket.rooms.has(voiceRoom)) {
        socket.emit('voice:forced-leave',{channelId:channel.id,reason:'Your access to this server voice channel has ended.'});
        socket.leave(voiceRoom);
        const connectedUser = (socket.data as any).user;
        io.to(voiceRoom).emit('voice:participant', {
          userId,
          username: connectedUser?.username || '',
          socketId: socket.id,
          state: 'left'
        });
      }
      if (!voiceOnly && socket.rooms.has(channelRoom)) socket.leave(channelRoom);
    }
  }
}
async function revokeChannelRooms(channel: {id:string;type:string}) {
  const voiceRoom = `voice:${channel.id}`;
  if (channel.type === 'voice') {
    const sockets = await io.in(voiceRoom).fetchSockets();
    for (const socket of sockets) {
      const connectedUser = (socket.data as any).user;
      socket.emit('voice:forced-leave',{channelId:channel.id,reason:'This voice channel is no longer available.'});
      socket.leave(voiceRoom);
      io.to(voiceRoom).emit('voice:participant', {
        userId: connectedUser?.id || '',
        username: connectedUser?.username || '',
        socketId: socket.id,
        state: 'left'
      });
    }
  }
  io.in(`channel:${channel.id}`).socketsLeave(`channel:${channel.id}`);
}
async function deleteStoredObjects(storageNames: string[]) {
  const keys=[...new Set(storageNames.filter(Boolean))].filter(storageName=>path.basename(storageName)===storageName);
  await Promise.all(keys.map(storageName=>deleteUpload(storageName)));
}
function notify(userId: string, type: string, title: string, body: string, href: string) {
  const pref=db.prepare('SELECT data FROM settings WHERE user_id=?').get(userId) as any; let prefs:any={}; try{prefs=JSON.parse(pref?.data||'{}');}catch{}
  if((type==='dm' && prefs.dmNotifications===false) || (type==='mention' && prefs.mentionNotifications===false)) return;
  const notificationId = id();
  db.prepare('INSERT INTO notifications(id,user_id,type,title,body,href) VALUES(?,?,?,?,?,?)')
    .run(notificationId, userId, type, title, body, href);
  if(!prefs.quietMode) io.to(`user:${userId}`).emit('notification:new', { id: notificationId, type, title, body, href, created_at: now(), read_at: null });
}
function userPublic(row: any) {
  if (!row) return null;
  const lastSeen=row.last_seen?new Date(row.last_seen).getTime():0;
  const age=lastSeen?Date.now()-lastSeen:0;
  const stale=!!lastSeen&&age>2*60*1000;
  const presence=row.activity_visible===0||stale?'offline':row.presence==='online'&&lastSeen&&age>60*1000?'idle':row.presence;
  return { id: row.id, username: row.username, avatar: row.avatar, banner: row.banner, bio: row.bio,
    status_text: row.activity_visible === 0 ? '' : row.status_text, presence,
    created_at: row.created_at };
}
function blockedEither(a: string, b: string) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a,b,b,a);
}
async function revokeDmMemberRoom(dmId:string,userId:string) {
  const room=`dm:${dmId}`;
  const sockets=await io.in(`user:${userId}`).fetchSockets();
  for(const socket of sockets)if(socket.rooms.has(room))socket.leave(room);
}
async function revokeDirectMessagesBetween(firstUserId:string,secondUserId:string) {
  const conversations=db.prepare(`SELECT d.id FROM dms d
    JOIN dm_members a ON a.dm_id=d.id AND a.user_id=?
    JOIN dm_members b ON b.dm_id=d.id AND b.user_id=?
    WHERE d.is_group=0`).all(firstUserId,secondUserId) as any[];
  if(!conversations.length)return;
  for(const conversation of conversations){
    await Promise.all([firstUserId,secondUserId].map(userId=>revokeDmMemberRoom(conversation.id,userId)));
  }
}
async function refreshDirectMessageRoomAccess(userId:string) {
  const conversations=db.prepare(`SELECT d.id FROM dms d JOIN dm_members m ON m.dm_id=d.id
    WHERE m.user_id=? AND d.is_group=0`).all(userId) as Array<{id:string}>;
  const affected=new Set<string>([userId]);
  for(const conversation of conversations){
    const members=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=?').all(conversation.id) as Array<{user_id:string}>;
    for(const member of members){
      affected.add(member.user_id);
      if(!canAccessDm(conversation.id,member.user_id))await revokeDmMemberRoom(conversation.id,member.user_id);
    }
  }
  // Clients re-check access and rejoin rooms that are still permitted.
  emitFriendUpdate(...affected);
}
function emitFriendUpdate(...userIds: string[]) {
  for (const userId of new Set(userIds.filter(Boolean))) io.to(`user:${userId}`).emit('friends:updated');
}


function getBoostSnapshot(userId:string){
  const row=db.prepare('SELECT status,current_period_end FROM user_boosts WHERE user_id=?').get(userId) as any;
  const end=row?.current_period_end?new Date(row.current_period_end).getTime():null;
  const active=!!row&&['active','trialing'].includes(row.status)&&(end===null||(Number.isFinite(end)&&end>Date.now()));
  return {active,status:active?row.status:(row?.status||'inactive'),currentPeriodEnd:row?.current_period_end||null,
    checkoutConfigured:!!(process.env.STRIPE_SECRET_KEY?.trim()&&process.env.RELAY_BOOST_PRICE_ID?.trim()&&process.env.STRIPE_WEBHOOK_SECRET?.trim()),
    billingConfigured:!!(process.env.STRIPE_SECRET_KEY?.trim()&&process.env.STRIPE_WEBHOOK_SECRET?.trim())};
}

const authLimiter = databaseRateLimit('auth',20,15*60*1000);
const interactionLimiter = databaseRateLimit('interaction',45,60*1000);
app.get('/api/health', (_req, res) => {
  const productionStorageMissing = isProd ? missingStorageEnvironment : [];
  const passwordRecoveryConfigured = !!(process.env.RESEND_API_KEY?.trim() && process.env.RELAY_EMAIL_FROM?.trim());
  let databaseAvailable = true;

  // Readiness must verify the database, not just the presence of an environment variable.
  try {
    db.prepare('SELECT 1 AS ready').get();
  } catch (error) {
    databaseAvailable = false;
    console.error('Relay database health check failed:', error instanceof Error ? error.message : 'Unknown database error');
  }

  const storageDegraded = isProd && !persistentStorageEnabled;
  const status = !databaseAvailable ? 'unhealthy' : storageDegraded ? 'degraded' : 'ok';
  res
    .status(databaseAvailable ? 200 : 503)
    .set('Cache-Control', 'no-store')
    .json({
      status,
      service: 'relay-api',
      time: now(),
      database: databaseAvailable ? 'connected' : 'unavailable',
      persistentStorage: persistentStorageEnabled,
      storageMode: persistentStorageEnabled ? 's3' : isProd ? 'unavailable' : 'local-disk',
      missingStorageEnvironment: productionStorageMissing,
      passwordRecoveryConfigured
    });
});
app.get('/api/voice/ice-servers', requireAuth, (_req,res) => {
  let configured:any[]=[];
  try { configured=JSON.parse(process.env.RELAY_ICE_SERVERS||'[]'); } catch { return fail(res,500,'Voice relay configuration is invalid.'); }
  if(!Array.isArray(configured))return fail(res,500,'Voice relay configuration must be a JSON array.');
  const iceServers=configured.length?configured:[{urls:'stun:stun.l.google.com:19302'}];
  res.setHeader('Cache-Control','private, no-store');
  res.json({iceServers});
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const schema = z.object({ email: z.string().email().max(254), username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(10).max(128).refine(passwordWithinBcryptLimit, 'Password must be no more than 72 UTF-8 bytes.') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Check your details.');
  const email = parsed.data.email.toLowerCase();
  const username = parsed.data.username;
  if (db.prepare('SELECT 1 FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)').get(email, username)) return fail(res, 409, 'That email or username is already in use.');
  const userId = id();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  try {
    const createAccount=db.transaction(()=>{
      db.prepare('INSERT INTO users(id,email,username,password_hash) VALUES(?,?,?,?)').run(userId,email,username,passwordHash);
      db.prepare('INSERT INTO settings(user_id,data) VALUES(?,?)').run(userId, JSON.stringify({ theme:'graphite', density:'comfortable', accent:'#8795a2', fontScale:100, reducedMotion:false, contrast:'normal', messageLayout:'cozy', keybinds:{ focusSearch:'Ctrl+K', toggleMembers:'Ctrl+Shift+M' } }));
    });
    createAccount();
  } catch(error:any) {
    if(error?.code==='23505')return fail(res,409,'That email or username is already in use.');
    throw error;
  }
  createSession(req, res, userId);
  const saved=db.prepare('SELECT * FROM users WHERE id=?').get(userId) as any; res.status(201).json({ user:{...userPublic(saved),email:saved.email} });
}));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req,res) => {
  const parsed = z.object({ login:z.string().min(1).max(254), password:z.string().min(1).max(128).refine(passwordWithinBcryptLimit,'Password input must be no more than 72 UTF-8 bytes.') }).safeParse(req.body);
  if (!parsed.success) return fail(res,400,'Enter your email or username and password.');
  const row = db.prepare('SELECT * FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)').get(parsed.data.login,parsed.data.login) as any;
  if (!row || !(await bcrypt.compare(parsed.data.password,row.password_hash))) return fail(res,401,'Those sign-in details do not match.');
  createSession(req,res,row.id);
  res.json({ user:{...userPublic(row),email:row.email} });
}));
function createSession(req: Request,res: Response,userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now()+30*24*60*60*1000).toISOString();
  db.prepare('INSERT INTO sessions(id,user_id,token_hash,user_agent,expires_at) VALUES(?,?,?,?,?)')
    .run(id(),userId,sha(token),String(req.headers['user-agent']||'').slice(0,300),expires);
  res.cookie('relay_session',token,{ httpOnly:true, sameSite:cookieSameSite, secure:cookieSecure, path:'/', maxAge:30*24*60*60*1000 });
}
app.post('/api/auth/logout', requireAuth, (req: AuthedRequest,res) => {
  const token = req.cookies?.relay_session;
  if (token) {
    const session = db.prepare('SELECT id FROM sessions WHERE token_hash=? AND user_id=?').get(sha(token), req.user!.id) as any;
    db.prepare('DELETE FROM sessions WHERE token_hash=? AND user_id=?').run(sha(token), req.user!.id);
    if (session) disconnectSessionSockets(session.id);
  }
  res.clearCookie('relay_session',{httpOnly:true,sameSite:cookieSameSite,secure:cookieSecure,path:'/'});
  res.json({ok:true});
});
app.get('/api/auth/me', requireAuth, (req: AuthedRequest,res) => {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as any;
  res.json({user:{...userPublic(row),email:row.email}});
});
app.post('/api/auth/forgot-password', authLimiter, asyncRoute(async (req,res) => {
  const parsed=z.object({email:z.string().email().max(254)}).safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Enter the email address on your Relay account.');
  const apiKey=process.env.RESEND_API_KEY, from=process.env.RELAY_EMAIL_FROM;
  if(!apiKey||!from)return fail(res,503,'Password recovery is not configured yet. The administrator must add RESEND_API_KEY and RELAY_EMAIL_FROM.');
  const user=db.prepare('SELECT id,email FROM users WHERE LOWER(email)=LOWER(?)').get(parsed.data.email) as any;
  if(user){
    const token=crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)')
      .run(id(),user.id,sha(token),new Date(Date.now()+30*60*1000).toISOString());
    const resetUrl=`${(process.env.CLIENT_ORIGIN||origin).replace(/\/$/,'')}/reset-password?token=${encodeURIComponent(token)}`;
    const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[user.email],subject:'Reset your Relay password',html:`<p>We received a request to reset your Relay password.</p><p><a href="${resetUrl}">Choose a new password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`})});
    if(!sent.ok){console.error('Relay password reset email failed:',sent.status,await sent.text());return fail(res,502,'Relay could not send the reset email. Try again later.');}
  }
  res.json({ok:true,message:'If that email belongs to a Relay account, a reset link is on its way.'});
}));
app.post('/api/auth/reset-password', authLimiter, asyncRoute(async (req,res) => {
  const p=z.object({token:z.string().min(20).max(200),password:z.string().min(10).max(128).refine(passwordWithinBcryptLimit,'Password must be no more than 72 UTF-8 bytes.')}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Use a valid reset link and a password of at least 10 characters.');
  const passwordHash=await bcrypt.hash(p.data.password,12);
  const resetResult=db.transaction(()=>{
    const reset=db.prepare('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW() FOR UPDATE').get(sha(p.data.token)) as any;
    if(!reset)return null;
    const revoked=db.prepare('SELECT id FROM sessions WHERE user_id=?').all(reset.user_id) as any[];
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,reset.user_id);
    db.prepare('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=? AND used_at IS NULL').run(reset.id);
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id=? AND id<>?').run(reset.user_id,reset.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);
    return revoked;
  })();
  if(!resetResult)return fail(res,400,'This password reset link is invalid or has expired.');
  resetResult.forEach(session=>disconnectSessionSockets(session.id));
  res.json({ok:true});
}));

app.get('/api/profile/:userId', requireAuth, (req: AuthedRequest,res) => {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId) as any;
  if (!row) return fail(res,404,'User not found.');
  const isBlocked = !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(req.user!.id,row.id);
  res.json({user:userPublic(row),isBlocked});
});
app.patch('/api/profile', requireAuth, (req: AuthedRequest,res) => {
  const parsed = z.object({ username:z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/).optional(), bio:z.string().max(300).optional(), status_text:z.string().max(80).optional(), avatar:z.string().max(500).nullable().optional(), banner:z.string().max(500).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res,400,parsed.error.issues[0]?.message||'Invalid profile values.');
  const p=parsed.data;
  if (p.username && db.prepare('SELECT 1 FROM users WHERE LOWER(username)=LOWER(?) AND id<>?').get(p.username,req.user!.id)) return fail(res,409,'That username is already taken.');
  const keys=Object.keys(p) as (keyof typeof p)[];
  if (keys.length) {
    const sets=keys.map(k=>`${k}=?`).join(',');
    try { db.prepare(`UPDATE users SET ${sets} WHERE id=?`).run(...keys.map(k=>p[k]),req.user!.id); }
    catch { return fail(res,400,'The profile could not be saved.'); }
  }
  const row=db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id) as any;
  // This authenticated self-edit response may include the account email. Public
  // profile lookups continue to use userPublic() and never expose email addresses.
  res.json({user:{...userPublic(row),email:row.email}});
});
app.get('/api/sessions', requireAuth, (req: AuthedRequest,res) => {
  res.json({sessions:db.prepare('SELECT id,user_agent,created_at,last_active,expires_at FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(req.user!.id)});
});
app.delete('/api/sessions/:sessionId', requireAuth, (req: AuthedRequest,res) => {
  const session = db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=?').get(req.params.sessionId, req.user!.id) as any;
  if (!session) return fail(res,404,'Session not found.');
  db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(session.id,req.user!.id);
  disconnectSessionSockets(session.id);
  res.json({ok:true});
});
app.put('/api/account/password', requireAuth, asyncRoute(async (req,res) => {
  const p=z.object({currentPassword:z.string().min(1).max(128).refine(passwordWithinBcryptLimit,'Password input must be no more than 72 UTF-8 bytes.'),newPassword:z.string().min(10).max(128).refine(passwordWithinBcryptLimit,'Password must be no more than 72 UTF-8 bytes.')}).safeParse(req.body);
  if(!p.success)return fail(res,400,'New password must be at least 10 characters.');
  const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if(!row || !(await bcrypt.compare(p.data.currentPassword,row.password_hash)))return fail(res,403,'Current password is incorrect.');
  const hash=await bcrypt.hash(p.data.newPassword,12);
  const currentToken=req.cookies?.relay_session;
  const currentTokenHash=currentToken?sha(currentToken):'';
  const revoked=db.transaction(()=>{
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.user!.id);
    // A previously issued reset link must not undo a later password change.
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(req.user!.id);
    const sessions=db.prepare('SELECT id FROM sessions WHERE user_id=? AND token_hash<>?').all(req.user!.id,currentTokenHash) as any[];
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user!.id,currentTokenHash);
    return sessions;
  })();
  revoked.forEach(session=>disconnectSessionSockets(session.id));
  res.json({ok:true});
}));
app.patch('/api/presence', requireAuth, (req: AuthedRequest,res) => {
  const p=z.object({presence:z.enum(['online','idle','dnd','offline']),status_text:z.string().max(80).optional()}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Invalid presence.'); db.prepare('UPDATE users SET presence=?,status_text=COALESCE(?,status_text) WHERE id=?').run(p.data.presence,p.data.status_text??null,req.user!.id); res.json({ok:true});
});
app.get('/api/settings', requireAuth, (req: AuthedRequest,res) => {
  const row=db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user!.id) as any;
  const boost=getBoostSnapshot(req.user!.id);
  const stored=JSON.parse(row?.data||'{}');
  const settings=mergeUserSettings(DEFAULT_USER_SETTINGS,stored);
  const effectiveSettings=normalizeSettingsForEntitlement(settings,boost.active);
  res.json({settings:effectiveSettings,boost});
});
app.put('/api/settings', requireAuth, (req: AuthedRequest,res) => {
  const incoming=userSettingsPatchSchema.safeParse(req.body?.settings);
  if(!incoming.success)return fail(res,400,'One or more settings are invalid. Check the selected values and try again.');
  const boost=getBoostSnapshot(req.user!.id);
  if(!boost.active&&requiresBoostSettings(incoming.data))
    return fail(res,403,'Relay Boost is required for custom themes and advanced appearance controls.');
  const data=db.transaction(()=>{
    // Serialize patches per account across all Relay instances so quick control
    // changes cannot overwrite one another when requests arrive together.
    db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(req.user!.id);
    const current=db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user!.id) as any;
    const previous=JSON.parse(current?.data||'{}');
    const merged=mergeUserSettings(DEFAULT_USER_SETTINGS,previous,incoming.data);
    db.prepare(`INSERT INTO settings(user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`).run(req.user!.id,JSON.stringify(merged),now());
    return merged;
  })();
  res.json({settings:data,boost});
});
app.post('/api/boost/checkout', requireAuth, interactionLimiter, asyncRoute(async (req:AuthedRequest,res) => {
  const boost=getBoostSnapshot(req.user!.id);
  if(boost.active)return fail(res,409,'Relay Boost is already active on this account.');
  const secret=process.env.STRIPE_SECRET_KEY?.trim(),price=process.env.RELAY_BOOST_PRICE_ID?.trim(),webhookSecret=process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if(!secret||!price||!webhookSecret)return fail(res,503,'Relay Boost checkout is not configured yet. The administrator must add Stripe credentials and the Boost price ID.');
  const base=(process.env.RELAY_PUBLIC_URL||process.env.CLIENT_ORIGIN||'').trim().replace(/\/$/,'');
  if(!/^https:\/\//i.test(base))return fail(res,503,'The public HTTPS site URL is not configured for Boost checkout.');
  const account=db.prepare('SELECT email FROM users WHERE id=?').get(req.user!.id) as any;
  const form=new URLSearchParams();form.set('mode','subscription');form.set('line_items[0][price]',price);form.set('line_items[0][quantity]','1');
  form.set('client_reference_id',req.user!.id);form.set('metadata[userId]',req.user!.id);form.set('subscription_data[metadata][userId]',req.user!.id);
  form.set('success_url',base+'/settings/boost?checkout=success');form.set('cancel_url',base+'/settings/boost?checkout=cancelled');form.set('allow_promotion_codes','true');
  if(account?.email)form.set('customer_email',account.email);
  const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||typeof payload.url!=='string'){console.error('Relay Boost checkout request failed:',response.status);return fail(res,502,'Stripe could not start the Boost checkout.');}
  res.json({url:payload.url});
}));
app.post('/api/boost/portal', requireAuth, interactionLimiter, asyncRoute(async (req:AuthedRequest,res) => {
  const secret=process.env.STRIPE_SECRET_KEY?.trim();if(!secret)return fail(res,503,'Relay Boost billing is not configured.');
  const row=db.prepare('SELECT stripe_customer_id FROM user_boosts WHERE user_id=?').get(req.user!.id) as any;
  if(!row?.stripe_customer_id)return fail(res,404,'No Boost billing account is linked to this user.');
  const base=(process.env.RELAY_PUBLIC_URL||process.env.CLIENT_ORIGIN||'').trim().replace(/\/$/,'');
  if(!/^https:\/\//i.test(base))return fail(res,503,'The public HTTPS site URL is not configured for billing.');
  const form=new URLSearchParams({customer:row.stripe_customer_id,return_url:base+'/settings/boost'});
  const response=await fetch('https://api.stripe.com/v1/billing_portal/sessions',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||typeof payload.url!=='string'){console.error('Relay Boost billing portal request failed:',response.status);return fail(res,502,'Stripe could not open the billing portal.');}
  res.json({url:payload.url});
}));
app.get('/api/privacy', requireAuth, (req: AuthedRequest,res) => { const row=db.prepare('SELECT dm_privacy,activity_visible FROM users WHERE id=?').get(req.user!.id) as any; res.json({dm_privacy:row.dm_privacy,activity_visible:!!row.activity_visible}); });
app.patch('/api/privacy', requireAuth, asyncRoute(async (req,res) => {
  const parsed=z.object({dm_privacy:z.enum(['everyone','friends','nobody']).optional(),activity_visible:z.boolean().optional()}).safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Invalid privacy setting.');
  const fields=Object.entries(parsed.data);
  if(fields.length)db.prepare(`UPDATE users SET ${fields.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([,v])=>v),req.user!.id);
  if(parsed.data.dm_privacy!==undefined)await refreshDirectMessageRoomAccess(req.user!.id);
  res.json({ok:true});
}));

// Friends, blocks, and DMs
app.get('/api/friends', requireAuth, (req: AuthedRequest,res) => {
  const uid=req.user!.id;
  const rows=db.prepare(`SELECT f.*,u.id AS person_id,u.username,u.avatar,u.presence,u.status_text,u.activity_visible,u.last_seen
    FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id=? OR f.addressee_id=?) ORDER BY f.created_at DESC`).all(uid,uid,uid) as any[];
  res.json({friends:rows.map(r=>({id:r.id,status:r.status,direction:r.requester_id===uid?'outgoing':'incoming',user:userPublic({...r,id:r.person_id})}))});
});
app.post('/api/friends/request', requireAuth, interactionLimiter, (req: AuthedRequest,res) => {
  const parsed=z.object({username:z.string().min(3).max(24)}).safeParse(req.body); if(!parsed.success)return fail(res,400,'Enter a username.');
  const target=db.prepare('SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)').get(parsed.data.username) as any;
  if(!target)return fail(res,404,'No user has that username.'); if(target.id===req.user!.id)return fail(res,400,'You cannot add yourself.');
  if(blockedEither(req.user!.id,target.id))return fail(res,403,'A block prevents this request.');
  const existing=db.prepare('SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)').get(req.user!.id,target.id,target.id,req.user!.id) as any;
  if(existing){ if(existing.status==='accepted')return fail(res,409,'You are already friends.'); if(existing.status==='pending')return fail(res,409,'A request already exists.'); db.prepare('DELETE FROM friendships WHERE id=?').run(existing.id); }
  const fid=id(); db.prepare('INSERT INTO friendships(id,requester_id,addressee_id,status) VALUES(?,?,?,?)').run(fid,req.user!.id,target.id,'pending');
  notify(target.id,'friend_request','New friend request',`${req.user!.username} sent you a friend request.`,`/friends`);
  emitFriendUpdate(req.user!.id,target.id);
  res.status(201).json({ok:true,id:fid});
});
app.post('/api/friends/:friendshipId/accept', requireAuth, (req: AuthedRequest,res) => {
  const f=db.prepare('SELECT * FROM friendships WHERE id=? AND addressee_id=? AND status=\'pending\'').get(req.params.friendshipId,req.user!.id) as any;
  if(!f)return fail(res,404,'Incoming request not found.'); db.prepare('UPDATE friendships SET status=\'accepted\' WHERE id=?').run(f.id);
  notify(f.requester_id,'friend_accepted','Friend request accepted',`${req.user!.username} accepted your request.`,`/friends`);
  emitFriendUpdate(f.requester_id,f.addressee_id);
  res.json({ok:true});
});
app.delete('/api/friends/:friendshipId', requireAuth, asyncRoute(async (req,res) => {
  const friendship=db.prepare('SELECT requester_id,addressee_id FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)').get(req.params.friendshipId,req.user!.id,req.user!.id) as any;
  if(!friendship)return fail(res,404,'Friend request or friendship not found.');
  db.prepare('DELETE FROM friendships WHERE id=?').run(req.params.friendshipId);
  await Promise.all([friendship.requester_id,friendship.addressee_id].map(refreshDirectMessageRoomAccess));
  emitFriendUpdate(friendship.requester_id,friendship.addressee_id);
  res.json({ok:true});
}));
app.get('/api/blocks', requireAuth, (req: AuthedRequest,res) => {
  const rows=db.prepare('SELECT b.blocked_id,u.username,u.avatar FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=?').all(req.user!.id) as any[];
  res.json({blocks:rows.map(r=>({id:r.blocked_id,username:r.username,avatar:r.avatar}))});
});
app.post('/api/blocks/:userId', requireAuth, asyncRoute(async (req,res) => {
  if(req.params.userId===req.user!.id)return fail(res,400,'You cannot block yourself.');
  if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.params.userId))return fail(res,404,'User not found.');
  db.prepare('INSERT INTO blocks(blocker_id,blocked_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(req.user!.id,req.params.userId);
  db.prepare('DELETE FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)').run(req.user!.id,req.params.userId,req.params.userId,req.user!.id);
  await revokeDirectMessagesBetween(req.user!.id,req.params.userId);
  emitFriendUpdate(req.user!.id,req.params.userId);
  res.json({ok:true});
}));
app.delete('/api/blocks/:userId', requireAuth, asyncRoute(async (req,res) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(req.user!.id,req.params.userId);
  await Promise.all([req.user!.id,req.params.userId].map(refreshDirectMessageRoomAccess));
  res.json({ok:true});
}));

function canMessageDmPeer(senderId: string, recipientId: string) {
  const recipient=db.prepare('SELECT dm_privacy FROM users WHERE id=?').get(recipientId) as any;
  if(!recipient)return false;
  const areFriends=!!db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND
    ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(senderId,recipientId,recipientId,senderId);
  return canDirectMessagePeerByPolicy(recipient.dm_privacy,areFriends,blockedEither(senderId,recipientId));
}
function canAccessDm(dmId: string,userId: string) {
  if (!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(dmId,userId)) return false;
  const conversation=db.prepare('SELECT is_group FROM dms WHERE id=?').get(dmId) as any;
  if (conversation?.is_group) return true;
  const peers=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(dmId,userId) as any[];
  return peers.length===1 && peers.every(peer=>canMessageDmPeer(userId,peer.user_id));
}
function dmSummary(dmId: string,userId: string) {
  const row=db.prepare(`SELECT d.*, (SELECT content FROM messages m WHERE m.dm_id=d.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,
    (SELECT created_at FROM messages m WHERE m.dm_id=d.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message_at,
    (SELECT COUNT(*) FROM messages unread WHERE unread.dm_id=d.id AND unread.sender_id<>? AND unread.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=unread.id AND mr.user_id=?)) AS unread_count
    FROM dms d JOIN dm_members me ON me.dm_id=d.id WHERE d.id=? AND me.user_id=?`).get(userId,userId,dmId,userId) as any;
  if(!row)return null;
  if(!canAccessDm(dmId,userId))return null;
  const members=db.prepare(`SELECT u.id,u.username,u.avatar,CASE WHEN u.activity_visible=0 THEN 'offline' WHEN CAST(u.last_seen AS timestamptz)<NOW()-INTERVAL '2 minutes' THEN 'offline' WHEN CAST(u.last_seen AS timestamptz)<NOW()-INTERVAL '60 seconds' AND u.presence='online' THEN 'idle' ELSE u.presence END AS presence FROM dm_members m JOIN users u ON u.id=m.user_id WHERE m.dm_id=?`).all(dmId);
  return {...row,members};
}
app.get('/api/dms', requireAuth, (req: AuthedRequest,res) => {
  const rows=db.prepare('SELECT dm_id FROM dm_members WHERE user_id=?').all(req.user!.id) as any[];
  res.json({conversations:rows.map(r=>dmSummary(r.dm_id,req.user!.id)).filter(Boolean)});
});
app.post('/api/dms', requireAuth, interactionLimiter, (req: AuthedRequest,res) => {
  const parsed=z.object({userIds:z.array(z.string()).min(1).max(20),name:z.string().max(60).optional()}).safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Select at least one other person.');
  const members=[...new Set([req.user!.id,...parsed.data.userIds])];
  if(members.length<2)return fail(res,400,'A conversation needs at least two members.');
  for(const uid of members.slice(1)){ if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))return fail(res,404,'One selected user was not found.'); if(!canMessageDmPeer(req.user!.id,uid))return fail(res,403,'A block or privacy setting prevents this conversation.');
  }
  if(members.length===2){
    const existing=db.prepare(`SELECT d.id FROM dms d WHERE d.is_group=0 AND EXISTS(SELECT 1 FROM dm_members a WHERE a.dm_id=d.id AND a.user_id=?) AND EXISTS(SELECT 1 FROM dm_members b WHERE b.dm_id=d.id AND b.user_id=?) AND (SELECT COUNT(*) FROM dm_members c WHERE c.dm_id=d.id)=2`).get(members[0],members[1]) as any;
    if(existing)return res.json({conversation:dmSummary(existing.id,req.user!.id)});
  }
  const dmId=id(); const tx=db.transaction(()=>{db.prepare('INSERT INTO dms(id,name,is_group,created_by) VALUES(?,?,?,?)').run(dmId,parsed.data.name||null,members.length>2?1:0,req.user!.id); const stmt=db.prepare('INSERT INTO dm_members(dm_id,user_id) VALUES(?,?)'); members.forEach(uid=>stmt.run(dmId,uid));}); tx();
  members.slice(1).forEach(uid=>notify(uid,'dm','New conversation',`${req.user!.username} started a conversation.`,`/channels/@me/${dmId}`));
  res.status(201).json({conversation:dmSummary(dmId,req.user!.id)});
});
app.patch('/api/dms/:dmId', requireAuth, (req: AuthedRequest,res) => {
  if(!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(req.params.dmId,req.user!.id))return fail(res,404,'Conversation not found.');
  const dm=db.prepare('SELECT created_by,is_group FROM dms WHERE id=?').get(req.params.dmId) as any;
  if(!dm?.is_group)return fail(res,400,'Only group conversations can be renamed.');
  if(dm.created_by!==req.user!.id)return fail(res,403,'Only the group creator can rename this conversation.');
  const parsed=z.object({name:z.string().trim().min(1).max(60)}).safeParse(req.body); if(!parsed.success)return fail(res,400,'Group name must be between 1 and 60 characters.');
  db.prepare('UPDATE dms SET name=? WHERE id=?').run(parsed.data.name,req.params.dmId); res.json({conversation:dmSummary(req.params.dmId,req.user!.id)});
});
app.post('/api/dms/:dmId/members', requireAuth, interactionLimiter, (req: AuthedRequest,res) => {
  if(!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(req.params.dmId,req.user!.id))return fail(res,404,'Conversation not found.');
  const dm=db.prepare('SELECT is_group FROM dms WHERE id=?').get(req.params.dmId) as any; if(!dm?.is_group)return fail(res,400,'Members can only be added to a group conversation.');
  const parsed=z.object({userId:z.string()}).safeParse(req.body); if(!parsed.success)return fail(res,400,'Choose a user.');
  if(parsed.data.userId===req.user!.id)return fail(res,400,'You are already in this conversation.');
  const targetExists=db.prepare('SELECT id FROM users WHERE id=?').get(parsed.data.userId); if(!targetExists)return fail(res,404,'User not found.');
  if(!canMessageDmPeer(req.user!.id,parsed.data.userId))return fail(res,403,'A block or privacy setting prevents adding this user.');
  const added=db.transaction(()=>{
    db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(`group-members:${req.params.dmId}`);
    const alreadyMember=!!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(req.params.dmId,parsed.data.userId);
    const memberCount=Number((db.prepare('SELECT COUNT(*) AS count FROM dm_members WHERE dm_id=?').get(req.params.dmId) as any)?.count||0);
    if(!alreadyMember&&memberCount>=21)return false;
    db.prepare('INSERT INTO dm_members(dm_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(req.params.dmId,parsed.data.userId);
    return true;
  })();
  if(!added)return fail(res,409,'This group has reached the 21-member limit.');
  res.json({conversation:dmSummary(req.params.dmId,req.user!.id)});
});
app.delete('/api/dms/:dmId/members/:userId', requireAuth, asyncRoute(async (req,res) => {
  if(!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(req.params.dmId,req.user!.id))return fail(res,404,'Conversation not found.');
  const dm=db.prepare('SELECT created_by,is_group FROM dms WHERE id=?').get(req.params.dmId) as any; if(!dm)return fail(res,404,'Conversation not found.'); if(req.params.userId!==req.user!.id && (!dm.is_group || dm.created_by!==req.user!.id))return fail(res,403,'Only the group creator can remove another member.');
  if(req.params.userId===dm.created_by && req.params.userId===req.user!.id){
    const successor=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>? ORDER BY joined_at ASC,user_id ASC LIMIT 1').get(req.params.dmId,req.params.userId) as any;
    if(successor)db.prepare('UPDATE dms SET created_by=? WHERE id=?').run(successor.user_id,req.params.dmId);
  }
  const removed=db.prepare('DELETE FROM dm_members WHERE dm_id=? AND user_id=?').run(req.params.dmId,req.params.userId);
  if(removed.changes)await revokeDmMemberRoom(req.params.dmId,req.params.userId);
  res.json({ok:true});
}));

// Servers, roles, channels, and moderation
app.get('/api/servers', requireAuth, (req: AuthedRequest,res) => {
  const servers=db.prepare(`SELECT s.*,m.role_id,r.name AS role_name FROM memberships m JOIN servers s ON s.id=m.server_id LEFT JOIN roles r ON r.id=m.role_id WHERE m.user_id=? ORDER BY s.name`).all(req.user!.id);
  res.json({servers});
});
app.get('/api/discover', requireAuth, (req: AuthedRequest,res) => {
  const q=String(req.query.q||'').slice(0,60);
  const sort=String(req.query.sort||'popular');
  const orderBy=sort==='newest'?'CAST(s.created_at AS timestamptz) DESC':sort==='active'?"COALESCE((SELECT MAX(CAST(msg.created_at AS timestamptz)) FROM messages msg JOIN channels ch ON ch.id=msg.channel_id WHERE ch.server_id=s.id),CAST(s.created_at AS timestamptz)) DESC":'member_count DESC, CAST(s.created_at AS timestamptz) DESC';
  const servers=db.prepare(`SELECT s.id,s.name,s.description,s.icon,s.created_at,
      (SELECT COUNT(*) FROM memberships m WHERE m.server_id=s.id) member_count,
      COALESCE((SELECT MAX(CAST(msg.created_at AS timestamptz)) FROM messages msg JOIN channels ch ON ch.id=msg.channel_id WHERE ch.server_id=s.id),CAST(s.created_at AS timestamptz)) last_active_at
    FROM servers s WHERE s.is_discoverable=1 AND (s.name ILIKE ? OR s.description ILIKE ?) ORDER BY ${orderBy} LIMIT 40`).all(`%${q}%`,`%${q}%`);
  res.json({servers});
});
app.get('/api/discover/:serverId', requireAuth, (req:AuthedRequest,res) => {
  const preview=db.prepare(`SELECT s.id,s.name,s.description,s.icon,s.created_at,
    (SELECT COUNT(*) FROM memberships m WHERE m.server_id=s.id) member_count,
    (SELECT COUNT(*) FROM channels c WHERE c.server_id=s.id AND c.type<>'voice') channel_count
    FROM servers s WHERE s.id=? AND s.is_discoverable=1`).get(req.params.serverId) as any;
  if(!preview)return fail(res,404,'Public community not found.');
  res.json({community:preview});
});
app.post('/api/servers', requireAuth, (req: AuthedRequest,res) => {
  const parsed=z.object({name:z.string().trim().min(2).max(80),description:z.string().max(300).optional()}).safeParse(req.body);
  if(!parsed.success)return fail(res,400,parsed.error.issues[0]?.message||'Invalid server details.');
  const sid=id(), admin=id(), member=id(), cat=id(), chan=id();
  const tx=db.transaction(()=>{
    db.prepare('INSERT INTO servers(id,name,description,owner_id) VALUES(?,?,?,?)').run(sid,parsed.data.name,parsed.data.description||'',req.user!.id);
    db.prepare('INSERT INTO roles(id,server_id,name,permissions,position,is_system) VALUES(?,?,?,?,?,1)').run(admin,sid,'Admin',JSON.stringify([...PERMISSIONS]),100);
    db.prepare('INSERT INTO roles(id,server_id,name,permissions,position,is_system) VALUES(?,?,?,?,?,1)').run(member,sid,'Member',JSON.stringify(['view_channels','send_messages']),0);
    db.prepare('INSERT INTO memberships(id,server_id,user_id,role_id) VALUES(?,?,?,?)').run(id(),sid,req.user!.id,admin);
    db.prepare('INSERT INTO categories(id,server_id,name,position) VALUES(?,?,?,0)').run(cat,sid,'TEXT CHANNELS');
    db.prepare('INSERT INTO channels(id,server_id,category_id,name,type,position) VALUES(?,?,?,?,?,0)').run(chan,sid,cat,'general','text');
  }); tx(); res.status(201).json({server:db.prepare('SELECT * FROM servers WHERE id=?').get(sid),channelId:chan});
});
app.post('/api/servers/:serverId/join', requireAuth, (req: AuthedRequest,res) => {
  const s=db.prepare('SELECT id FROM servers WHERE id=? AND is_discoverable=1').get(req.params.serverId) as any;
  if(!s)return fail(res,404,'Public server not found.');
  if(db.prepare('SELECT 1 FROM bans WHERE server_id=? AND user_id=?').get(s.id,req.user!.id))return fail(res,403,'You are banned from this server.');
  const role=db.prepare('SELECT id FROM roles WHERE server_id=? ORDER BY position ASC LIMIT 1').get(s.id) as any;
  db.prepare('INSERT INTO memberships(id,server_id,user_id,role_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(id(),s.id,req.user!.id,role?.id||null);
  res.json({ok:true,serverId:s.id});
});
app.get('/api/servers/:serverId', requireAuth, (req: AuthedRequest,res) => {
  const s=db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!s)return fail(res,404,'Server not found.'); const m=membership(s.id,req.user!.id); if(!m)return fail(res,403,'You are not a member of this server.');
  const canViewChannels=hasPermission(s.id,req.user!.id,'view_channels');
  const categories=canViewChannels?db.prepare('SELECT * FROM categories WHERE server_id=? ORDER BY position').all(s.id):[];
  const channels=canViewChannels?db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position').all(s.id):[];
  const members=db.prepare(`SELECT u.id,u.username,u.avatar,CASE WHEN u.activity_visible=0 THEN 'offline' WHEN CAST(u.last_seen AS timestamptz)<NOW()-INTERVAL '2 minutes' THEN 'offline' WHEN u.presence='online' AND CAST(u.last_seen AS timestamptz)<NOW()-INTERVAL '60 seconds' THEN 'idle' ELSE u.presence END AS presence,CASE WHEN u.activity_visible=0 THEN '' ELSE u.status_text END AS status_text,r.name AS role_name,m.role_id,m.timeout_until FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN roles r ON r.id=m.role_id WHERE m.server_id=? ORDER BY u.username`).all(s.id);
  res.json({server:s,member:m,categories,channels,members});
});
app.patch('/api/servers/:serverId', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_server'))return fail(res,403,'You do not have permission to manage this server.');
  const p=z.object({name:z.string().trim().min(2).max(80).optional(),description:z.string().max(300).optional(),icon:z.string().max(500).nullable().optional()}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Invalid server details.'); const fields=Object.entries(p.data); if(fields.length)db.prepare(`UPDATE servers SET ${fields.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([,v])=>v),req.params.serverId);
  res.json({server:db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId)});
});
app.delete('/api/servers/:serverId', requireAuth, asyncRoute(async (req,res) => {
  const s=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!s)return fail(res,404,'Server not found.'); if(s.owner_id!==req.user!.id)return fail(res,403,'Only the server owner can delete this server.');
  const members=db.prepare('SELECT user_id FROM memberships WHERE server_id=?').all(req.params.serverId) as any[];
  const channels=db.prepare('SELECT id,type FROM channels WHERE server_id=?').all(req.params.serverId) as any[];
  const files=db.prepare('SELECT a.storage_name FROM attachments a JOIN messages m ON m.id=a.message_id JOIN channels c ON c.id=m.channel_id WHERE c.server_id=?').all(req.params.serverId) as any[];
  await Promise.all(members.map(member=>revokeServerMemberRooms(member.user_id,channels)));
  await deleteStoredObjects(files.map((file:any)=>file.storage_name));
  db.prepare('DELETE FROM servers WHERE id=?').run(req.params.serverId);
  res.json({ok:true});
}));
app.post('/api/servers/:serverId/leave', requireAuth, asyncRoute(async (req,res) => {
  const s=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!s)return fail(res,404,'Server not found.'); if(s.owner_id===req.user!.id)return fail(res,400,'Transfer ownership before leaving as the owner.');
  const channels=db.prepare('SELECT id,type FROM channels WHERE server_id=?').all(req.params.serverId) as any[];
  db.prepare('DELETE FROM memberships WHERE server_id=? AND user_id=?').run(req.params.serverId,req.user!.id);
  await revokeServerMemberRooms(req.user!.id,channels);
  res.json({ok:true});
}));
app.post('/api/servers/:serverId/channels', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_channels'))return fail(res,403,'You do not have permission to manage channels.');
  const p=z.object({name:z.string().trim().min(1).max(80).regex(/^[\w-]+$/),type:z.enum(['text','voice','announcement']).default('text'),topic:z.string().max(200).optional(),category_id:z.string().nullable().optional()}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Invalid channel details.');
  if(p.data.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=? AND server_id=?').get(p.data.category_id,req.params.serverId))return fail(res,400,'That category does not belong to this server.');
  const cid=id(); db.prepare('INSERT INTO channels(id,server_id,category_id,name,type,topic,position) VALUES(?,?,?,?,?,?,?)').run(cid,req.params.serverId,p.data.category_id||null,p.data.name,p.data.type,p.data.topic||'',Date.now());
  res.status(201).json({channel:db.prepare('SELECT * FROM channels WHERE id=?').get(cid)});
});
app.patch('/api/channels/:channelId', requireAuth, (req: AuthedRequest,res) => {
  const c=db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.channelId) as any; if(!c)return fail(res,404,'Channel not found.');
  if(!hasPermission(c.server_id,req.user!.id,'manage_channels'))return fail(res,403,'You do not have permission to manage channels.');
  const p=z.object({name:z.string().trim().min(1).max(80).optional(),topic:z.string().max(200).optional(),slow_mode:z.number().int().min(0).max(21600).optional(),category_id:z.string().nullable().optional(),position:z.number().int().optional()}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Invalid channel settings.');
  if(p.data.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=? AND server_id=?').get(p.data.category_id,c.server_id))return fail(res,400,'That category does not belong to this server.');
  const fields=Object.entries(p.data); if(fields.length)db.prepare(`UPDATE channels SET ${fields.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([,v])=>v),c.id);
  res.json({channel:db.prepare('SELECT * FROM channels WHERE id=?').get(c.id)});
});
app.delete('/api/channels/:channelId', requireAuth, asyncRoute(async (req,res) => {
  const c=db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.channelId) as any; if(!c)return fail(res,404,'Channel not found.');
  if(!hasPermission(c.server_id,req.user!.id,'manage_channels'))return fail(res,403,'You do not have permission to manage channels.');
  const files=db.prepare('SELECT a.storage_name FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.channel_id=?').all(c.id) as any[];
  await revokeChannelRooms({id:c.id,type:c.type});
  await deleteStoredObjects(files.map((file:any)=>file.storage_name));
  db.prepare('DELETE FROM channels WHERE id=?').run(c.id);
  res.json({ok:true});
}));
app.post('/api/servers/:serverId/categories', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_channels'))return fail(res,403,'You do not have permission.');
  const p=z.object({name:z.string().trim().min(1).max(60)}).safeParse(req.body); if(!p.success)return fail(res,400,'Category name is required.');
  const cid=id(); db.prepare('INSERT INTO categories(id,server_id,name,position) VALUES(?,?,?,?)').run(cid,req.params.serverId,p.data.name,Date.now()); res.status(201).json({category:db.prepare('SELECT * FROM categories WHERE id=?').get(cid)});
});
app.get('/api/servers/:serverId/roles', requireAuth, (req: AuthedRequest,res) => {
  if(!membership(req.params.serverId,req.user!.id))return fail(res,403,'Server membership required.');
  res.json({roles:db.prepare('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC').all(req.params.serverId).map((r:any)=>({...r,permissions:JSON.parse(r.permissions)}))});
});
app.post('/api/servers/:serverId/roles', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_roles'))return fail(res,403,'You do not have permission to manage roles.');
  const p=z.object({name:z.string().trim().min(2).max(40),permissions:z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)}).safeParse(req.body); if(!p.success)return fail(res,400,'Invalid role.');
  const owner=(db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any)?.owner_id===req.user!.id; const actorPerms=JSON.parse((membership(req.params.serverId,req.user!.id)?.permissions)||'[]') as string[]; if(!owner && p.data.permissions.some(x=>!actorPerms.includes(x)))return fail(res,403,'You cannot grant permissions you do not hold.'); const rid=id(); db.prepare('INSERT INTO roles(id,server_id,name,permissions,position) VALUES(?,?,?,?,?)').run(rid,req.params.serverId,p.data.name,JSON.stringify(p.data.permissions),10); res.status(201).json({role:{id:rid,name:p.data.name,permissions:p.data.permissions}});
});
app.patch('/api/servers/:serverId/roles/:roleId', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_roles'))return fail(res,403,'You do not have permission.');
  const p=z.object({name:z.string().trim().min(2).max(40).optional(),permissions:z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional()}).safeParse(req.body); if(!p.success)return fail(res,400,'Invalid role.');
  const role=db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(req.params.roleId,req.params.serverId) as any; if(!role)return fail(res,404,'Role not found.');
  const nextPerms=p.data.permissions||JSON.parse(role.permissions); const actorPerms=JSON.parse((membership(req.params.serverId,req.user!.id)?.permissions)||'[]') as string[]; const serverOwner=(db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any)?.owner_id===req.user!.id; if(!serverOwner && nextPerms.some((x:string)=>!actorPerms.includes(x)))return fail(res,403,'You cannot grant permissions you do not hold.'); if(!serverOwner && role.position>=((membership(req.params.serverId,req.user!.id)?.position)||0))return fail(res,403,'You cannot edit an equal or higher role.');
  const adminRoleCount=(db.prepare("SELECT COUNT(*) AS n FROM roles WHERE server_id=? AND permissions LIKE '%manage_server%'").get(req.params.serverId) as any).n; if(!nextPerms.includes('manage_server') && JSON.parse(role.permissions).includes('manage_server') && !serverOwner && adminRoleCount<=1)return fail(res,400,'Keep at least one administrator role.');
  const permissionsChanged=JSON.stringify(nextPerms)!==JSON.stringify(JSON.parse(role.permissions||'[]'));
  const affected=permissionsChanged?db.prepare('SELECT user_id FROM memberships WHERE server_id=? AND role_id=?').all(req.params.serverId,role.id) as any[]:[];
  db.prepare('UPDATE roles SET name=?,permissions=? WHERE id=?').run(p.data.name||role.name,JSON.stringify(nextPerms),role.id);
  affected.forEach(member=>disconnectUserSockets(member.user_id));
  res.json({ok:true});
});
app.patch('/api/servers/:serverId/members/:userId/role', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_roles'))return fail(res,403,'You do not have permission.');
  const p=z.object({roleId:z.string()}).safeParse(req.body); if(!p.success)return fail(res,400,'Choose a role.');
  const role=db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(p.data.roleId,req.params.serverId) as any;
  if(!role)return fail(res,404,'Role not found.');
  const server=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!server)return fail(res,404,'Server not found.');
  const ownerId=server.owner_id;
  if(ownerId===req.params.userId)return fail(res,400,'The server owner role cannot be changed.');
  const actor=membership(req.params.serverId,req.user!.id);
  const target=membership(req.params.serverId,req.params.userId);
  if(!target)return fail(res,404,'Member not found.');
  const actorPerms=JSON.parse(actor?.permissions||'[]') as string[];
  const targetPerms=JSON.parse(target.permissions||'[]') as string[];
  const assignedPerms=JSON.parse(role.permissions||'[]') as string[];
  if(ownerId!==req.user!.id && assignedPerms.some((permission:string)=>!actorPerms.includes(permission)))return fail(res,403,'You cannot grant permissions you do not hold.');
  if(ownerId!==req.user!.id && role.position>=(actor?.position??0))return fail(res,403,'You cannot assign an equal or higher role.');
  if(ownerId!==req.user!.id && (target.position??0)>=(actor?.position??0))return fail(res,403,'You cannot change the role of an equal or higher member.');
  if(targetPerms.includes('manage_server') && !assignedPerms.includes('manage_server') && (db.prepare('SELECT COUNT(*) AS n FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.server_id=? AND r.permissions LIKE ?').get(req.params.serverId,'%manage_server%') as any).n<=1)return fail(res,400,'Keep at least one administrator.');
  const result=db.prepare('UPDATE memberships SET role_id=? WHERE server_id=? AND user_id=?').run(p.data.roleId,req.params.serverId,req.params.userId);
  if(!result.changes)return fail(res,404,'Member not found.');
  disconnectUserSockets(req.params.userId);
  res.json({ok:true});
});

app.delete('/api/servers/:serverId/members/:userId', requireAuth, asyncRoute(async (req,res) => {
  const action=req.query.action==='ban'?'ban':'kick'; const perm=action==='ban'?'ban_members':'kick_members';
  if(!hasPermission(req.params.serverId,req.user!.id,perm))return fail(res,403,`You do not have permission to ${action} members.`);
  if(req.params.userId===req.user!.id)return fail(res,400,'Use Leave Server to leave.');
  const s=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!s)return fail(res,404,'Server not found.'); if(s.owner_id===req.params.userId)return fail(res,400,'The server owner cannot be removed.');
  const actor=membership(req.params.serverId,req.user!.id); const target=membership(req.params.serverId,req.params.userId); if(!target)return fail(res,404,'Member not found.');
  if(s.owner_id!==req.user!.id && (target.position??0)>=(actor?.position??0))return fail(res,403,'You cannot remove an equal or higher role.');
  if((target.permissions||'').includes('manage_server')){const admins=(db.prepare(`SELECT COUNT(*) AS n FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.server_id=? AND r.permissions LIKE '%manage_server%'`).get(req.params.serverId) as any).n;if(admins<=1)return fail(res,400,'Keep at least one administrator in the server.');}
  const channels=db.prepare('SELECT id,type FROM channels WHERE server_id=?').all(req.params.serverId) as any[];
  if(action==='ban')db.prepare('INSERT INTO bans(server_id,user_id,moderator_id,reason) VALUES(?,?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET moderator_id=EXCLUDED.moderator_id,reason=EXCLUDED.reason').run(req.params.serverId,req.params.userId,req.user!.id,String(req.body?.reason||'').slice(0,200));
  db.prepare('DELETE FROM memberships WHERE server_id=? AND user_id=?').run(req.params.serverId,req.params.userId);
  await revokeServerMemberRooms(req.params.userId,channels);
  res.json({ok:true,action});
}));
app.post('/api/servers/:serverId/members/:userId/timeout', requireAuth, asyncRoute(async (req,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'timeout_members'))return fail(res,403,'You do not have permission to timeout members.');
  if(req.params.userId===req.user!.id)return fail(res,400,'You cannot timeout yourself.');
  const p=z.object({minutes:z.number().int().min(1).max(10080)}).safeParse(req.body); if(!p.success)return fail(res,400,'Timeout must be between 1 minute and 7 days.');
  const ownerId=(db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any)?.owner_id; if(ownerId===req.params.userId)return fail(res,400,'The server owner cannot be timed out.');
  const actor=membership(req.params.serverId,req.user!.id); const target=membership(req.params.serverId,req.params.userId); if(!target)return fail(res,404,'Member not found.'); if(ownerId!==req.user!.id && (target.position??0)>=(actor?.position??0))return fail(res,403,'You cannot timeout an equal or higher role.');
  const until=new Date(Date.now()+p.data.minutes*60000).toISOString(); const r=db.prepare('UPDATE memberships SET timeout_until=? WHERE server_id=? AND user_id=?').run(until,req.params.serverId,req.params.userId); if(!r.changes)return fail(res,404,'Member not found.');
  const channels=db.prepare('SELECT id,type FROM channels WHERE server_id=?').all(req.params.serverId) as any[];
  await revokeServerMemberRooms(req.params.userId,channels,true);
  res.json({ok:true,timeout_until:until});
}));
app.delete('/api/servers/:serverId/members/:userId/timeout', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'timeout_members'))return fail(res,403,'You do not have permission.');
  const server=db.prepare('SELECT owner_id FROM servers WHERE id=?').get(req.params.serverId) as any;
  if(!server)return fail(res,404,'Server not found.');
  const actor=membership(req.params.serverId,req.user!.id);
  const target=membership(req.params.serverId,req.params.userId);
  if(!target)return fail(res,404,'Member not found.');
  if(server.owner_id===req.params.userId)return fail(res,400,'The server owner cannot be timed out.');
  if(server.owner_id!==req.user!.id && (target.position??0)>=(actor?.position??0))return fail(res,403,'You cannot change the timeout of an equal or higher role.');
  db.prepare('UPDATE memberships SET timeout_until=NULL WHERE server_id=? AND user_id=?').run(req.params.serverId,req.params.userId);
  res.json({ok:true});
});
app.get('/api/servers/:serverId/bans', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'ban_members'))return fail(res,403,'You do not have permission.');
  res.json({bans:db.prepare('SELECT b.*,u.username FROM bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=?').all(req.params.serverId)});
});
app.delete('/api/servers/:serverId/bans/:userId', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'ban_members'))return fail(res,403,'You do not have permission.'); db.prepare('DELETE FROM bans WHERE server_id=? AND user_id=?').run(req.params.serverId,req.params.userId); res.json({ok:true});
});

// Invites and server preview
app.post('/api/servers/:serverId/invites', requireAuth, interactionLimiter, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_invites'))return fail(res,403,'You do not have permission to create invites.');
  const p=z.object({expiresHours:z.number().int().min(0).max(8760).default(168),maxUses:z.number().int().min(0).max(10000).default(0)}).safeParse(req.body); if(!p.success)return fail(res,400,'Invalid invite limits.');
  const code=nanoid(10); const expires=p.data.expiresHours?new Date(Date.now()+p.data.expiresHours*3600000).toISOString():null;
  db.prepare('INSERT INTO invites(code,server_id,creator_id,expires_at,max_uses) VALUES(?,?,?,?,?)').run(code,req.params.serverId,req.user!.id,expires,p.data.maxUses||null); res.status(201).json({invite:{code,server_id:req.params.serverId,expires_at:expires,max_uses:p.data.maxUses||null,uses:0,revoked:0,url:`${origin}/invite/${code}`}});
});
app.get('/api/servers/:serverId/invites', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_invites'))return fail(res,403,'You do not have permission.'); res.json({invites:db.prepare('SELECT * FROM invites WHERE server_id=? ORDER BY created_at DESC').all(req.params.serverId)});
});
app.get('/api/invites/:code', requireAuth, (req: AuthedRequest,res) => {
  const row=db.prepare('SELECT i.*,s.name,s.description,s.icon,(SELECT COUNT(*) FROM memberships m WHERE m.server_id=s.id) member_count FROM invites i JOIN servers s ON s.id=i.server_id WHERE i.code=?').get(req.params.code) as any;
  if(!row || row.revoked || (row.expires_at && new Date(row.expires_at).getTime()<Date.now()) || (row.max_uses && row.uses>=row.max_uses))return fail(res,404,'This invite is invalid, expired, or full.');
  res.json({invite:{code:row.code,server:{id:row.server_id,name:row.name,description:row.description,icon:row.icon,member_count:row.member_count},expires_at:row.expires_at,uses:row.uses}});
});
app.post('/api/invites/:code/join', requireAuth, (req: AuthedRequest,res) => {
  const result=db.transaction(()=>{
    const row=db.prepare('SELECT * FROM invites WHERE code=? FOR UPDATE').get(req.params.code) as any;
    if(!row || row.revoked || (row.expires_at && new Date(row.expires_at).getTime()<=Date.now()) || (row.max_uses && row.uses>=row.max_uses))return {error:'invalid'} as const;
    if(db.prepare('SELECT 1 FROM bans WHERE server_id=? AND user_id=?').get(row.server_id,req.user!.id))return {error:'banned'} as const;
    const alreadyMember=!!membership(row.server_id,req.user!.id);
    if(!alreadyMember){
      const claimed=db.prepare('UPDATE invites SET uses=uses+1 WHERE code=? AND revoked=0 AND (max_uses IS NULL OR uses<max_uses) AND (expires_at IS NULL OR expires_at::timestamptz>NOW())').run(row.code);
      if(!claimed.changes)return {error:'invalid'} as const;
      const role=db.prepare('SELECT id FROM roles WHERE server_id=? ORDER BY position ASC LIMIT 1').get(row.server_id) as any;
      db.prepare('INSERT INTO memberships(id,server_id,user_id,role_id) VALUES(?,?,?,?)').run(id(),row.server_id,req.user!.id,role?.id||null);
    }
    return {serverId:row.server_id} as const;
  })();
  if('error' in result)return fail(res,result.error==='banned'?403:404,result.error==='banned'?'You are banned from this server.':'This invite is invalid, expired, or full.');
  res.json({ok:true,serverId:result.serverId});
});
app.delete('/api/invites/:code', requireAuth, (req: AuthedRequest,res) => {
  const row=db.prepare('SELECT server_id FROM invites WHERE code=?').get(req.params.code) as any; if(!row)return fail(res,404,'Invite not found.');
  if(!hasPermission(row.server_id,req.user!.id,'manage_invites'))return fail(res,403,'You do not have permission.'); db.prepare('UPDATE invites SET revoked=1 WHERE code=?').run(req.params.code); res.json({ok:true});
});

// Messages and search
function messageRows(whereSql:string, params:any[], limit=60) {
  return db.prepare(`SELECT m.*,u.username,u.avatar,
    (SELECT COALESCE(json_agg(json_build_object('emoji',r.emoji,'user_id',r.user_id))::text,'[]') FROM reactions r WHERE r.message_id=m.id) reactions,
    (SELECT COALESCE(json_agg(json_build_object('id',a.id,'filename',a.filename,'mime',a.mime,'size',a.size))::text,'[]') FROM attachments a WHERE a.message_id=m.id) attachments,
    (SELECT COALESCE(json_agg(json_build_object('user_id',mr.user_id,'username',reader.username,'read_at',mr.read_at))::text,'[]')
      FROM message_reads mr JOIN users reader ON reader.id=mr.user_id WHERE mr.message_id=m.id) read_by
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE ${whereSql} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
    .all(...params,limit).reverse().map((m:any)=>({
      ...m,
      reactions:JSON.parse(m.reactions||'[]'),
      attachments:JSON.parse(m.attachments||'[]'),
      read_by:JSON.parse(m.read_by||'[]')
    }));
}
function markMessagesRead(messages:any[], userId:string, room:string, username:string) {
  const unread=messages.filter(message=>message.sender_id!==userId && !(message.read_by||[]).some((reader:any)=>reader.user_id===userId));
  if(!unread.length)return;
  const readAt=now();
  const ids=unread.map(message=>message.id);
  const placeholders=ids.map(()=>'?').join(',');
  const inserted=db.prepare(`INSERT INTO message_reads(message_id,user_id,read_at)
    SELECT m.id,?,? FROM messages m WHERE m.id IN (${placeholders})
    ON CONFLICT(message_id,user_id) DO NOTHING RETURNING message_id`).all(userId,readAt,...ids) as Array<{message_id:string}>;
  if(inserted.length)io.to(room).emit('message:read',{userId,username,messageIds:inserted.map(row=>row.message_id),readAt});
}
function markDmConversationRead(dmId:string,userId:string,room:string,username:string) {
  const latestUnread=db.prepare(`SELECT m.id FROM messages m WHERE m.dm_id=? AND m.sender_id<>? AND m.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.user_id=?)
    ORDER BY m.created_at DESC,m.id DESC LIMIT 60`).all(dmId,userId,userId) as Array<{id:string}>;
  if(!latestUnread.length)return;
  const readAt=now();
  db.prepare(`INSERT INTO message_reads(message_id,user_id,read_at)
    SELECT m.id,?,? FROM messages m WHERE m.dm_id=? AND m.sender_id<>? AND m.deleted_at IS NULL
    ON CONFLICT(message_id,user_id) DO NOTHING`).run(userId,readAt,dmId,userId);
  io.to(room).emit('message:read',{userId,username,messageIds:latestUnread.map(message=>message.id),readAt});
}
function sharedAttachments(whereSql:string,params:any[]) {
  return db.prepare(`SELECT a.id,a.filename,a.mime,a.size,m.created_at,u.username
    FROM attachments a JOIN messages m ON m.id=a.message_id JOIN users u ON u.id=m.sender_id
    WHERE ${whereSql} AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT 100`).all(...params);
}
// Message history cursor logic lives in message-history.ts and has focused tests.

app.get('/api/channels/:channelId/messages', requireAuth, (req: AuthedRequest,res) => {
  if(!canReadChannel(req.params.channelId,req.user!.id))return fail(res,403,'Channel membership required.');
  const cursor = createMessageHistoryCursor(req.query.before, req.query.beforeId);
  const where = cursor ? `m.channel_id=? AND m.deleted_at IS NULL AND ${cursor.sql}` : 'm.channel_id=? AND m.deleted_at IS NULL';
  const params = cursor ? [req.params.channelId, ...cursor.params] : [req.params.channelId];
  const messages=messageRows(where,params);
  markMessagesRead(messages,req.user!.id,`channel:${req.params.channelId}`,req.user!.username);
  res.json({messages:messageRows(where,params)});
});
app.get('/api/channels/:channelId/attachments', requireAuth, (req:AuthedRequest,res) => {
  if(!canReadChannel(req.params.channelId,req.user!.id))return fail(res,403,'Channel membership required.');
  res.json({attachments:sharedAttachments('m.channel_id=?',[req.params.channelId])});
});
app.get('/api/dms/:dmId/attachments', requireAuth, (req:AuthedRequest,res) => {
  if(!canAccessDm(req.params.dmId,req.user!.id))return fail(res,403,'Conversation access is unavailable.');
  res.json({attachments:sharedAttachments('m.dm_id=?',[req.params.dmId])});
});
app.get('/api/dms/:dmId/messages', requireAuth, (req: AuthedRequest,res) => {
  if(!canAccessDm(req.params.dmId,req.user!.id))return fail(res,403,'Conversation access is unavailable.');
  const cursor = createMessageHistoryCursor(req.query.before, req.query.beforeId);
  const where = cursor ? `m.dm_id=? AND m.deleted_at IS NULL AND ${cursor.sql}` : 'm.dm_id=? AND m.deleted_at IS NULL';
  const params = cursor ? [req.params.dmId, ...cursor.params] : [req.params.dmId];
  markDmConversationRead(req.params.dmId,req.user!.id,`dm:${req.params.dmId}`,req.user!.username);
  res.json({messages:messageRows(where,params)});
});
app.get('/api/dms/:dmId/messages/search', requireAuth, (req: AuthedRequest,res) => {
  if(!canAccessDm(req.params.dmId,req.user!.id))return fail(res,403,'Conversation access is unavailable.');
  const query=String(req.query.q||'').trim().slice(0,100);
  if(query.length<2)return res.json({messages:[]});
  res.json({messages:messageRows('m.dm_id=? AND m.deleted_at IS NULL AND m.content ILIKE ?', [req.params.dmId, `%${query}%`], 100)});
});
const messageCreateSchema=z.object({content:z.string().max(4000).default(''),reply_to:z.string().optional(),uploadIds:z.array(z.string()).max(8).optional()}).refine(v=>v.content.trim().length>0 || !!v.uploadIds?.length,{message:'Write a message or attach a file.'});
function createMessage(req: AuthedRequest,res: Response,destination:{channelId?:string;dmId?:string}) {
  const p=messageCreateSchema.safeParse(req.body); if(!p.success)return fail(res,400,p.error.issues[0]?.message||'Invalid message.');
  if(destination.channelId){ if(!canReadChannel(destination.channelId,req.user!.id))return fail(res,403,'You cannot send messages in this channel.'); const c=db.prepare('SELECT * FROM channels WHERE id=?').get(destination.channelId) as any;
    if(!hasPermission(c.server_id,req.user!.id,'send_messages'))return fail(res,403,'You do not have permission to send messages.'); const mem=membership(c.server_id,req.user!.id); if(mem?.timeout_until && new Date(mem.timeout_until).getTime()>Date.now())return fail(res,403,'Your server timeout is active.');
  } else {
    if(!canAccessDm(destination.dmId!,req.user!.id))return fail(res,403,'You cannot access this conversation.');
  }
  if(p.data.reply_to){const parent=db.prepare('SELECT channel_id,dm_id FROM messages WHERE id=?').get(p.data.reply_to) as any;if(!parent || parent.channel_id!==(destination.channelId||null) || parent.dm_id!==(destination.dmId||null))return fail(res,400,'The replied-to message is not in this conversation.');}
  const mid=id();
  const created=db.transaction(()=>{
    if(destination.channelId){
      db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(`slow-mode:${destination.channelId}:${req.user!.id}`);
      const channelState=db.prepare('SELECT slow_mode FROM channels WHERE id=?').get(destination.channelId) as any;
      const latest=db.prepare('SELECT created_at FROM messages WHERE channel_id=? AND sender_id=? ORDER BY created_at DESC LIMIT 1').get(destination.channelId,req.user!.id) as any;
      if(channelState?.slow_mode>0&&latest){const remaining=channelState.slow_mode-(Date.now()-new Date(latest.created_at).getTime())/1000;if(remaining>0)return {error:'slow_mode',retryAfter:Math.ceil(remaining)};}
    }
    if(p.data.uploadIds?.length){
      for(const aid of p.data.uploadIds){
        const staged=db.prepare(`SELECT 1 FROM staged_uploads WHERE id=? AND user_id=? AND created_at::timestamptz>NOW()-?::interval`).get(aid,req.user!.id,`${stagedUploadTtlHours} hours`);
        if(!staged)return {error:'upload_expired'};
      }
    }
    db.prepare('INSERT INTO messages(id,channel_id,dm_id,sender_id,content,reply_to) VALUES(?,?,?,?,?,?)').run(mid,destination.channelId||null,destination.dmId||null,req.user!.id,p.data.content,p.data.reply_to||null);
    if(p.data.uploadIds?.length){
      for(const aid of p.data.uploadIds){
        db.prepare('INSERT INTO attachments(id,message_id,filename,mime,size,storage_name) SELECT id,?,filename,mime,size,storage_name FROM staged_uploads WHERE id=? AND user_id=?').run(mid,aid,req.user!.id);
        db.prepare('DELETE FROM staged_uploads WHERE id=? AND user_id=?').run(aid,req.user!.id);
      }
    }
    if(destination.dmId)db.prepare('UPDATE dms SET last_message_at=? WHERE id=?').run(now(),destination.dmId);
    return {ok:true};
  })();
  if('error' in created && created.error==='slow_mode'){res.setHeader('Retry-After',String(created.retryAfter));return fail(res,429,`Slow mode is active. Try again in ${created.retryAfter} seconds.`);}
  if('error' in created && created.error==='upload_expired')return fail(res,403,'One of those uploads has expired or is no longer available. Attach it again.');
  const row=messageRows(`m.id=?`,[mid],1)[0];
  const room=destination.channelId?`channel:${destination.channelId}`:`dm:${destination.dmId}`; io.to(room).emit('message:new',row);
  if(destination.dmId){const users=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(destination.dmId,req.user!.id) as any[]; users.forEach(u=>notify(u.user_id,'dm',`Message from ${req.user!.username}`,p.data.content.slice(0,100),`/channels/@me/${destination.dmId}`));}
  else {const ch=db.prepare('SELECT server_id,name FROM channels WHERE id=?').get(destination.channelId) as any; const mentionIds=[...p.data.content.matchAll(/@\{([a-zA-Z0-9_-]+)\}/g)].map(m=>m[1]); mentionIds.forEach(uid=>{if(shouldNotifyChannelMention(req.user!.id,uid,canReadChannel(destination.channelId!,uid)))notify(uid,'mention',`Mention in #${ch.name}`,p.data.content.slice(0,100),`/channels/${ch.server_id}/${destination.channelId}`);});}
  res.status(201).json({message:row});
}
app.post('/api/channels/:channelId/messages', requireAuth, interactionLimiter, (req: AuthedRequest,res) => createMessage(req,res,{channelId:req.params.channelId}));
app.post('/api/dms/:dmId/messages', requireAuth, interactionLimiter, (req: AuthedRequest,res) => createMessage(req,res,{dmId:req.params.dmId}));
app.patch('/api/messages/:messageId', requireAuth, (req: AuthedRequest,res) => {
  const m=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId) as any; if(!m)return fail(res,404,'Message not found.');
  let canAccess=false; let serverId:string|null=null;
  if(m.channel_id){const channel=db.prepare('SELECT server_id FROM channels WHERE id=?').get(m.channel_id) as any;serverId=channel?.server_id||null;canAccess=!!serverId&&canReadChannel(m.channel_id,req.user!.id);}
  else if(m.dm_id){canAccess=canAccessDm(m.dm_id,req.user!.id);}
  if(!canAccess)return fail(res,403,'Conversation access is required.');
  if(m.sender_id!==req.user!.id && !(serverId && hasPermission(serverId,req.user!.id,'manage_messages')))return fail(res,403,'You can only edit your own messages.');
  const p=z.object({content:z.string().trim().min(1).max(4000)}).safeParse(req.body); if(!p.success)return fail(res,400,'Message must contain 1 to 4000 characters.');
  db.prepare('UPDATE messages SET content=?,edited_at=? WHERE id=?').run(p.data.content,now(),m.id); const row=messageRows('m.id=?',[m.id],1)[0]; io.to(m.channel_id?`channel:${m.channel_id}`:`dm:${m.dm_id}`).emit('message:updated',row); res.json({message:row});
});
app.delete('/api/messages/:messageId', requireAuth, asyncRoute(async (req,res) => {
  const m=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId) as any; if(!m)return fail(res,404,'Message not found.');
  const serverId=m.channel_id?(db.prepare('SELECT server_id FROM channels WHERE id=?').get(m.channel_id) as any)?.server_id:null;
  const canAccess=m.channel_id?canReadChannel(m.channel_id,req.user!.id):canAccessDm(m.dm_id,req.user!.id);
  if(!canAccess)return fail(res,403,'Conversation access is required.');
  if(m.sender_id!==req.user!.id && !(serverId && hasPermission(serverId,req.user!.id,'manage_messages')))return fail(res,403,'You cannot delete this message.');
  const files=db.prepare('SELECT storage_name FROM attachments WHERE message_id=?').all(m.id) as any[];
  await deleteStoredObjects(files.map((file:any)=>file.storage_name));
  db.prepare('DELETE FROM attachments WHERE message_id=?').run(m.id);
  db.prepare('UPDATE messages SET deleted_at=?,content=? WHERE id=?').run(now(),'This message was deleted.',m.id); io.to(m.channel_id?`channel:${m.channel_id}`:`dm:${m.dm_id}`).emit('message:deleted',{id:m.id}); res.json({ok:true});
}));
app.post('/api/messages/:messageId/report', requireAuth, interactionLimiter, (req: AuthedRequest,res) => {
  const m=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId) as any; if(!m)return fail(res,404,'Message not found.');
  if(!m.channel_id)return fail(res,400,'Only server-channel messages can be submitted to a server moderation queue.'); if(!canReadChannel(m.channel_id,req.user!.id))return fail(res,403,'Channel membership required.' );
  const p=z.object({reason:z.string().trim().min(5).max(500)}).safeParse(req.body); if(!p.success)return fail(res,400,'Explain the concern in at least 5 characters.');
  const report = db.prepare('INSERT INTO message_reports(id,message_id,reporter_id,reason) VALUES(?,?,?,?) ON CONFLICT(message_id,reporter_id) DO NOTHING').run(id(),m.id,req.user!.id,p.data.reason);
  if (!report.changes) return fail(res,409,'You have already reported this message.');
  res.status(201).json({ok:true});
});
app.get('/api/servers/:serverId/reports', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_messages'))return fail(res,403,'You do not have permission to view reports.');
  const reports=db.prepare(`SELECT r.*,m.content,m.channel_id,u.username AS reporter,c.name AS channel_name FROM message_reports r JOIN messages m ON m.id=r.message_id JOIN users u ON u.id=r.reporter_id LEFT JOIN channels c ON c.id=m.channel_id WHERE c.server_id=? ORDER BY r.created_at DESC`).all(req.params.serverId); res.json({reports});
});
app.post('/api/reports/:reportId/resolve', requireAuth, (req: AuthedRequest,res) => {
  const report=db.prepare(`SELECT r.id,c.server_id FROM message_reports r JOIN messages m ON m.id=r.message_id JOIN channels c ON c.id=m.channel_id WHERE r.id=?`).get(req.params.reportId) as any; if(!report)return fail(res,404,'Report not found.'); if(!hasPermission(report.server_id,req.user!.id,'manage_messages'))return fail(res,403,'You do not have permission.'); db.prepare("UPDATE message_reports SET status='resolved' WHERE id=?").run(report.id); res.json({ok:true});
});
app.post('/api/messages/:messageId/reactions', requireAuth, (req: AuthedRequest,res) => {
  const m=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId) as any; if(!m)return fail(res,404,'Message not found.');
  if(m.channel_id && !canReadChannel(m.channel_id,req.user!.id))return fail(res,403,'Channel membership required.');
  if(m.channel_id){
    const serverId=(db.prepare('SELECT server_id FROM channels WHERE id=?').get(m.channel_id) as any)?.server_id;
    if(serverId && isTimedOut(serverId,req.user!.id))return fail(res,403,'Your server timeout is active.');
  }
  if(m.dm_id && !canAccessDm(m.dm_id,req.user!.id))return fail(res,403,'Conversation access is unavailable.');
  const p=z.object({emoji:z.string().min(1).max(16)}).safeParse(req.body); if(!p.success)return fail(res,400,'Choose a valid emoji.');
  const found=db.prepare('SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(m.id,req.user!.id,p.data.emoji) as any;
  if(found)db.prepare('DELETE FROM reactions WHERE id=?').run(found.id); else db.prepare('INSERT INTO reactions(id,message_id,user_id,emoji) VALUES(?,?,?,?)').run(id(),m.id,req.user!.id,p.data.emoji);
  const reactions=db.prepare('SELECT emoji,user_id FROM reactions WHERE message_id=?').all(m.id); io.to(m.channel_id?`channel:${m.channel_id}`:`dm:${m.dm_id}`).emit('message:reactions',{messageId:m.id,reactions}); res.json({reactions});
});
app.post('/api/messages/:messageId/pin', requireAuth, (req: AuthedRequest,res) => {
  const m=db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId) as any; if(!m || !m.channel_id)return fail(res,404,'Channel message not found.');
  const serverId=(db.prepare('SELECT server_id FROM channels WHERE id=?').get(m.channel_id) as any).server_id;
  if(!canReadChannel(m.channel_id,req.user!.id))return fail(res,403,'Channel membership required.');
  if(!hasPermission(serverId,req.user!.id,'pin_messages'))return fail(res,403,'You do not have permission to pin messages.');
  db.prepare('UPDATE messages SET pinned=CASE pinned WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(m.id);
  const updated=messageRows('m.id=?',[m.id],1)[0];
  io.to(`channel:${m.channel_id}`).emit('message:updated',updated);
  res.json({pinned:!!updated.pinned});
});
app.get('/api/search', requireAuth, (req: AuthedRequest,res) => {
  const q=String(req.query.q||'').trim().slice(0,100); if(q.length<2)return res.json({users:[],servers:[],messages:[]}); const like=`%${q}%`;
  const users=(db.prepare('SELECT id,username,avatar,presence,status_text,activity_visible,created_at FROM users WHERE username LIKE ? AND id<>? LIMIT 10').all(like,req.user!.id) as any[]).map(userPublic);
  const servers=db.prepare(`SELECT DISTINCT s.id,s.name,s.description FROM servers s JOIN memberships m ON m.server_id=s.id WHERE m.user_id=? AND s.name LIKE ? LIMIT 10`).all(req.user!.id,like);
  const candidates=db.prepare(`SELECT m.id,m.content,m.created_at,m.channel_id,m.dm_id,c.server_id,u.username,d.is_group FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN channels c ON c.id=m.channel_id LEFT JOIN dms d ON d.id=m.dm_id
    WHERE m.content LIKE ? AND m.deleted_at IS NULL AND ((m.channel_id IN (SELECT c.id FROM channels c JOIN memberships x ON x.server_id=c.server_id WHERE x.user_id=?)) OR (m.dm_id IN (SELECT dm_id FROM dm_members WHERE user_id=?))) ORDER BY m.created_at DESC LIMIT 100`).all(like,req.user!.id,req.user!.id) as any[];
  const messages=candidates.filter(message=>{
    if(message.channel_id)return canReadChannel(message.channel_id,req.user!.id);
    if(message.is_group)return true;
    return canAccessDm(message.dm_id,req.user!.id);
  }).slice(0,20);
  res.json({users,servers,messages});
});

// Notifications, events, help, and local uploads
app.get('/api/notifications', requireAuth, (req: AuthedRequest,res) => res.json({notifications:db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user!.id)}));
app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest,res) => {db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(),req.user!.id);res.json({ok:true});});
app.post('/api/notifications/:notificationId/read', requireAuth, (req: AuthedRequest,res) => {db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(),req.params.notificationId,req.user!.id);res.json({ok:true});});
app.get('/api/events', requireAuth, (req: AuthedRequest,res) => {
  const rows=db.prepare(`SELECT e.*,s.name AS server_name,(SELECT status FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp,(SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id AND r.status='going') AS going_count FROM events e JOIN servers s ON s.id=e.server_id JOIN memberships m ON m.server_id=s.id AND m.user_id=? WHERE e.starts_at::timestamptz>=NOW() ORDER BY e.starts_at`).all(req.user!.id,req.user!.id);
  res.json({events:rows});
});
app.post('/api/servers/:serverId/events', requireAuth, (req: AuthedRequest,res) => {
  if(!hasPermission(req.params.serverId,req.user!.id,'manage_server'))return fail(res,403,'You do not have permission to create events.');
  const p=z.object({title:z.string().trim().min(2).max(100),description:z.string().max(1000).optional(),starts_at:z.string().datetime(),location:z.string().max(120).optional()}).safeParse(req.body); if(!p.success)return fail(res,400,'Enter a title and valid event date.');
  const eid=id(); db.prepare('INSERT INTO events(id,server_id,creator_id,title,description,starts_at,location) VALUES(?,?,?,?,?,?,?)').run(eid,req.params.serverId,req.user!.id,p.data.title,p.data.description||'',p.data.starts_at,p.data.location||''); res.status(201).json({event:db.prepare('SELECT * FROM events WHERE id=?').get(eid)});
});
app.patch('/api/events/:eventId', requireAuth, (req: AuthedRequest,res) => {
  const event=db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId) as any; if(!event)return fail(res,404,'Event not found.'); if(event.creator_id!==req.user!.id && !hasPermission(event.server_id,req.user!.id,'manage_server'))return fail(res,403,'Only the creator or a server manager can edit this event.');
  const p=z.object({title:z.string().trim().min(2).max(100).optional(),description:z.string().max(1000).optional(),starts_at:z.string().datetime().optional(),location:z.string().max(120).optional()}).safeParse(req.body); if(!p.success)return fail(res,400,'Invalid event details.'); const fields=Object.entries(p.data); if(fields.length)db.prepare(`UPDATE events SET ${fields.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([,v])=>v),event.id); res.json({ok:true});
});
app.delete('/api/events/:eventId', requireAuth, (req: AuthedRequest,res) => {
  const event=db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId) as any; if(!event)return fail(res,404,'Event not found.'); if(event.creator_id!==req.user!.id && !hasPermission(event.server_id,req.user!.id,'manage_server'))return fail(res,403,'Only the creator or a server manager can cancel this event.'); db.prepare('DELETE FROM events WHERE id=?').run(event.id); res.json({ok:true});
});
app.post('/api/events/:eventId/rsvp', requireAuth, (req: AuthedRequest,res) => {
  const event=db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId) as any; if(!event || !membership(event.server_id,req.user!.id))return fail(res,404,'Event not found.');
  const p=z.object({status:z.enum(['going','interested'])}).safeParse(req.body); if(!p.success)return fail(res,400,'Choose an RSVP status.'); db.prepare('INSERT INTO event_rsvps(event_id,user_id,status) VALUES(?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status').run(event.id,req.user!.id,p.data.status); res.json({ok:true});
});
app.delete('/api/events/:eventId/rsvp', requireAuth, (req: AuthedRequest,res) => {db.prepare('DELETE FROM event_rsvps WHERE event_id=? AND user_id=?').run(req.params.eventId,req.user!.id);res.json({ok:true});});

// staged_uploads is intentionally private and only finalized when an authenticated message sends it.
 // staged_uploads is created by the versioned PostgreSQL migration in db.ts.
const allowedMime = new Set(['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','application/zip','audio/mpeg','audio/ogg','video/mp4']);
async function cleanupExpiredStagedUploads() {
  const expired=db.prepare("SELECT id,storage_name FROM staged_uploads WHERE created_at::timestamptz<=NOW()+?::interval").all(`-${stagedUploadTtlHours} hours`) as any[];
  for(const row of expired){
    const storageName=String(row.storage_name||'');
    try {
      if(storageName && path.basename(storageName)===storageName)await deleteUpload(storageName);
      db.prepare('DELETE FROM staged_uploads WHERE id=?').run(row.id);
    } catch(error) {
      console.error('Expired upload cleanup failed; the staged record will be retried.',error);
    }
  }
}
function userStoredUploadBytes(userId:string) {
  const staged=db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM staged_uploads WHERE user_id=?').get(userId) as any;
  const attached=db.prepare('SELECT COALESCE(SUM(a.size),0) AS bytes FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.sender_id=?').get(userId) as any;
  return Number(staged?.bytes||0)+Number(attached?.bytes||0);
}
void cleanupExpiredStagedUploads().catch(error=>console.error('Staged upload cleanup failed.',error));
const stagedUploadCleanupTimer=setInterval(()=>{void cleanupExpiredStagedUploads().catch(error=>console.error('Staged upload cleanup failed.',error));},60*60*1000);
stagedUploadCleanupTimer.unref();
const rateLimitCleanupTimer=setInterval(()=>{void realtimePool.query("DELETE FROM api_rate_limits WHERE expires_at < NOW() - INTERVAL '1 hour'").catch(error=>console.error('Rate limit cleanup failed.',error));},15*60*1000);
rateLimitCleanupTimer.unref();
const shutdownRelay=()=>{
  clearInterval(stagedUploadCleanupTimer);
  clearInterval(rateLimitCleanupTimer);
  io.close(()=>{
    void realtimePool.end().catch(error=>console.error('Relay realtime pool shutdown failed:',error));
  });
};
process.once('SIGTERM',shutdownRelay);
process.once('SIGINT',shutdownRelay);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:maxUpload,files:8},fileFilter:(_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();const ok=allowedMime.has(file.mimetype)&&!['.exe','.bat','.cmd','.js','.html','.svg','.sh','.ps1'].includes(ext);const finish=cb as ((error: Error)=>void)&((error: null,acceptFile: boolean)=>void);if(ok)finish(null,true);else finish(new Error('This file type is not allowed.'));}});
const requirePersistentUploadStorage = (_req:Request,res:Response,next:NextFunction) =>
  isProd && !persistentStorageEnabled
    ? fail(res,503,'File uploads are temporarily unavailable because persistent object storage is not configured.')
    : next();
app.post('/api/uploads', requireAuth, interactionLimiter, requirePersistentUploadStorage, upload.array('files',8), asyncRoute(async (req:AuthedRequest,res) => {
  const files=(req.files||[]) as Express.Multer.File[];
  await cleanupExpiredStagedUploads();
  const incomingBytes=files.reduce((total,file)=>total+file.size,0);
  const batch=files.map(file=>({file,id:id(),storageKey:crypto.randomUUID()}));
  // Reserve quota before any asynchronous object-store work. The advisory lock
  // is shared by every Relay instance, so two servers cannot approve the same
  // user's remaining storage at the same time.
  const reserved=db.transaction(()=>{
    db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))').get(req.user!.id);
    if(userStoredUploadBytes(req.user!.id)+incomingBytes>maxUserStorageBytes)return false;
    const insert=db.prepare('INSERT INTO staged_uploads(id,user_id,filename,mime,size,storage_name) VALUES(?,?,?,?,?,?)');
    for(const item of batch){
      const file=item.file;
      insert.run(item.id,req.user!.id,path.basename(file.originalname).slice(0,180),file.mimetype,file.size,item.storageKey);
    }
    return true;
  })();
  if(!reserved)return fail(res,413,`Your Relay storage quota is ${Math.floor(maxUserStorageBytes/1024/1024)} MB. Delete old attachments or wait for staged uploads to expire.`);
  const saved:any[]=[];
  try {
    for(const item of batch){
      await storeUpload(item.file.buffer,item.file.mimetype,item.storageKey);
      const file=item.file;
      saved.push({id:item.id,filename:path.basename(file.originalname),mime:file.mimetype,size:file.size,url:`/api/uploads/${item.id}`});
    }
  } catch(error) {
    // Keep any reservation whose object could not be deleted. The normal
    // expiry cleanup can retry it instead of silently orphaning stored data.
    for(const item of batch){
      try {
        await deleteUpload(item.storageKey);
        db.prepare('DELETE FROM staged_uploads WHERE id=? AND user_id=?').run(item.id,req.user!.id);
      } catch(cleanupError) {
        console.error('Failed to clean up a reserved upload after storage failed.',cleanupError);
      }
    }
    throw error;
  }
  res.status(201).json({uploads:saved,limitBytes:maxUpload,storageLimitBytes:maxUserStorageBytes,persistent:persistentStorageEnabled});
}));
app.get('/api/uploads/:uploadId', requireAuth, asyncRoute(async (req: AuthedRequest,res) => {
  const row=db.prepare(`SELECT a.filename,a.mime,a.storage_name,m.sender_id,m.channel_id,m.dm_id,s.user_id AS staged_owner,c.server_id
    FROM attachments a LEFT JOIN messages m ON m.id=a.message_id LEFT JOIN channels c ON c.id=m.channel_id LEFT JOIN staged_uploads s ON s.id=a.id WHERE a.id=?
    UNION ALL SELECT filename,mime,storage_name,NULL,NULL,NULL,user_id,NULL FROM staged_uploads WHERE id=?`).get(req.params.uploadId,req.params.uploadId) as any;
  if(!row)return fail(res,404,'File not found.');
  const allowed=row.staged_owner===req.user!.id || (row.channel_id&&canReadChannel(row.channel_id,req.user!.id)) || (row.dm_id&&canAccessDm(row.dm_id,req.user!.id));
  if(!allowed)return fail(res,403,'You cannot access this file.');
  try{const bytes=await readUpload(row.storage_name);res.setHeader('Content-Type',row.mime);res.setHeader('Content-Length',bytes.length);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`);res.send(bytes);}catch{return fail(res,404,'File storage is unavailable.');}
}));

// Presence heartbeat and authorized Socket.IO rooms.
const updatePresenceHeartbeat = (req:AuthedRequest,res:Response) => {
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),req.user!.id);
  res.json({ok:true});
};
// Heartbeats update account activity, so accept them only as a CSRF-protected POST.
app.post('/api/presence/heartbeat', requireAuth, updatePresenceHeartbeat);
function socketUser(cookieHeader='') {
  const match=cookieHeader.match(/(?:^|;\s*)relay_session=([^;]+)/); if(!match)return null;
  let token='';try{token=decodeURIComponent(match[1]);}catch{return null;}
  const row=db.prepare(`SELECT s.id AS session_id,s.expires_at,u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token),now()) as any; return row||null;
}
io.use((socket,next)=>{
  const session=socketUser(socket.handshake.headers.cookie||'');
  if(!session)return next(new Error('Unauthorized'));
  (socket.data as any).user=session;
  next();
});
io.on('connection',(socket)=>{
  const user=(socket.data as any).user;
  const socketEventWindows=new Map<string,{startedAt:number;count:number}>();
  const allowSocketEvent=(name:string,limit:number,windowMs:number)=>{
    const timestamp=Date.now();
    let window=socketEventWindows.get(name);
    if(!window||timestamp-window.startedAt>=windowMs){
      window={startedAt:timestamp,count:0};
      socketEventWindows.set(name,window);
    }
    window.count+=1;
    return window.count<=limit;
  };
  socket.join(`user:${user.id}`);
  socket.join(`session:${user.session_id}`);
  const sessionExpiryTimer=setTimeout(()=>socket.disconnect(true),Math.max(0,new Date(user.expires_at).getTime()-Date.now()));
  // Send a rotation notice first. Clients reconnect only for this planned
  // disconnect; expired/revoked sessions do not send the notice.
  let rotationDisconnectTimer:NodeJS.Timeout|undefined;
  const functionLifetimeTimer=(process.env.VERCEL==='1'||!!process.env.VERCEL_ENV)
    ? setTimeout(()=>{socket.emit('relay:rotate');rotationDisconnectTimer=setTimeout(()=>socket.disconnect(true),250);},4*60*1000-250)
    : undefined;
  sessionExpiryTimer.unref();
  functionLifetimeTimer?.unref();
  socket.once('disconnect',()=>{clearTimeout(sessionExpiryTimer);if(functionLifetimeTimer)clearTimeout(functionLifetimeTimer);if(rotationDisconnectTimer)clearTimeout(rotationDisconnectTimer);});
  socket.use((_packet,next)=>{
    const active=db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(user.session_id,user.id,now());
    if(!active){socket.disconnect(true);return;}
    next();
  });
  socket.on('room:join-channel',(channelId:string,ack?:Function)=>{
    if(!allowSocketEvent('room:join-channel',30,60_000)){ack?.({ok:false,error:'Too many room changes. Please reconnect.'});return;}
    if(typeof channelId!=='string'||channelId.length>128||!canReadChannel(channelId,user.id)){ack?.({ok:false,error:'Not authorized'});return;}
    socket.join(`channel:${channelId}`);
    ack?.({ok:true});
  });
  socket.on('room:join-dm',(dmId:string,ack?:Function)=>{
    if(!allowSocketEvent('room:join-dm',30,60_000)){ack?.({ok:false,error:'Too many room changes. Please reconnect.'});return;}
    if(typeof dmId!=='string'||dmId.length>128||!canAccessDm(dmId,user.id)){ack?.({ok:false,error:'Not authorized'});return;}
    socket.join(`dm:${dmId}`);
    ack?.({ok:true});
  });
  const typingRoom=(data:any)=>{
    const channelId=typeof data?.channelId==='string'&&data.channelId.length<=128?data.channelId:null;
    const dmId=typeof data?.dmId==='string'&&data.dmId.length<=128?data.dmId:null;
    if(channelId){
      const channel=db.prepare('SELECT server_id FROM channels WHERE id=?').get(channelId) as any;
      const room=`channel:${channelId}`;
      if(channel&&canReadChannel(channelId,user.id)&&!isTimedOut(channel.server_id,user.id)&&socket.rooms.has(room))return room;
      return null;
    }
    const room=dmId?`dm:${dmId}`:null;
    return room&&canAccessDm(dmId!,user.id)&&socket.rooms.has(room)?room:null;
  };
  socket.on('typing:start',(data:{channelId?:string;dmId?:string})=>{
    if(!allowSocketEvent('typing',30,10_000))return;
    const room=typingRoom(data);
    if(room)socket.to(room).emit('typing',{userId:user.id,username:user.username,active:true});
  });
  socket.on('typing:stop',(data:{channelId?:string;dmId?:string})=>{
    if(!allowSocketEvent('typing',30,10_000))return;
    const room=typingRoom(data);
    if(room)socket.to(room).emit('typing',{userId:user.id,username:user.username,active:false});
  });
  socket.on('voice:join',async(data:{channelId:string},ack?:Function)=>{
    if(!allowSocketEvent('voice:join',8,60_000)){ack?.({ok:false,error:'Too many voice join attempts. Please reconnect.'});return;}
    if(typeof data?.channelId!=='string'||data.channelId.length>128||!canJoinVoiceChannel(data.channelId,user.id)){ack?.({ok:false,error:'You cannot join this voice channel. Check membership, channel access, and any active server timeout.'});return;}
    const room=`voice:${data.channelId}`;
    const alreadyJoined=socket.rooms.has(room);
    socket.join(room);
    if(!alreadyJoined)socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'joined'});
    try {
      const peers=await io.in(room).fetchSockets();
      ack?.({ok:true,participants:peers.filter(peer=>peer.id!==socket.id).map(peer=>({
        socketId:peer.id,
        userId:(peer.data as any).user?.id,
        username:(peer.data as any).user?.username
      }))});
    } catch(error) {
      socket.leave(room);
      socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'left'});
      ack?.({ok:false,error:'Relay could not load voice participants. Please reconnect.'});
      console.error('Relay voice participant lookup failed:',error);
    }
  });
  socket.on('voice:leave',(channelId:string)=>{
    if(typeof channelId!=='string'||channelId.length>128)return;
    const room=`voice:${channelId}`;
    if(!socket.rooms.has(room))return;
    socket.leave(room);
    socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'left'});
  });
  socket.on('voice:state',(data:{channelId:string;muted:boolean;deafened:boolean})=>{
    if(!allowSocketEvent('voice:state',30,10_000))return;
    if(typeof data?.channelId!=='string'||data.channelId.length>128||typeof data.muted!=='boolean'||typeof data.deafened!=='boolean')return;
    if(canJoinVoiceChannel(data.channelId,user.id)&&socket.rooms.has(`voice:${data.channelId}`))socket.to(`voice:${data.channelId}`).emit('voice:state',{userId:user.id,channelId:data.channelId,muted:data.muted,deafened:data.deafened});
  });
  socket.on('webrtc:signal',async(data:{toSocketId:string;payload:unknown;channelId:string})=>{
    if(!allowSocketEvent('webrtc:signal',120,60_000))return;
    if(typeof data?.channelId!=='string'||data.channelId.length>128||typeof data.toSocketId!=='string'||data.toSocketId.length>128)return;
    const signal=data.payload as any;
    const validSignal=!!signal&&typeof signal==='object'&&(
      (signal.type==='candidate'&&typeof signal.candidate?.candidate==='string'&&signal.candidate.candidate.length<=8192)||
      ((signal.type==='offer'||signal.type==='answer')&&typeof signal.sdp?.sdp==='string'&&signal.sdp.sdp.length<=32768)
    );
    if(!validSignal)return;
    const room=`voice:${data.channelId}`;
    if(!canJoinVoiceChannel(data.channelId,user.id)||!socket.rooms.has(room))return;
    try {
      const targets=await io.in(data.toSocketId).fetchSockets();
      if(targets.some(target=>target.rooms.has(room))) {
        io.to(data.toSocketId).emit('webrtc:signal',{
          fromSocketId:socket.id,
          fromUser:{id:user.id,username:user.username},
          payload:data.payload,
          channelId:data.channelId
        });
      }
    } catch(error) {
      console.error('Relay voice signal delivery failed:',error);
    }
  });
  socket.on('disconnect',()=>{
    clearTimeout(sessionExpiryTimer);
    if(functionLifetimeTimer)clearTimeout(functionLifetimeTimer);
    for(const room of socket.rooms){if(room.startsWith('voice:'))socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'left'});}
  });
});

// Static hosting for the production build.
const clientDist=path.resolve(__dirname,'../../client/dist');
if(fs.existsSync(clientDist)){app.use(express.static(clientDist));app.get('*',(req,res,next)=>req.path.startsWith('/api')?next():res.sendFile(path.join(clientDist,'index.html')));}
app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
  if(err instanceof multer.MulterError)return fail(res,400,err.code==='LIMIT_FILE_SIZE'?`File exceeds the ${Math.round(maxUpload/1024/1024)} MB upload limit.`:err.message);
  if(err?.message==='This file type is not allowed.')return fail(res,400,err.message);
  console.error(err); return fail(res,500,'The server could not complete that request.');
});
server.listen(PORT, process.env.HOST || '0.0.0.0', ()=>console.log(`Relay API listening on http://localhost:${PORT}`));
