import { db } from './db.js';
console.log('SQLite database initialized at', db.name);
console.log('Sample community:', db.prepare('SELECT name FROM servers WHERE id=?').get('welcome-relay'));
