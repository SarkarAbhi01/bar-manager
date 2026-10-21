import ExcelJS from 'exceljs';
import { pool } from './db.js';

// Every table, how to select it for one bar (barId given) or for the whole platform (barId null).
// Order matters for the .bak (parents before children).
const T = [
  ['bars', 'SELECT * FROM bars WHERE ($1::int IS NULL OR id=$1) ORDER BY id'],
  ['plans', 'SELECT * FROM plans ORDER BY id'],
  ['subscriptions', 'SELECT * FROM subscriptions WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['users', null],  // handled in load(): platform = all users, bar = that bar's users
  ['bar_tables', 'SELECT * FROM bar_tables WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['products', 'SELECT * FROM products WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['orders', 'SELECT * FROM orders WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['order_items', 'SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ($1::int IS NULL OR o.bar_id=$1) ORDER BY i.id'],
  ['purchases', 'SELECT * FROM purchases WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['service_requests', 'SELECT * FROM service_requests WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['feedback', 'SELECT * FROM feedback WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id'],
  ['audit_logs', 'SELECT * FROM audit_logs WHERE ($1::int IS NULL OR bar_id=$1) ORDER BY id']];
const HAS_SERIAL = new Set(T.map(t => t[0]));

// hashes=false blanks password hashes (Bar Admin downloads): the file still restores, passwords must then be reset.
async function load(barId, { hashes }) {
  const out = {};
  for (const [name, sql] of T) {
    if (name === 'users') {
      const r = barId == null ? await pool.query('SELECT * FROM users ORDER BY id') : await pool.query('SELECT * FROM users WHERE bar_id=$1 ORDER BY id', [barId]);
      out.users = hashes ? r.rows : r.rows.map(u => ({ ...u, password_hash: '' }));
    } else out[name] = (await pool.query(sql, sql.includes('$1') ? [barId] : [])).rows;
  }
  return out;
}

/* ---------- .bak : plain SQL script (restore with `node restore.js file.bak` or psql -f file.bak) ---------- */
const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export async function makeBak(barId, { hashes }) {
  const d = await load(barId, { hashes }), L = [];
  L.push('-- Bar Manager backup', `-- scope: ${barId == null ? 'ALL BARS (platform)' : 'bar #' + barId}`, `-- created: ${new Date().toISOString()}`,
    hashes ? '-- contains password hashes - keep this file private' : '-- password hashes removed: reset passwords after restoring', 'BEGIN;');
  for (const [name] of T) for (const r of d[name] || []) {
    const cols = Object.keys(r);
    L.push(`INSERT INTO ${name}(${cols.join(',')}) VALUES(${cols.map(c => lit(r[c])).join(',')});`);
  }
  for (const n of HAS_SERIAL) if (d[n]) L.push(`SELECT setval(pg_get_serial_sequence('${n}','id'), COALESCE((SELECT max(id) FROM ${n}),1), (SELECT count(*)>0 FROM ${n}));`);
  L.push('COMMIT;', '');
  return Buffer.from(L.join('\n'), 'utf8');
}

/* ---------- Excel ---------- */
const HIDE = new Set(['password_hash', 'token', 'track_token']);
export async function makeXlsx(barId) {
  const d = await load(barId, { hashes: false }), wb = new ExcelJS.Workbook();
  wb.creator = 'Bar Manager'; wb.created = new Date();
  const names = new Map(d.users?.map(u => [u.id, u.username]));
  // friendlier orders sheet: items + who took / collected
  const items = new Map(), prod = new Map((d.products || []).map(p => [p.id, p.name]));
  for (const i of d.order_items) items.set(i.order_id, [...(items.get(i.order_id) || []), `${i.qty}x ${prod.get(i.product_id) || i.product_id}`]);
  d.orders = d.orders.map(o => ({ ...o, items: (items.get(o.id) || []).join('; '), taken_by: names.get(o.taken_by_id) || (o.taken_by_id ? '' : 'customer / unassigned'), collected_by: names.get(o.collected_by_id) || '', cancelled_by: names.get(o.cancelled_by_id) || '' }));
  for (const [name] of T) {
    if (!d[name]) continue;
    const rows = d[name], ws = wb.addWorksheet(name.replace('_', ' ').slice(0, 31));
    const cols = rows.length ? Object.keys(rows[0]).filter(k => !HIDE.has(k)) : [];
    ws.columns = cols.map(k => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 4)) }));
    ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(Object.fromEntries(cols.map(k => [k, r[k] !== null && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k]])));
    ws.autoFilter = cols.length ? { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } } : undefined;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
