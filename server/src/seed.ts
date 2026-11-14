import { db } from './db.js';
console.log('Neon PostgreSQL database initialized.');
console.log('Sample community:', db.prepare('SELECT name FROM servers WHERE id=?').get('welcome-relay'));
