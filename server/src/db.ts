import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { nanoid } from 'nanoid';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
const configuredDatabaseUrl = process.env.VERCEL_ENV === 'preview' ? process.env.DATABASE_URL_PREVIEW : process.env.DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error('DATABASE_URL is required. Configure the Relay PostgreSQL connection before starting the API.');
export const databaseUrl: string = configuredDatabaseUrl;

const isTypeScript = import.meta.url.endsWith('.ts');
const worker = new Worker(new URL(isTypeScript ? './db-worker.ts' : './db-worker.js', import.meta.url), {
  workerData: { connectionString: databaseUrl },
  ...(isTypeScript ? { execArgv: process.execArgv.length ? process.execArgv : ['--import', 'tsx/esm'] } : {})
});
worker.unref();

const RESPONSE_BYTES = 16 * 1024 * 1024;

function callWorker(action: 'query' | 'exec', sql: string, params: unknown[] = []) {
  // Isolate each response. A timed-out request can finish later without
  // overwriting the result of a subsequent request.
  const responseBuffer = new SharedArrayBuffer(8 + RESPONSE_BYTES);
  const responseHeader = new Int32Array(responseBuffer, 0, 2);
  Atomics.store(responseHeader, 0, 0);
  Atomics.store(responseHeader, 1, 0);
  worker.postMessage({ action, sql, params, responseBuffer });
  const waitResult = Atomics.wait(responseHeader, 0, 0, 30_000);
  if (waitResult === 'timed-out') throw new Error('Relay database request timed out after 30 seconds.');
  const length = Atomics.load(responseHeader, 1);
  if (length <= 0 || length > RESPONSE_BYTES) throw new Error('Relay database worker returned an invalid response.');
  const raw = Buffer.from(new Uint8Array(responseBuffer, 8, length)).toString('utf8');
  const response = JSON.parse(raw);
  if (response.error) {
    const error = new Error(response.error.message || 'PostgreSQL query failed.');
    Object.assign(error, response.error);
    throw error;
  }
  return response;
}

function postgresSql(source: string) {
  let sql = source;
  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+/i.test(sql);
  if (ignoreConflict) sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, 'INSERT ');
  sql = sql
    .replace(/COLLATE\s+NOCASE/gi, '')
    .replace(/datetime\((\w+\.last_seen)\)/gi, 'CAST($1 AS timestamptz)')
    .replace(/datetime\('now','-2 minutes'\)/gi, "NOW() - INTERVAL '2 minutes'")
    .replace(/datetime\('now','-60 seconds'\)/gi, "NOW() - INTERVAL '60 seconds'")
    .replace(/(\w+)\s*<=\s*datetime\('now',\s*\?\s*\)/gi, "$1::timestamptz <= NOW() + ?::interval")
    .replace(/\bLIKE\s+\?/gi, 'ILIKE ?');
  if (ignoreConflict) sql = sql.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';

  let result = '', quote: "'" | '"' | null = null, parameter = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === '?') {
      result += '$' + (++parameter);
    } else result += char;
  }
  return result;
}

export const db = {
  prepare(source: string) {
    const sql = postgresSql(source);
    return {
      get(...params: unknown[]) { return callWorker('query', sql, params).rows[0]; },
      all(...params: unknown[]) { return callWorker('query', sql, params).rows; },
      run(...params: unknown[]) { return { changes: Number(callWorker('query', sql, params).rowCount || 0) }; }
    };
  },
  exec(sql: string) { return callWorker('exec', sql, []); },
  transaction<T extends (...args: any[]) => any>(callback: T) {
    return (...args: Parameters<T>): ReturnType<T> => {
      callWorker('query', 'BEGIN');
      try {
        const result = callback(...args);
        if (result && typeof result.then === 'function') throw new Error('Relay database transactions must remain synchronous.');
        callWorker('query', 'COMMIT');
        return result;
      } catch (error) {
        try { callWorker('query', 'ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
      }
    };
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
)`);
const migrations = [
  { version: 1, name: 'initial schema', file: '001_initial.sql' },
  { version: 2, name: 'membership timeout', file: '002_membership_timeout.sql' },
  { version: 3, name: 'staged uploads', file: '003_staged_uploads.sql' },
  { version: 4, name: 'password reset tokens', file: '004_password_reset_tokens.sql' },
  { version: 5, name: 'attachment and message query indexes', file: '005_attachment_query_indexes.sql' },
  { version: 6, name: 'distributed Socket.IO attachments', file: '006_socket_io_adapter.sql' },
  { version: 7, name: 'distributed API rate limits', file: '007_api_rate_limits.sql' }
];
const applyMigrations = db.transaction(() => {
  db.prepare('SELECT pg_advisory_xact_lock(71324001)').get();
  for (const migration of migrations) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) continue;
    if (migration.version === 2) {
      const column = db.prepare(`SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='memberships' AND column_name='timeout_until'`).get();
      if (!column) db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
    } else if (migration.version === 3) {
      const table = db.prepare(`SELECT 1 FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name='staged_uploads'`).get();
      if (!table) db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
    } else {
      db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
    }
    db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(migration.version, migration.name);
  }
});
applyMigrations();

export const PERMISSIONS = [
  'manage_server','manage_channels','manage_roles','manage_invites','manage_members',
  'kick_members','ban_members','timeout_members','manage_messages','pin_messages','view_channels','send_messages'
] as const;

export function seedDatabase() {
  const seed = db.transaction(() => {
    db.prepare('SELECT pg_advisory_xact_lock(71324002)').get();
    const user = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
    let ownerId = user?.id;
    if (!ownerId) {
      ownerId = 'relay-system';
      const exists = db.prepare('SELECT id FROM users WHERE id=?').get(ownerId);
      if (!exists) db.prepare(`INSERT INTO users(id,email,username,password_hash,bio,presence) VALUES(?,?,?,?,?,?)`)
        .run(ownerId, 'system@relay.local', 'RelayGuide', 'not-a-login', 'The Relay community guide account.', 'online');
    }
    const server = db.prepare('SELECT id FROM servers WHERE id=?').get('welcome-relay');
    if (!server) {
      db.prepare(`INSERT INTO servers(id,name,description,owner_id,is_discoverable) VALUES(?,?,?,?,1)`)
        .run('welcome-relay', 'Welcome to Relay', 'A sample community to explore channels and the interface. This is seeded demo content.', ownerId);
      const adminRole = nanoid(), memberRole = nanoid();
      db.prepare('INSERT INTO roles(id,server_id,name,permissions,position,is_system) VALUES(?,?,?,?,?,1)')
        .run(adminRole, 'welcome-relay', 'Guide', JSON.stringify([...PERMISSIONS]), 100);
      db.prepare('INSERT INTO roles(id,server_id,name,permissions,position,is_system) VALUES(?,?,?,?,?,1)')
        .run(memberRole, 'welcome-relay', 'Member', JSON.stringify(['view_channels','send_messages']), 0);
      db.prepare('INSERT INTO memberships(id,server_id,user_id,role_id) VALUES(?,?,?,?)')
        .run(nanoid(), 'welcome-relay', ownerId, adminRole);
      const cat = nanoid();
      db.prepare('INSERT INTO categories(id,server_id,name,position) VALUES(?,?,?,?)').run(cat, 'welcome-relay', 'TEXT CHANNELS', 0);
      const channel = nanoid();
      db.prepare('INSERT INTO channels(id,server_id,category_id,name,type,topic,position) VALUES(?,?,?,?,?,?,?)')
        .run(channel, 'welcome-relay', cat, 'start-here', 'text', 'A place to test the Relay interface.', 0);
      db.prepare('INSERT INTO messages(id,channel_id,sender_id,content) VALUES(?,?,?,?)')
        .run(nanoid(), channel, ownerId, 'Welcome to **Relay**. Create an account, invite a friend, and try the channel tools. Sample content is labelled as such.');
    }
  });
  seed();
}
seedDatabase();
