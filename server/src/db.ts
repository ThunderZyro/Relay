import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import dotenv from 'dotenv';

// The API runs from the server workspace, while the shared .env lives at the repository root.
// Hosting-provided environment variables always win over values in the local file.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.cwd(), process.env.DATABASE_FILE || './data/relay.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
const migrations = [
  { version: 1, name: 'initial schema', file: '001_initial.sql' },
  { version: 2, name: 'membership timeout', file: '002_membership_timeout.sql' },
  { version: 3, name: 'staged uploads', file: '003_staged_uploads.sql' }
];
for (const migration of migrations) {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version);
  if (applied) continue;
  if (migration.version === 2) {
    const columns = db.pragma('table_info(memberships)') as { name: string }[];
    if (!columns.some(column => column.name === 'timeout_until')) db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
  } else if (migration.version === 3) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staged_uploads'").get();
    if (!table) db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
  } else {
    db.exec(fs.readFileSync(path.resolve(here, `../migrations/${migration.file}`), 'utf8'));
  }
  db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(migration.version, migration.name);
}

export const PERMISSIONS = [
  'manage_server','manage_channels','manage_roles','manage_invites','manage_members',
  'kick_members','ban_members','timeout_members','manage_messages','pin_messages','view_channels','send_messages'
] as const;

export function seedDatabase() {
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
    const adminRole = nanoid();
    const memberRole = nanoid();
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
}

seedDatabase();
