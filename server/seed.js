// Sample data: creates "Demo Bar" (admin: demo / demo123) with 10 items and 5 tables. Skips if that bar already exists.
import bcrypt from 'bcryptjs';
import { pool, init } from './db.js';
await init();
if ((await pool.query("SELECT 1 FROM bars WHERE slug='demo-bar'")).rowCount) { console.log('Demo Bar already exists, seed skipped.'); process.exit(0); }
const { rows: [bar] } = await pool.query("INSERT INTO bars(name,slug) VALUES('Demo Bar','demo-bar') RETURNING id");
const { rows: [plan] } = await pool.query("SELECT * FROM plans WHERE kind='monthly' ORDER BY id LIMIT 1");
await pool.query("INSERT INTO subscriptions(bar_id,plan_id,plan_name,kind,months,price,ends_on,note,created_by) VALUES($1,$2,$3,$4,$5,0,(CURRENT_DATE + interval '1 month')::date - 1,'Demo','seed')", [bar.id, plan.id, plan.name, plan.kind, plan.months]);
await pool.query("INSERT INTO users(username,password_hash,role,bar_id) VALUES('demo',$1,'admin',$2)", [await bcrypt.hash('demo123', 10), bar.id]);
const items = [['Kingfisher Strong 650ml', 'Beer', 220, 140, 48, 12], ['Tuborg 650ml', 'Beer', 200, 130, 36, 12], ['Royal Stag 750ml', 'Whisky', 1400, 1050, 12, 3],
  ['Blenders Pride 750ml', 'Whisky', 1900, 1450, 10, 3], ['Old Monk 750ml', 'Rum', 900, 650, 15, 4], ['Smirnoff 750ml', 'Vodka', 1500, 1100, 8, 3],
  ['Coke 300ml', 'Soft drink', 60, 35, 60, 15], ['Soda 750ml', 'Soft drink', 40, 20, 50, 15], ['Peanut Masala', 'Snacks', 120, 60, 25, 8], ['Chicken Tikka', 'Snacks', 320, 170, 20, 5]];
for (const [name, category, price, cost, stock, min] of items)
  await pool.query('INSERT INTO products(bar_id,name,category,price,cost,stock,min_stock) VALUES($1,$2,$3,$4,$5,$6,$7)', [bar.id, name, category, price, cost, stock, min]);
for (let i = 1; i <= 5; i++) await pool.query('INSERT INTO bar_tables(bar_id,name) VALUES($1,$2)', [bar.id, `Table ${i}`]);
console.log('Seeded Demo Bar: login demo / demo123, 10 items, 5 tables.');
await pool.end();
