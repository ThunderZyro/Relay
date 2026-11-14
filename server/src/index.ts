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
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { Pool } from 'pg';
import { databaseUrl, db, PERMISSIONS } from './db.js';
import { storeUpload, readUpload, deleteUpload, persistentStorageEnabled, missingStorageEnvironment } from './storage.js';

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
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin: (requestOrigin, callback) => callback(null, isAllowedOrigin(requestOrigin)),
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Cookie-authenticated mutations require a trusted browser origin and a
// client-only header that ordinary cross-origin forms cannot send.
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
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
  max:2,
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
  const [firstSockets,secondSockets]=await Promise.all([
    io.in(`user:${firstUserId}`).fetchSockets(),
    io.in(`user:${secondUserId}`).fetchSockets()
  ]);
  for(const conversation of conversations){
    const room=`dm:${conversation.id}`;
    for(const socket of [...firstSockets,...secondSockets])if(socket.rooms.has(room))socket.leave(room);
  }
}
function emitFriendUpdate(...userIds: string[]) {
  for (const userId of new Set(userIds.filter(Boolean))) io.to(`user:${userId}`).emit('friends:updated');
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const interactionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 45, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/api/health', (_req, res) => {
  const productionStorageMissing = isProd ? missingStorageEnvironment : [];
  const passwordRecoveryConfigured = !!(process.env.RESEND_API_KEY?.trim() && process.env.RELAY_EMAIL_FROM?.trim());
  res.json({
    status: isProd && !persistentStorageEnabled ? 'degraded' : 'ok',
    service: 'relay-api',
    time: now(),
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
  const schema = z.object({ email: z.string().email().max(254), username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(10).max(128) });
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
  const parsed = z.object({ login:z.string().min(1).max(254), password:z.string().min(1).max(128) }).safeParse(req.body);
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
  const p=z.object({token:z.string().min(20).max(200),password:z.string().min(10).max(128)}).safeParse(req.body);
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
  res.json({user:userPublic(row),isBlocked:blockedEither(req.user!.id,row.id)});
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
  res.json({user:userPublic(row)});
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
  const p=z.object({currentPassword:z.string().min(1),newPassword:z.string().min(10).max(128)}).safeParse(req.body);
  if(!p.success)return fail(res,400,'New password must be at least 10 characters.');
  const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user!.id) as any;
  if(!row || !(await bcrypt.compare(p.data.currentPassword,row.password_hash)))return fail(res,403,'Current password is incorrect.');
  const hash=await bcrypt.hash(p.data.newPassword,12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.user!.id);
  const currentToken=req.cookies?.relay_session;
  const revoked=db.prepare('SELECT id FROM sessions WHERE user_id=? AND token_hash<>?').all(req.user!.id,currentToken?sha(currentToken):'') as any[];
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user!.id,currentToken?sha(currentToken):'');
  revoked.forEach(session=>disconnectSessionSockets(session.id));
  res.json({ok:true});
}));
app.patch('/api/presence', requireAuth, (req: AuthedRequest,res) => {
  const p=z.object({presence:z.enum(['online','idle','dnd','offline']),status_text:z.string().max(80).optional()}).safeParse(req.body);
  if(!p.success)return fail(res,400,'Invalid presence.'); db.prepare('UPDATE users SET presence=?,status_text=COALESCE(?,status_text) WHERE id=?').run(p.data.presence,p.data.status_text??null,req.user!.id); res.json({ok:true});
});
app.get('/api/settings', requireAuth, (req: AuthedRequest,res) => {
  const row=db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user!.id) as any;
  res.json({settings:JSON.parse(row?.data||'{}')});
});
app.put('/api/settings', requireAuth, (req: AuthedRequest,res) => {
  const current=db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user!.id) as any;
  const incoming=z.record(z.any()).safeParse(req.body.settings);
  if (!incoming.success) return fail(res,400,'Settings must be an object.');
  const data={...JSON.parse(current?.data||'{}'),...incoming.data};
  db.prepare(`INSERT INTO settings(user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`).run(req.user!.id,JSON.stringify(data),now());
  res.json({settings:data});
});
app.get('/api/privacy', requireAuth, (req: AuthedRequest,res) => { const row=db.prepare('SELECT dm_privacy,activity_visible FROM users WHERE id=?').get(req.user!.id) as any; res.json({dm_privacy:row.dm_privacy,activity_visible:!!row.activity_visible}); });
app.patch('/api/privacy', requireAuth, (req: AuthedRequest,res) => {
  const parsed=z.object({dm_privacy:z.enum(['everyone','friends','nobody']).optional(),activity_visible:z.boolean().optional()}).safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Invalid privacy setting.');
  const fields=Object.entries(parsed.data); if(fields.length) db.prepare(`UPDATE users SET ${fields.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(([,v])=>v),req.user!.id);
  res.json({ok:true});
});

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
app.delete('/api/friends/:friendshipId', requireAuth, (req: AuthedRequest,res) => {
  const friendship=db.prepare('SELECT requester_id,addressee_id FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)').get(req.params.friendshipId,req.user!.id,req.user!.id) as any;
  if(!friendship)return fail(res,404,'Friend request or friendship not found.');
  db.prepare('DELETE FROM friendships WHERE id=?').run(req.params.friendshipId);
  emitFriendUpdate(friendship.requester_id,friendship.addressee_id);
  res.json({ok:true});
});
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
app.delete('/api/blocks/:userId', requireAuth, (req: AuthedRequest,res) => { db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(req.user!.id,req.params.userId); res.json({ok:true}); });

function canAccessDm(dmId: string,userId: string) {
  if (!db.prepare('SELECT 1 FROM dm_members WHERE dm_id=? AND user_id=?').get(dmId,userId)) return false;
  const conversation=db.prepare('SELECT is_group FROM dms WHERE id=?').get(dmId) as any;
  if (conversation?.is_group) return true;
  const peers=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(dmId,userId) as any[];
  return !peers.some(peer=>blockedEither(userId,peer.user_id));
}
function dmSummary(dmId: string,userId: string) {
  const row=db.prepare(`SELECT d.*, (SELECT content FROM messages m WHERE m.dm_id=d.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
    (SELECT created_at FROM messages m WHERE m.dm_id=d.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
    FROM dms d JOIN dm_members me ON me.dm_id=d.id WHERE d.id=? AND me.user_id=?`).get(dmId,userId) as any;
  if(!row)return null;
  const peerIds=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(dmId,userId) as any[];
  if(!row.is_group && peerIds.some(peer=>blockedEither(userId,peer.user_id)))return null;
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
  for(const uid of members.slice(1)){ if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))return fail(res,404,'One selected user was not found.'); if(blockedEither(req.user!.id,uid))return fail(res,403,'A block prevents this conversation.');
    const target=db.prepare('SELECT dm_privacy FROM users WHERE id=?').get(uid) as any;
    if(target.dm_privacy==='nobody')return fail(res,403,'One selected user does not accept DMs.');
    if(target.dm_privacy==='friends' && !db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.user!.id,uid,uid,req.user!.id))return fail(res,403,'You must be friends before messaging this user.');
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
  const target=db.prepare('SELECT dm_privacy FROM users WHERE id=?').get(parsed.data.userId) as any; if(!target)return fail(res,404,'User not found.');
  if(blockedEither(req.user!.id,parsed.data.userId))return fail(res,403,'A block prevents adding this user.');
  if(target.dm_privacy==='nobody')return fail(res,403,'This user does not accept direct messages.');
  if(target.dm_privacy==='friends' && !db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(req.user!.id,parsed.data.userId,parsed.data.userId,req.user!.id))return fail(res,403,'You must be friends before adding this user.');
  db.prepare('INSERT INTO dm_members(dm_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(req.params.dmId,parsed.data.userId); res.json({conversation:dmSummary(req.params.dmId,req.user!.id)});
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
  const servers=db.prepare(`SELECT s.id,s.name,s.description,s.icon,s.created_at,(SELECT COUNT(*) FROM memberships m WHERE m.server_id=s.id) member_count
    FROM servers s WHERE s.is_discoverable=1 AND (s.name LIKE ? OR s.description LIKE ?) ORDER BY member_count DESC LIMIT 40`).all(`%${q}%`,`%${q}%`);
  res.json({servers});
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
    (SELECT COALESCE(json_agg(json_build_object('id',a.id,'filename',a.filename,'mime',a.mime,'size',a.size))::text,'[]') FROM attachments a WHERE a.message_id=m.id) attachments
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE ${whereSql} ORDER BY m.created_at DESC LIMIT ?`)
    .all(...params,limit).reverse().map((m:any)=>({
      ...m,
      reactions:JSON.parse(m.reactions||'[]'),
      attachments:JSON.parse(m.attachments||'[]')
    }));
}
app.get('/api/channels/:channelId/messages', requireAuth, (req: AuthedRequest,res) => {
  if(!canReadChannel(req.params.channelId,req.user!.id))return fail(res,403,'Channel membership required.');
  const before=String(req.query.before||''); const rows=before?messageRows('m.channel_id=? AND m.deleted_at IS NULL AND m.created_at<?',[req.params.channelId,before]):messageRows('m.channel_id=? AND m.deleted_at IS NULL',[req.params.channelId]); res.json({messages:rows});
});
app.get('/api/dms/:dmId/messages', requireAuth, (req: AuthedRequest,res) => {
  if(!canAccessDm(req.params.dmId,req.user!.id))return fail(res,403,'Conversation access is unavailable.');
  const before=String(req.query.before||''); const rows=before?messageRows('m.dm_id=? AND m.deleted_at IS NULL AND m.created_at<?',[req.params.dmId,before]):messageRows('m.dm_id=? AND m.deleted_at IS NULL',[req.params.dmId]); res.json({messages:rows});
});
const messageCreateSchema=z.object({content:z.string().max(4000).default(''),reply_to:z.string().optional(),uploadIds:z.array(z.string()).max(8).optional()}).refine(v=>v.content.trim().length>0 || !!v.uploadIds?.length,{message:'Write a message or attach a file.'});
function createMessage(req: AuthedRequest,res: Response,destination:{channelId?:string;dmId?:string}) {
  const p=messageCreateSchema.safeParse(req.body); if(!p.success)return fail(res,400,p.error.issues[0]?.message||'Invalid message.');
  if(destination.channelId){ if(!canReadChannel(destination.channelId,req.user!.id))return fail(res,403,'You cannot send messages in this channel.'); const c=db.prepare('SELECT * FROM channels WHERE id=?').get(destination.channelId) as any;
    if(!hasPermission(c.server_id,req.user!.id,'send_messages'))return fail(res,403,'You do not have permission to send messages.'); const mem=membership(c.server_id,req.user!.id); if(mem?.timeout_until && new Date(mem.timeout_until).getTime()>Date.now())return fail(res,403,'Your server timeout is active.');
    const latest=db.prepare('SELECT created_at FROM messages WHERE channel_id=? AND sender_id=? ORDER BY created_at DESC LIMIT 1').get(c.id,req.user!.id) as any;
    if(c.slow_mode>0 && latest && Date.now()-new Date(latest.created_at).getTime()<c.slow_mode*1000)return fail(res,429,`Slow mode is active. Try again in ${Math.ceil(c.slow_mode-(Date.now()-new Date(latest.created_at).getTime())/1000)} seconds.`);
  } else {
    if(!canAccessDm(destination.dmId!,req.user!.id))return fail(res,403,'You cannot access this conversation.');
  }
  if(p.data.reply_to){const parent=db.prepare('SELECT channel_id,dm_id FROM messages WHERE id=?').get(p.data.reply_to) as any;if(!parent || parent.channel_id!==(destination.channelId||null) || parent.dm_id!==(destination.dmId||null))return fail(res,400,'The replied-to message is not in this conversation.');}
  const mid=id();
  const created=db.transaction(()=>{
    if(p.data.uploadIds?.length){
      for(const aid of p.data.uploadIds){
        const staged=db.prepare(`SELECT 1 FROM staged_uploads WHERE id=? AND user_id=? AND created_at::timestamptz>NOW()-?::interval`).get(aid,req.user!.id,`${stagedUploadTtlHours} hours`);
        if(!staged)return false;
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
    return true;
  })();
  if(!created)return fail(res,403,'One of those uploads has expired or is no longer available. Attach it again.');
  const row=messageRows(`m.id=?`,[mid],1)[0];
  const room=destination.channelId?`channel:${destination.channelId}`:`dm:${destination.dmId}`; io.to(room).emit('message:new',row);
  if(destination.dmId){const users=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(destination.dmId,req.user!.id) as any[]; users.forEach(u=>notify(u.user_id,'dm',`Message from ${req.user!.username}`,p.data.content.slice(0,100),`/channels/@me/${destination.dmId}`));}
  else {const ch=db.prepare('SELECT server_id,name FROM channels WHERE id=?').get(destination.channelId) as any; const mentionIds=[...p.data.content.matchAll(/@\{([a-zA-Z0-9_-]+)\}/g)].map(m=>m[1]); mentionIds.forEach(uid=>{if(uid!==req.user!.id && membership(ch.server_id,uid))notify(uid,'mention',`Mention in #${ch.name}`,p.data.content.slice(0,100),`/channels/${ch.server_id}/${destination.channelId}`);});}
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
  try{db.prepare('INSERT INTO message_reports(id,message_id,reporter_id,reason) VALUES(?,?,?,?)').run(id(),m.id,req.user!.id,p.data.reason);}catch{return fail(res,409,'You have already reported this message.');} res.status(201).json({ok:true});
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
    const peers=db.prepare('SELECT user_id FROM dm_members WHERE dm_id=? AND user_id<>?').all(message.dm_id,req.user!.id) as any[];
    return !peers.some(peer=>blockedEither(req.user!.id,peer.user_id));
  }).slice(0,20);
  res.json({users,servers,messages});
});

// Notifications, events, help, and local uploads
app.get('/api/notifications', requireAuth, (req: AuthedRequest,res) => res.json({notifications:db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user!.id)}));
app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest,res) => {db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(),req.user!.id);res.json({ok:true});});
app.post('/api/notifications/:notificationId/read', requireAuth, (req: AuthedRequest,res) => {db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(),req.params.notificationId,req.user!.id);res.json({ok:true});});
app.get('/api/events', requireAuth, (req: AuthedRequest,res) => {
  const rows=db.prepare(`SELECT e.*,s.name AS server_name,(SELECT status FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=?) AS my_rsvp,(SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id AND r.status='going') AS going_count FROM events e JOIN servers s ON s.id=e.server_id JOIN memberships m ON m.server_id=s.id AND m.user_id=? ORDER BY e.starts_at`).all(req.user!.id,req.user!.id);
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
const shutdownRelay=()=>{
  clearInterval(stagedUploadCleanupTimer);
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
  if(userStoredUploadBytes(req.user!.id)+incomingBytes>maxUserStorageBytes)return fail(res,413,`Your Relay storage quota is ${Math.floor(maxUserStorageBytes/1024/1024)} MB. Delete old attachments or wait for staged uploads to expire.`);
  const saved:any[]=[];
  const createdKeys:string[]=[];
  try {
    for(const file of files){
      const key=await storeUpload(file.buffer,file.mimetype),uid=id();
      createdKeys.push(key);
      db.prepare('INSERT INTO staged_uploads(id,user_id,filename,mime,size,storage_name) VALUES(?,?,?,?,?,?)')
        .run(uid,req.user!.id,path.basename(file.originalname).slice(0,180),file.mimetype,file.size,key);
      saved.push({id:uid,filename:path.basename(file.originalname),mime:file.mimetype,size:file.size,url:`/api/uploads/${uid}`});
    }
  } catch(error) {
    for(const key of createdKeys)void deleteUpload(key).catch(()=>{});
    for(const item of saved)db.prepare('DELETE FROM staged_uploads WHERE id=?').run(item.id);
    throw error;
  }
  res.status(201).json({uploads:saved,limitBytes:maxUpload,storageLimitBytes:maxUserStorageBytes,persistent:persistentStorageEnabled});
}));
app.get('/api/uploads/:uploadId', requireAuth, asyncRoute(async (req: AuthedRequest,res) => {
  const row=db.prepare(`SELECT a.filename,a.mime,a.storage_name,m.sender_id,m.channel_id,m.dm_id,s.user_id AS staged_owner,c.server_id
    FROM attachments a LEFT JOIN messages m ON m.id=a.message_id LEFT JOIN channels c ON c.id=m.channel_id LEFT JOIN staged_uploads s ON s.id=a.id WHERE a.id=?
    UNION ALL SELECT filename,mime,storage_name,NULL,NULL,NULL,user_id,NULL FROM staged_uploads WHERE id=?`).get(req.params.uploadId,req.params.uploadId) as any;
  if(!row)return fail(res,404,'File not found.');
  const allowed=row.staged_owner===req.user!.id || row.sender_id===req.user!.id || (row.channel_id&&canReadChannel(row.channel_id,req.user!.id)) || (row.dm_id&&canAccessDm(row.dm_id,req.user!.id));
  if(!allowed)return fail(res,403,'You cannot access this file.');
  try{const bytes=await readUpload(row.storage_name);res.setHeader('Content-Type',row.mime);res.setHeader('Content-Length',bytes.length);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`);res.send(bytes);}catch{return fail(res,404,'File storage is unavailable.');}
}));

// Presence heartbeat and authorized Socket.IO rooms.
const updatePresenceHeartbeat = (req:AuthedRequest,res:Response) => {
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),req.user!.id);
  res.json({ok:true});
};
// Keep GET briefly for older Relay clients while current clients use POST.
app.get('/api/presence/heartbeat', requireAuth, updatePresenceHeartbeat);
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
  socket.join(`user:${user.id}`);
  socket.join(`session:${user.session_id}`);
  const sessionExpiryTimer=setTimeout(()=>socket.disconnect(true),Math.max(0,new Date(user.expires_at).getTime()-Date.now()));
  // Vercel Hobby WebSocket invocations are capped at 300 seconds. Reconnect
  // early so clients can restore their room membership and missed messages.
  const functionLifetimeTimer=(process.env.VERCEL==='1'||!!process.env.VERCEL_ENV)
    ? setTimeout(()=>socket.disconnect(true),4*60*1000)
    : undefined;
  sessionExpiryTimer.unref();
  functionLifetimeTimer?.unref();
  socket.use((_packet,next)=>{
    const active=db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(user.session_id,user.id,now());
    if(!active){socket.disconnect(true);return;}
    next();
  });
  socket.on('room:join-channel',(channelId:string,ack?:Function)=>{if(typeof channelId!=='string'||!canReadChannel(channelId,user.id)){ack?.({ok:false,error:'Not authorized'});return;}socket.join(`channel:${channelId}`);ack?.({ok:true});});
  socket.on('room:join-dm',(dmId:string,ack?:Function)=>{if(typeof dmId!=='string'||!canAccessDm(dmId,user.id)){ack?.({ok:false,error:'Not authorized'});return;}socket.join(`dm:${dmId}`);ack?.({ok:true});});
  const typingRoom=(data:any)=>{
    const channelId=typeof data?.channelId==='string'?data.channelId:null;
    const dmId=typeof data?.dmId==='string'?data.dmId:null;
    if(channelId){
      const channel=db.prepare('SELECT server_id FROM channels WHERE id=?').get(channelId) as any;
      if(channel&&canReadChannel(channelId,user.id)&&!isTimedOut(channel.server_id,user.id))return `channel:${channelId}`;
      return null;
    }
    return dmId&&canAccessDm(dmId,user.id)?`dm:${dmId}`:null;
  };
  socket.on('typing:start',(data:{channelId?:string;dmId?:string})=>{const room=typingRoom(data);if(room)socket.to(room).emit('typing',{userId:user.id,username:user.username,active:true});});
  socket.on('typing:stop',(data:{channelId?:string;dmId?:string})=>{const room=typingRoom(data);if(room)socket.to(room).emit('typing',{userId:user.id,username:user.username,active:false});});
  socket.on('voice:join',async(data:{channelId:string},ack?:Function)=>{
    if(typeof data?.channelId!=='string'||!canJoinVoiceChannel(data.channelId,user.id)){ack?.({ok:false,error:'You cannot join this voice channel. Check membership, channel access, and any active server timeout.'});return;}
    const room=`voice:${data.channelId}`;
    socket.join(room);
    socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'joined'});
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
    if(typeof channelId!=='string')return;
    const room=`voice:${channelId}`;
    if(!socket.rooms.has(room))return;
    socket.leave(room);
    socket.to(room).emit('voice:participant',{userId:user.id,username:user.username,socketId:socket.id,state:'left'});
  });
  socket.on('voice:state',(data:{channelId:string;muted:boolean;deafened:boolean})=>{
    if(typeof data?.channelId!=='string'||typeof data.muted!=='boolean'||typeof data.deafened!=='boolean')return;
    if(canJoinVoiceChannel(data.channelId,user.id)&&socket.rooms.has(`voice:${data.channelId}`))socket.to(`voice:${data.channelId}`).emit('voice:state',{userId:user.id,channelId:data.channelId,muted:data.muted,deafened:data.deafened});
  });
  socket.on('webrtc:signal',async(data:{toSocketId:string;payload:unknown;channelId:string})=>{
    if(typeof data?.channelId!=='string'||typeof data.toSocketId!=='string'||data.toSocketId.length>128)return;
    const signal=data.payload as any;
    const validSignal=!!signal&&typeof signal==='object'&&(
      (signal.type==='candidate'&&typeof signal.candidate?.candidate==='string')||
      ((signal.type==='offer'||signal.type==='answer')&&typeof signal.sdp?.sdp==='string')
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
