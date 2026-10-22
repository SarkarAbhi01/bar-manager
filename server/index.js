import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { pool, init } from './db.js';
import { h, err, actor, audit, tx, dateRange, order, qr, limit } from './util.js';
import { makeBak, makeXlsx } from './backup.js';
import superRouter from './super.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:5173';
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);   // set when behind Nginx/Caddy so rate limits see the real IP
app.use(cors(), express.json({ limit: '100kb' }));

// ---------- auth (JWT + roles + bar status) ----------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('WARNING: set JWT_SECRET in server/.env');
// one query = the user, their bar, and that bar's current subscription
const CTX = `SELECT u.id,u.username,u.role,u.bar_id,u.can_cancel,
    b.name bar_name,b.slug,b.active bar_active,b.show_audit,b.backup_enabled,b.online_pay,b.upi_id,
    s.plan_name,s.kind,s.ends_on,s.commission_pct,
    (b.id IS NOT NULL AND (s.id IS NULL OR (s.ends_on IS NOT NULL AND s.ends_on < CURRENT_DATE))) AS sub_expired
  FROM users u LEFT JOIN bars b ON b.id=u.bar_id
  LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE bar_id=b.id AND status='active' ORDER BY id DESC LIMIT 1) s ON true`;
const blocked = r => r.role === 'superadmin' ? null : !r.bar_active ? err(403, 'This bar account is disabled. Contact the platform owner.') : r.sub_expired ? err(402, 'Subscription expired. Contact the platform owner to renew.') : null;
const auth = async (req, res, next) => {
  let r;
  try {
    const t = jwt.verify((req.get('authorization') || '').slice(7), JWT_SECRET);
    r = (await pool.query(CTX + ' WHERE u.id=$1 AND u.active', [t.id])).rows[0];
    if (!r) throw new Error('inactive');
  } catch { return res.status(401).json({ error: 'Please sign in again' }); }
  const b = blocked(r);
  if (b) return res.status(b.status).json({ error: b.message });
  req.user = { id: r.id, username: r.username, role: r.role, bar_id: r.bar_id, can_cancel: r.can_cancel };
  req.bar = r.bar_id ? { id: r.bar_id, name: r.bar_name, slug: r.slug, show_audit: r.show_audit, backup_enabled: r.backup_enabled, online_pay: r.online_pay, upi_id: r.upi_id,
    plan: r.plan_name, kind: r.kind, ends_on: r.ends_on, commission_pct: r.commission_pct } : null;
  next();
};
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
app.use('/api', (req, res, next) => (req.path.startsWith('/public/') || req.path === '/auth/login') ? next() : auth(req, res, next));
// SuperAdmin has no bar: it may only use /super, /me, /account and /backup. Everything else is bar-only.
app.use('/api', (req, res, next) => req.user?.role === 'superadmin' && !/^\/(super|me|backup|account)(\/|$)/.test(req.path) ? res.status(403).json({ error: 'Use a bar login for this' }) : next());
app.use('/api/super', superRouter);






app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({
      status: 'error',
      database: 'disconnected'
    });
  }
});





const attempts = new Map();
app.post('/api/auth/login', h(async (req, res) => {
  const k = req.ip, a = attempts.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw err(429, 'Too many attempts. Try again in a few minutes.');
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE username=$1 AND active', [String(req.body.username || '')]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) { attempts.set(k, { ...a, n: a.n + 1 }); throw err(401, 'Wrong username or password'); }
  attempts.delete(k);
  const c = (await pool.query(CTX + ' WHERE u.id=$1', [u.id])).rows[0], b = blocked(c);
  if (b) throw b;
  const user = { id: u.id, username: u.username, role: u.role, bar_id: u.bar_id };
  res.json({ token: jwt.sign({ id: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '12h' }), user });
}));

app.get('/api/me', h(async (req, res) => {
  const { user, bar } = req;
  if (!bar) return res.json({ user, bar: null });
  const days = bar.ends_on ? Math.ceil((new Date(bar.ends_on) - new Date(new Date().toDateString())) / 864e5) + 1 : null;
  res.json({ user, bar: { name: bar.name, show_audit: bar.show_audit, backup_enabled: bar.backup_enabled, online_pay: bar.online_pay,
    ...(user.role === 'admin' && { upi_id: bar.upi_id, plan: bar.plan, kind: bar.kind, ends_on: bar.ends_on, days_left: days, commission_pct: bar.commission_pct }) } });
}));
app.post('/api/account/password', h(async (req, res) => {
  const { old_password, new_password } = req.body;
  if (String(new_password || '').length < 6) throw err(400, 'New password must be 6+ characters');
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(old_password || ''), u.password_hash))) throw err(401, 'Current password is wrong');
  await tx(async c => {
    await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(new_password, 10), req.user.id]);
    await audit(c, req.user.bar_id, req.user.bar_id ? 'user' : 'platform', req.user.id, 'UPDATE', null, { password: 'changed by user' }, actor(req));
  });
  res.json({ ok: true });
}));
app.put('/api/settings', admin, h(async (req, res) => {
  const { show_audit, online_pay, upi_id } = req.body, bar = req.bar;
  const n = { show_audit: show_audit ?? bar.show_audit, online_pay: online_pay ?? bar.online_pay, upi_id: upi_id === undefined ? bar.upi_id : (String(upi_id).trim() || null) };
  if (n.upi_id && !/^[\w.\-]{2,}@[A-Za-z][\w]{1,}$/.test(n.upi_id)) throw err(400, 'UPI ID looks wrong (example: barname@upi)');
  if (n.online_pay && !n.upi_id) throw err(400, 'Enter your UPI ID to switch on customer payments');
  await tx(async c => {
    await c.query('UPDATE bars SET show_audit=$1, online_pay=$2, upi_id=$3 WHERE id=$4', [!!n.show_audit, !!n.online_pay, n.upi_id, bar.id]);
    await audit(c, bar.id, 'settings', bar.id, 'UPDATE', { show_audit: bar.show_audit, online_pay: bar.online_pay, upi_id: bar.upi_id }, n, actor(req));
  });
  res.json({ ok: true });
}));

// ---------- users (admin) : only this bar's people ----------
const BAR_ROLES = ['admin', 'staff'];
app.get('/api/users', admin, h(async (req, res) => res.json((await pool.query('SELECT id,username,role,active,can_cancel,created_at FROM users WHERE bar_id=$1 ORDER BY id', [req.user.bar_id])).rows)));
app.post('/api/users', admin, h(async (req, res) => {
  const { username, password, role = 'staff', can_cancel = false } = req.body;
  if (!username?.trim() || (password || '').length < 6) throw err(400, 'Username and a password of 6+ characters are required');
  if (!BAR_ROLES.includes(role)) throw err(400, 'Invalid role');
  res.status(201).json(await tx(async c => {
    const { rows: [r] } = await c.query('INSERT INTO users(username,password_hash,role,bar_id,can_cancel) VALUES($1,$2,$3,$4,$5) RETURNING id,username,role,active,can_cancel',
      [username.trim(), await bcrypt.hash(password, 10), role, req.user.bar_id, role === 'staff' && !!can_cancel]);
    await audit(c, req.user.bar_id, 'user', r.id, 'CREATE', null, r, actor(req));
    return r;
  }));
}));
app.put('/api/users/:id', admin, h(async (req, res) => {
  const { role, active, password, can_cancel } = req.body;
  if (password && password.length < 6) throw err(400, 'Password must be 6+ characters');
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query('SELECT * FROM users WHERE id=$1 AND bar_id=$2 FOR UPDATE', [req.params.id, req.user.bar_id]);
    if (!old) throw err(404, 'User not found');
    const n = { role: role ?? old.role, active: active ?? old.active, can_cancel: can_cancel ?? old.can_cancel };
    if (!BAR_ROLES.includes(n.role)) throw err(400, 'Invalid role');
    if (n.role === 'admin') n.can_cancel = false;   // admins can always cancel; the flag is for staff only
    if (old.id === req.user.id && (n.role !== 'admin' || !n.active)) throw err(409, 'You cannot demote or deactivate yourself');
    const hash = password ? await bcrypt.hash(password, 10) : old.password_hash;
    const { rows: [r] } = await c.query('UPDATE users SET role=$1,active=$2,can_cancel=$3,password_hash=$4 WHERE id=$5 AND bar_id=$6 RETURNING id,username,role,active,can_cancel', [n.role, n.active, n.can_cancel, hash, old.id, req.user.bar_id]);
    await audit(c, req.user.bar_id, 'user', old.id, 'UPDATE', { role: old.role, active: old.active, can_cancel: old.can_cancel }, { role: r.role, active: r.active, can_cancel: r.can_cancel, ...(password && { password: 'changed' }) }, actor(req));
    return r;
  }));
}));

// ---------- products (stock) ----------
app.get('/api/products', h(async (req, res) => {
  const { q, category, low, sort, dir } = req.query, w = ['bar_id=$1', 'deleted_at IS NULL'], p = [req.user.bar_id];
  if (q) { p.push(`%${q}%`); w.push(`name ILIKE $${p.length}`); }
  if (category) { p.push(`%${category}%`); w.push(`category ILIKE $${p.length}`); }
  if (low === '1') w.push('stock <= min_stock');
  const o = order({ name: 'name', category: 'category', price: 'price', stock: 'stock', updated: 'updated_at' }, sort, dir, 'name');
  const { rows } = await pool.query(`SELECT * FROM products WHERE ${w.join(' AND ')} ORDER BY ${o}`, p);
  res.json(req.user.role === 'admin' ? rows : rows.map(({ cost, ...r }) => r));
}));
app.post('/api/products', admin, h(async (req, res) => {
  const { name, category = 'General', price, cost = 0, stock = 0, min_stock = 5 } = req.body;
  if (!name || price == null || price === '') throw err(400, 'Name and price are required');
  res.status(201).json(await tx(async c => {
    const { rows: [r] } = await c.query('INSERT INTO products(bar_id,name,category,price,cost,stock,min_stock) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.bar_id, name, category, price, cost, stock, min_stock]);
    await audit(c, req.user.bar_id, 'product', r.id, 'CREATE', null, r, actor(req));
    return r;
  }));
}));
app.put('/api/products/:id', admin, h(async (req, res) => {
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query('SELECT * FROM products WHERE id=$1 AND bar_id=$2 AND deleted_at IS NULL FOR UPDATE', [req.params.id, req.user.bar_id]);
    if (!old) throw err(404, 'Product not found');
    const n = { ...old, ...req.body };
    const { rows: [r] } = await c.query('UPDATE products SET name=$1,category=$2,price=$3,cost=$4,stock=$5,min_stock=$6,updated_at=now() WHERE id=$7 AND bar_id=$8 RETURNING *',
      [n.name, n.category, n.price, n.cost, n.stock, n.min_stock, old.id, req.user.bar_id]);
    await audit(c, req.user.bar_id, 'product', old.id, 'UPDATE', old, r, actor(req));
    return r;
  }));
}));

// ---------- tables + QR ----------
app.get('/api/tables', h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bar_tables WHERE bar_id=$1 AND deleted_at IS NULL ORDER BY id', [req.user.bar_id]);
  res.json(await Promise.all(rows.map(async ({ token, ...t }) => {
    const url = `${PUBLIC_URL}/menu?t=${token}`;
    return { ...t, url, qr: await qr(url) };
  })));
}));
app.post('/api/tables', admin, h(async (req, res) => {
  if (!req.body.name?.trim()) throw err(400, 'Table name required');
  res.status(201).json(await tx(async c => {
    const { rows: [r] } = await c.query('INSERT INTO bar_tables(bar_id,name) VALUES($1,$2) RETURNING id,name', [req.user.bar_id, req.body.name.trim()]);
    await audit(c, req.user.bar_id, 'table', r.id, 'CREATE', null, r, actor(req));
    return r;
  }));
}));
app.get('/api/qr/global', h(async (req, res) => {
  const url = `${PUBLIC_URL}/menu?b=${req.bar.slug}`;
  res.json({ url, image: await qr(url) });
}));
for (const [path, tbl, ent] of [['products', 'products', 'product'], ['tables', 'bar_tables', 'table']]) {
  app.delete(`/api/${path}/:id`, admin, h(async (req, res) => {
    await tx(async c => {
      const { rows: [r] } = await c.query(`UPDATE ${tbl} SET deleted_at=now() WHERE id=$1 AND bar_id=$2 AND deleted_at IS NULL RETURNING id,name`, [req.params.id, req.user.bar_id]);
      if (!r) throw err(404, 'Not found');
      await audit(c, req.user.bar_id, ent, r.id, 'DELETE', r, null, actor(req));
    });
    res.json({ ok: true });
  }));
}

// ---------- orders ----------
// Every product / table used by an order must belong to the same bar as the order.
async function placeOrder(c, { bar_id, source, table_id, customer, items, taken_by_id, by }) {
  if (!Array.isArray(items) || !items.length) throw err(400, 'Add at least one item');
  if (table_id && !(await c.query('SELECT 1 FROM bar_tables WHERE id=$1 AND bar_id=$2 AND deleted_at IS NULL', [table_id, bar_id])).rowCount) throw err(400, 'Table not found');
  const { rows: [{ order_seq }] } = await c.query('UPDATE bars SET order_seq=order_seq+1 WHERE id=$1 RETURNING order_seq', [bar_id]);
  const { rows: [o] } = await c.query('INSERT INTO orders(bar_id,no,source,table_id,customer,created_by,taken_by_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [bar_id, order_seq, source, table_id || null, customer || null, by, taken_by_id || null]);
  let total = 0; const lines = [], seen = new Set();
  for (const it of [...items].sort((a, b) => a.product_id - b.product_id)) {   // sorted: consistent lock order, no deadlocks
    const qty = parseInt(it.qty);
    if (!(qty > 0)) throw err(400, 'Invalid quantity');
    if (seen.has(+it.product_id)) throw err(400, 'Duplicate item in order'); seen.add(+it.product_id);
    const { rows: [p] } = await c.query('SELECT * FROM products WHERE id=$1 AND bar_id=$2 AND deleted_at IS NULL FOR UPDATE', [it.product_id, bar_id]);
    if (!p) throw err(400, 'Product not available');
    if (p.stock < qty) throw err(409, `Only ${p.stock} left of ${p.name}`);
    await c.query('UPDATE products SET stock=stock-$1, updated_at=now() WHERE id=$2', [qty, p.id]);
    await c.query('INSERT INTO order_items(order_id,product_id,qty,price,cost) VALUES($1,$2,$3,$4,$5)', [o.id, p.id, qty, p.price, p.cost]);
    total += qty * p.price; lines.push({ product: p.name, qty, price: p.price });
  }
  const { rows: [r] } = await c.query('UPDATE orders SET total=$1 WHERE id=$2 RETURNING *', [total, o.id]);
  await audit(c, bar_id, 'order', r.id, 'CREATE', null, { ...r, track_token: undefined, items: lines }, by);
  return r;
}
const restock = (c, id) => c.query(`UPDATE products p SET stock=p.stock+i.qty, updated_at=now()
  FROM (SELECT product_id, SUM(qty) qty FROM order_items WHERE order_id=$1 GROUP BY product_id) i WHERE p.id=i.product_id`, [id]);

app.post('/api/orders', h(async (req, res) => {
  const { table_id, customer, items } = req.body, me = req.user;
  const o = await tx(c => placeOrder(c, { bar_id: me.bar_id, source: 'MANUAL', table_id, customer, items, taken_by_id: me.id, by: actor(req) }));
  res.status(201).json({ id: o.id, no: o.no, total: o.total });
}));
app.get('/api/orders', h(async (req, res) => {
  const me = req.user, { status, source, staff, sort, dir } = req.query, w = ['o.bar_id=$1'], p = [me.bar_id];
  if (me.role !== 'admin') {   // staff: own orders + the unclaimed customer-QR queue. Never another staff's orders.
    p.push(me.id);
    w.push(`(o.taken_by_id=$${p.length} OR o.collected_by_id=$${p.length} OR (o.taken_by_id IS NULL AND o.source<>'MANUAL' AND o.status IN ('pending','served')))`);
  } else if (staff === 'none') w.push('o.taken_by_id IS NULL');
  else if (staff) { p.push(staff === 'me' ? me.id : staff); w.push(`o.taken_by_id=$${p.length}`); }
  if (status) { p.push(status); w.push(`o.status=$${p.length}`); }
  if (source) { p.push(source); w.push(`o.source=$${p.length}`); }
  dateRange('o.created_at', req.query, w, p);
  const o = order({ created: 'o.created_at', total: 'o.total', id: 'o.no' }, sort, dir, 'o.created_at');
  res.json((await pool.query(
    `SELECT o.id,o.no,o.source,o.customer,o.status,o.total,o.created_at,o.paid_at,o.pay_method,o.pay_ref,o.pay_claimed_at,o.cancel_reason,o.cancelled_at,
       t.name AS table_name, tu.username AS taken_by, cu.username AS collected_by, xu.username AS cancelled_by,
       (o.taken_by_id IS NULL AND o.source<>'MANUAL') AS unclaimed, (o.taken_by_id=$${p.push(me.id)}) AS mine,
       COALESCE(json_agg(json_build_object('name',pr.name,'qty',i.qty,'price',i.price)) FILTER (WHERE i.id IS NOT NULL),'[]') AS items
     FROM orders o LEFT JOIN bar_tables t ON t.id=o.table_id
     LEFT JOIN users tu ON tu.id=o.taken_by_id LEFT JOIN users cu ON cu.id=o.collected_by_id LEFT JOIN users xu ON xu.id=o.cancelled_by_id
     LEFT JOIN order_items i ON i.order_id=o.id LEFT JOIN products pr ON pr.id=i.product_id
     WHERE ${w.join(' AND ')} GROUP BY o.id, t.name, tu.username, cu.username, xu.username ORDER BY ${o} LIMIT 500`, p)).rows);
}));
const lockOrder = async (c, req) => {
  const { rows: [o] } = await c.query('SELECT * FROM orders WHERE id=$1 AND bar_id=$2 FOR UPDATE', [req.params.id, req.user.bar_id]);
  if (!o) throw err(404, 'Order not found');
  const me = req.user;
  if (me.role !== 'admin' && !(o.taken_by_id === me.id || (o.taken_by_id === null && o.source !== 'MANUAL'))) throw err(403, 'This order was taken by someone else');
  return o;
};
app.post('/api/orders/:id/accept', h(async (req, res) => {   // staff picks up a customer QR order
  res.json(await tx(async c => {
    const { rows: [o] } = await c.query('SELECT * FROM orders WHERE id=$1 AND bar_id=$2 FOR UPDATE', [req.params.id, req.user.bar_id]);
    if (!o) throw err(404, 'Order not found');
    if (o.source === 'MANUAL' || o.taken_by_id) throw err(409, 'Already taken by someone');
    if (['cancelled', 'paid'].includes(o.status)) throw err(409, `Order is ${o.status}`);
    await c.query('UPDATE orders SET taken_by_id=$1 WHERE id=$2', [req.user.id, o.id]);
    await audit(c, req.user.bar_id, 'order', o.id, 'UPDATE', { taken_by: null }, { taken_by: actor(req) }, actor(req));
    return { ok: true };
  }));
}));
app.patch('/api/orders/:id/status', h(async (req, res) => {
  const { status, pay_method, reason } = req.body, me = req.user;
  if (!['pending', 'served', 'paid', 'cancelled'].includes(status)) throw err(400, 'Invalid status');
  res.json(await tx(async c => {
    const old = await lockOrder(c, req);
    if (old.status === 'cancelled') throw err(409, 'Order is already cancelled');
    if (old.status === 'paid' && status !== 'cancelled') throw err(409, 'Paid orders cannot be changed');
    if (old.status === status) throw err(409, `Order is already ${status}`);
    const set = ['status=$1'], p = [status], add = (col, v) => { p.push(v); set.push(`${col}=$${p.length}`); };
    if (status === 'cancelled') {
      if (!(me.role === 'admin' || me.can_cancel)) throw err(403, 'You do not have permission to cancel orders. Ask your admin.');
      if (me.role !== 'admin' && old.status === 'paid') throw err(403, 'Only an admin can cancel a paid order');
      const why = String(reason || '').trim();
      if (why.length < 5) throw err(400, 'Please give a proper reason (at least 5 characters)');
      await restock(c, old.id);
      add('cancel_reason', why.slice(0, 300)); add('cancelled_by_id', me.id); set.push('cancelled_at=now()');
    }
    if (status === 'paid') {
      if (!['cash', 'upi', 'card'].includes(pay_method)) throw err(400, 'Choose how it was paid: cash, UPI or card');
      add('pay_method', pay_method); add('collected_by_id', me.id); set.push('paid_at=now()');
    }
    if (['served', 'paid'].includes(status) && !old.taken_by_id) add('taken_by_id', me.id);
    p.push(old.id);
    const { rows: [n] } = await c.query(`UPDATE orders SET ${set.join(',')} WHERE id=$${p.length} RETURNING status,pay_method,cancel_reason`, p);
    await audit(c, me.bar_id, 'order', old.id, 'UPDATE', { status: old.status }, { ...n, ...(status === 'paid' && { collected_by: me.username }) }, actor(req));
    return n;
  }));
}));
app.delete('/api/orders/:id', admin, h(async (req, res) => {
  await tx(async c => {
    const { rows: [o] } = await c.query('SELECT * FROM orders WHERE id=$1 AND bar_id=$2 FOR UPDATE', [req.params.id, req.user.bar_id]);
    if (!o) throw err(404, 'Order not found');
    const { rows: items } = await c.query('SELECT p.name AS product, i.qty, i.price FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=$1', [o.id]);
    if (o.status !== 'cancelled') await restock(c, o.id);
    await c.query('DELETE FROM orders WHERE id=$1 AND bar_id=$2', [o.id, req.user.bar_id]);
    await audit(c, req.user.bar_id, 'order', o.id, 'DELETE', { ...o, track_token: undefined, items }, null, actor(req));
  });
  res.json({ ok: true });
}));

// ---------- purchases ----------
app.get('/api/purchases', admin, h(async (req, res) => {
  const { q, sort, dir } = req.query, w = ['pu.bar_id=$1'], p = [req.user.bar_id];
  if (q) { p.push(`%${q}%`); w.push(`(pu.supplier ILIKE $${p.length} OR pr.name ILIKE $${p.length})`); }
  dateRange('pu.created_at', req.query, w, p);
  const o = order({ date: 'pu.created_at', product: 'pr.name', qty: 'pu.qty', cost: 'pu.qty*pu.unit_cost' }, sort, dir, 'pu.created_at');
  res.json((await pool.query(`SELECT pu.*, pr.name AS product FROM purchases pu JOIN products pr ON pr.id=pu.product_id WHERE ${w.join(' AND ')} ORDER BY ${o} LIMIT 500`, p)).rows);
}));
app.post('/api/purchases', admin, h(async (req, res) => {
  const { product_id, supplier, qty, unit_cost } = req.body, bar = req.user.bar_id;
  if (!(qty > 0) || unit_cost == null || unit_cost === '') throw err(400, 'Quantity and unit cost are required');
  res.status(201).json(await tx(async c => {
    const { rows: [old] } = await c.query('SELECT * FROM products WHERE id=$1 AND bar_id=$2 AND deleted_at IS NULL FOR UPDATE', [product_id, bar]);
    if (!old) throw err(404, 'Product not found');
    const { rows: [n] } = await c.query('UPDATE products SET stock=stock+$1, cost=$2, updated_at=now() WHERE id=$3 RETURNING *', [qty, unit_cost, old.id]);
    const { rows: [r] } = await c.query('INSERT INTO purchases(bar_id,product_id,supplier,qty,unit_cost,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [bar, old.id, supplier || null, qty, unit_cost, actor(req)]);
    await audit(c, bar, 'purchase', r.id, 'CREATE', null, { ...r, product: old.name }, actor(req));
    await audit(c, bar, 'product', old.id, 'UPDATE', old, n, actor(req));
    return r;
  }));
}));

// ---------- reports ----------
const num = v => Number(v || 0);
async function staffReport(bar, q, only) {
  const tw = ['bar_id=$1', "status<>'cancelled'"], tp = [bar]; dateRange('created_at', q, tw, tp);
  const cw = ['bar_id=$1', "status='paid'"], cp = [bar]; dateRange('paid_at', q, cw, cp);
  const xw = ['bar_id=$1', "status='cancelled'"], xp = [bar]; dateRange('cancelled_at', q, xw, xp);
  const [taken, coll, canc, users] = await Promise.all([
    pool.query(`SELECT taken_by_id id, COUNT(*)::int orders, COALESCE(SUM(total),0) sales FROM orders WHERE ${tw.join(' AND ')} GROUP BY 1`, tp),
    pool.query(`SELECT collected_by_id id, COALESCE(pay_method,'other') method, COUNT(*)::int n, COALESCE(SUM(total),0) amt FROM orders WHERE ${cw.join(' AND ')} GROUP BY 1,2`, cp),
    pool.query(`SELECT cancelled_by_id id, COUNT(*)::int n FROM orders WHERE ${xw.join(' AND ')} GROUP BY 1`, xp),
    pool.query('SELECT id,username,role FROM users WHERE bar_id=$1 ORDER BY username', [bar])]);
  const blank = { orders: 0, sales: 0, collected_orders: 0, collected: 0, cash: 0, upi: 0, card: 0, other: 0, cancelled: 0 };
  const rows = [...users.rows, { id: null, username: 'Customer / unassigned', role: '' }].map(u => {
    const r = { ...u, ...blank, key: u.id ?? 'none' };
    for (const t of taken.rows) if (t.id === u.id) { r.orders = t.orders; r.sales = num(t.sales); }
    for (const t of coll.rows) if (t.id === u.id) { r.collected_orders += t.n; r.collected += num(t.amt); r[t.method] += num(t.amt); }
    for (const t of canc.rows) if (t.id === u.id) r.cancelled = t.n;
    return r;
  }).filter(r => only ? r.id === only : (r.orders || r.collected || r.cancelled || r.id));
  const totals = rows.reduce((a, r) => { for (const k of Object.keys(blank)) a[k] += r[k]; return a; }, { ...blank });
  return { rows, totals };
}
app.get('/api/reports/mine', h(async (req, res) => res.json(await staffReport(req.user.bar_id, req.query, req.user.id))));
app.get('/api/reports/staff', admin, h(async (req, res) => res.json(await staffReport(req.user.bar_id, req.query, null))));
app.get('/api/reports/summary', admin, h(async (req, res) => {
  const bar = req.user.bar_id;
  const w = ['o.bar_id=$1', "o.status <> 'cancelled'"], p = [bar]; dateRange('o.created_at', req.query, w, p);
  const pw = ['bar_id=$1'], pp = [bar]; dateRange('created_at', req.query, pw, pp);
  const from = `FROM orders o JOIN order_items i ON i.order_id=o.id WHERE ${w.join(' AND ')}`;
  const [t, src, top, buy, low] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(i.qty*i.price),0) revenue, COALESCE(SUM(i.qty*i.cost),0) cogs, COUNT(DISTINCT o.id) orders ${from}`, p),
    pool.query(`SELECT o.source, COUNT(DISTINCT o.id) orders, SUM(i.qty*i.price) revenue ${from} GROUP BY o.source`, p),
    pool.query(`SELECT pr.name, SUM(i.qty) qty, SUM(i.qty*i.price) revenue FROM orders o JOIN order_items i ON i.order_id=o.id JOIN products pr ON pr.id=i.product_id WHERE ${w.join(' AND ')} GROUP BY pr.name ORDER BY revenue DESC LIMIT 5`, p),
    pool.query(`SELECT COALESCE(SUM(qty*unit_cost),0) spent FROM purchases WHERE ${pw.join(' AND ')}`, pp),
    pool.query('SELECT id,name,stock,min_stock FROM products WHERE bar_id=$1 AND deleted_at IS NULL AND stock<=min_stock ORDER BY stock', [bar])]);
  const r = t.rows[0];
  res.json({ revenue: r.revenue, cogs: r.cogs, profit: r.revenue - r.cogs, orders: r.orders, purchases: buy.rows[0].spent, by_source: src.rows, top: top.rows, low_stock: low.rows });
}));
app.get('/api/audit', admin, h(async (req, res) => {
  if (!req.bar.show_audit) throw err(403, 'Audit log is switched off in Settings');
  const { entity, action, dir } = req.query, w = ['bar_id=$1'], p = [req.user.bar_id];
  if (entity) { p.push(entity); w.push(`entity=$${p.length}`); }
  if (action) { p.push(action); w.push(`action=$${p.length}`); }
  dateRange('created_at', req.query, w, p);
  res.json((await pool.query(`SELECT * FROM audit_logs WHERE ${w.join(' AND ')} ORDER BY created_at ${dir === 'asc' ? 'ASC' : 'DESC'}, id DESC LIMIT 300`, p)).rows);
}));

// ---------- customer requests (call waiter / bill / enquiry) + feedback : staff side ----------
app.get('/api/requests/count', h(async (req, res) => res.json({ open: (await pool.query("SELECT count(*)::int n FROM service_requests WHERE bar_id=$1 AND status='open'", [req.user.bar_id])).rows[0].n })));
app.get('/api/requests', h(async (req, res) => {
  const p = [req.user.bar_id], w = ['r.bar_id=$1'];
  if (req.query.status) { p.push(req.query.status); w.push(`r.status=$${p.length}`); }
  res.json((await pool.query(`SELECT r.id,r.type,r.label,r.message,r.status,r.reply,r.created_at,r.updated_at,t.name table_name,u.username handled_by
    FROM service_requests r LEFT JOIN bar_tables t ON t.id=r.table_id LEFT JOIN users u ON u.id=r.handled_by_id
    WHERE ${w.join(' AND ')} ORDER BY (r.status='done'), r.created_at DESC LIMIT 200`, p)).rows);
}));
app.patch('/api/requests/:id', h(async (req, res) => {
  const { status, reply } = req.body;
  if (!['ack', 'done'].includes(status)) throw err(400, 'Invalid status');
  const { rows: [r] } = await pool.query(`UPDATE service_requests SET status=$1, reply=COALESCE($2,reply), handled_by_id=$3, updated_at=now()
    WHERE id=$4 AND bar_id=$5 RETURNING id,status`, [status, reply ? String(reply).slice(0, 300) : null, req.user.id, req.params.id, req.user.bar_id]);
  if (!r) throw err(404, 'Request not found');
  res.json(r);
}));
app.get('/api/feedback', admin, h(async (req, res) => {
  const rows = (await pool.query('SELECT f.id,f.rating,f.comment,f.name,f.created_at,o.no order_no FROM feedback f LEFT JOIN orders o ON o.id=f.order_id WHERE f.bar_id=$1 ORDER BY f.created_at DESC LIMIT 300', [req.user.bar_id])).rows;
  res.json({ rows, avg: rows.length ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : null });
}));

// ---------- backup: SuperAdmin always; Bar Admin only if SuperAdmin enabled it for that bar ----------
app.get('/api/backup/:fmt', h(async (req, res) => {
  const { user } = req, sup = user.role === 'superadmin', fmt = req.params.fmt;
  if (!['xlsx', 'bak'].includes(fmt)) throw err(404, 'Unknown format');
  if (!sup && !(user.role === 'admin' && req.bar.backup_enabled)) throw err(403, 'Backup is not enabled for your bar. Ask the platform owner.');
  limit(`backup:${user.id}`, 6, 60e3);
  let barId = sup ? (req.query.bar_id ? +req.query.bar_id : null) : user.bar_id, slug = 'all-bars';
  if (barId) { const b = (await pool.query('SELECT slug FROM bars WHERE id=$1', [barId])).rows[0]; if (!b) throw err(404, 'Bar not found'); slug = b.slug; }
  const buf = fmt === 'xlsx' ? await makeXlsx(barId) : await makeBak(barId, { hashes: sup });
  await audit(pool, sup ? null : user.bar_id, 'backup', barId, 'CREATE', null, { format: fmt, scope: slug }, actor(req));
  res.set({ 'Content-Type': fmt === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="barmanager-${slug}-${new Date().toISOString().slice(0, 10)}.${fmt}"` }).send(buf);
}));

// ---------- public (customer QR) ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The bar is ALWAYS derived from the table token or the bar slug in the QR. Nothing else can choose a bar.
async function pubBar({ token, b }) {
  let t = null, key, val;
  if (token) {
    if (!UUID.test(token)) throw err(404, 'This table QR is not valid');
    t = (await pool.query('SELECT id,name,bar_id FROM bar_tables WHERE token=$1 AND deleted_at IS NULL', [token])).rows[0];
    if (!t) throw err(404, 'This table QR is not valid');
    key = 'b.id'; val = t.bar_id;
  } else if (b) { key = 'b.slug'; val = String(b); }
  else {   // old printed Global QR (no bar in the link) keeps working only while the platform has exactly one bar
    const l = (await pool.query('SELECT id FROM bars ORDER BY id LIMIT 2')).rows;
    if (l.length !== 1) throw err(400, 'Please scan the QR code placed at the bar');
    key = 'b.id'; val = l[0].id;
  }
  const bar = (await pool.query(`SELECT b.id,b.name,b.slug,b.online_pay,b.upi_id,
      (b.active AND s.id IS NOT NULL AND (s.ends_on IS NULL OR s.ends_on >= CURRENT_DATE)) AS live
    FROM bars b LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE bar_id=b.id AND status='active' ORDER BY id DESC LIMIT 1) s ON true WHERE ${key}=$1`, [val])).rows[0];
  if (!bar) throw err(404, 'Bar not found');
  return { bar, table: t };
}
const live = ctx => { if (!ctx.bar.live) throw err(403, 'This bar is not taking requests right now'); return ctx; };
const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const upiLink = (bar, o) => `upi://pay?pa=${encodeURIComponent(bar.upi_id)}&pn=${encodeURIComponent(bar.name)}&am=${Number(o.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Order #' + o.no)}`;

app.get('/api/public/menu', h(async (req, res) => {
  const { bar, table } = live(await pubBar({ token: req.query.token, b: req.query.b }));
  const { rows } = await pool.query('SELECT id,name,category,price FROM products WHERE bar_id=$1 AND deleted_at IS NULL AND stock>0 ORDER BY category,name', [bar.id]);
  res.json({ bar: { name: bar.name, slug: bar.slug, pay_online: !!(bar.online_pay && bar.upi_id) }, table: table?.name || null, products: rows });
}));
app.post('/api/public/order', h(async (req, res) => {
  const { token, b, items } = req.body, customer = clean(req.body.customer, 60);
  const { bar, table } = live(await pubBar({ token, b }));
  limit(`ord:${req.ip}:${bar.id}`, 8, 10 * 60e3);
  if (!table && !customer) throw err(400, 'Enter your table number or name');
  if (!Array.isArray(items) || items.length > 30 || items.some(i => !(i.qty >= 1 && i.qty <= 20))) throw err(400, 'Max 30 items and 20 of each per order');
  const o = await tx(c => placeOrder(c, { bar_id: bar.id, source: table ? 'TABLE_QR' : 'GLOBAL_QR', table_id: table?.id, customer, items, taken_by_id: null, by: 'customer' }));
  res.status(201).json({ no: o.no, total: o.total, token: o.track_token });
}));
app.get('/api/public/track', h(async (req, res) => {
  const tokens = String(req.query.tokens || '').split(',').filter(t => UUID.test(t)).slice(0, 10);
  if (!tokens.length) return res.json([]);
  const { rows } = await pool.query(`SELECT o.track_token token,o.no,o.status,o.total,o.created_at,o.cancel_reason,o.pay_claimed_at,o.pay_method,t.name table_name,
      b.name bar_name,b.slug,b.online_pay,b.upi_id,
      COALESCE(json_agg(json_build_object('name',pr.name,'qty',i.qty,'price',i.price)) FILTER (WHERE i.id IS NOT NULL),'[]') items
    FROM orders o JOIN bars b ON b.id=o.bar_id LEFT JOIN bar_tables t ON t.id=o.table_id
    LEFT JOIN order_items i ON i.order_id=o.id LEFT JOIN products pr ON pr.id=i.product_id
    WHERE o.track_token = ANY($1::uuid[]) GROUP BY o.id,t.name,b.name,b.slug,b.online_pay,b.upi_id ORDER BY o.created_at DESC`, [tokens]);
  res.json(rows.map(({ online_pay, upi_id, ...o }) => ({ ...o,
    can_pay: !!(online_pay && upi_id && ['pending', 'served'].includes(o.status) && !o.pay_claimed_at),
    upi_link: online_pay && upi_id && ['pending', 'served'].includes(o.status) && !o.pay_claimed_at ? upiLink({ upi_id, name: o.bar_name }, o) : null })));
}));
// Customer says "I paid". This NEVER marks the order paid - staff must verify and collect.
app.post('/api/public/track/:token/claim', h(async (req, res) => {
  if (!UUID.test(req.params.token)) throw err(404, 'Order not found');
  limit(`claim:${req.ip}`, 10, 10 * 60e3);
  const r = await tx(async c => {
    const { rows: [o] } = await c.query(`SELECT o.id,o.bar_id,o.status,o.pay_claimed_at,b.online_pay FROM orders o JOIN bars b ON b.id=o.bar_id WHERE o.track_token=$1 FOR UPDATE OF o`, [req.params.token]);
    if (!o) throw err(404, 'Order not found');
    if (!o.online_pay) throw err(400, 'Online payment is not enabled here. Please pay at the counter.');
    if (!['pending', 'served'].includes(o.status) || o.pay_claimed_at) throw err(409, 'This order cannot be paid now');
    await c.query('UPDATE orders SET pay_claimed_at=now(), pay_ref=$1 WHERE id=$2', [clean(req.body.ref, 40) || null, o.id]);
    await audit(c, o.bar_id, 'order', o.id, 'UPDATE', { pay_claimed: false }, { pay_claimed: true, ref: clean(req.body.ref, 40) || null }, 'customer');
    return { ok: true };
  });
  res.json(r);
}));
app.post('/api/public/request', h(async (req, res) => {
  const { token, b, type } = req.body, message = clean(req.body.message, 500), customer = clean(req.body.customer, 60);
  if (!['waiter', 'bill', 'enquiry'].includes(type)) throw err(400, 'Invalid request type');
  const { bar, table } = live(await pubBar({ token, b }));
  const label = table?.name || customer;
  if (!label) throw err(400, 'Enter your table number or name');
  if (type === 'enquiry' && message.length < 3) throw err(400, 'Please type your question');
  limit(`rq:${req.ip}:${bar.id}`, 8, 10 * 60e3);
  if (type !== 'enquiry') limit(`rq:${bar.id}:${label}:${type}`, 1, 45e3);   // no spamming the same table
  const { rows: [r] } = await pool.query('INSERT INTO service_requests(bar_id,table_id,label,type,message) VALUES($1,$2,$3,$4,$5) RETURNING token', [bar.id, table?.id || null, label, type, message || null]);
  res.status(201).json({ token: r.token });
}));
app.get('/api/public/requests', h(async (req, res) => {
  const tokens = String(req.query.tokens || '').split(',').filter(t => UUID.test(t)).slice(0, 10);
  res.json(tokens.length ? (await pool.query('SELECT token,type,message,status,reply,created_at FROM service_requests WHERE token=ANY($1::uuid[]) ORDER BY created_at DESC', [tokens])).rows : []);
}));
app.post('/api/public/feedback', h(async (req, res) => {
  const { token, b, order_token } = req.body, rating = parseInt(req.body.rating);
  if (!(rating >= 1 && rating <= 5)) throw err(400, 'Choose a rating from 1 to 5');
  const { bar } = live(await pubBar({ token, b }));
  limit(`fb:${req.ip}`, 5, 3600e3);
  let orderId = null;
  if (order_token && UUID.test(order_token)) orderId = (await pool.query('SELECT id FROM orders WHERE track_token=$1 AND bar_id=$2', [order_token, bar.id])).rows[0]?.id || null;
  await pool.query('INSERT INTO feedback(bar_id,order_id,rating,comment,name) VALUES($1,$2,$3,$4,$5)', [bar.id, orderId, rating, clean(req.body.comment, 1000) || null, clean(req.body.name, 60) || null]);
  res.status(201).json({ ok: true });
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- start ----------
await init();
if (!(await pool.query("SELECT 1 FROM users WHERE role='superadmin' LIMIT 1")).rowCount) {
  const u = process.env.SUPER_USER || 'superadmin', pw = process.env.SUPER_PASS || 'super123';
  await pool.query("INSERT INTO users(username,password_hash,role) VALUES($1,$2,'superadmin')", [u, await bcrypt.hash(pw, 10)]);
  console.log(`Created SuperAdmin "${u}". Sign in and change the password (SuperAdmin → Account).`);
}
const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get(/^\/(?!api).*/, (_, r) => r.sendFile(dist + '/index.html')); }
const port = process.env.PORT || 4000;
app.listen(port, '0.0.0.0', () => console.log(`Bar API on :${port}`));
