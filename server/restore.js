// Restore a FULL-platform .bak into an EMPTY database:   node restore.js path/to/file.bak
import fs from 'fs';
import { pool, init } from './db.js';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node restore.js backup.bak'); process.exit(1); }
await init();
const used = (await pool.query('SELECT (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM bars)::int b, (SELECT count(*) FROM products)::int p')).rows[0];
if (used.u || used.b || used.p) { console.error('Database is not empty. Restore only into a fresh database (existing rows would clash).'); process.exit(1); }
await pool.query('DELETE FROM plans'); // remove default plans; the backup brings its own
await pool.query(fs.readFileSync(file, 'utf8'));
console.log('Restore complete.');
await pool.end();
