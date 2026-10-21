import QRCode from 'qrcode';
import { pool } from './db.js';

export const err = (status, message) => Object.assign(new Error(message), { status });
export const h = fn => (req, res) => fn(req, res).catch(e => {
  if (e.code === '23505') e = err(409, 'That name / username already exists');
  else if (e.code === '22P02' || e.code === '22007' || e.code === '22008') e = err(400, 'Invalid value in request');
  else if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});
export const actor = req => req.user?.username || 'system';
// bar_id is ALWAYS the second argument: NULL = platform (SuperAdmin) log, otherwise the bar the action belongs to
export const audit = (c, barId, entity, id, action, oldD, newD, by) =>
  c.query('INSERT INTO audit_logs(bar_id,entity,entity_id,action,old_data,new_data,actor) VALUES($1,$2,$3,$4,$5,$6,$7)', [barId, entity, id, action, oldD, newD, by]);
export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export const dateRange = (col, q, w, p) => {
  if (q.from) { p.push(q.from); w.push(`${col} >= $${p.length}::date`); }
  if (q.to) { p.push(q.to); w.push(`${col} < $${p.length}::date + 1`); }
};
export const order = (map, sort, dir, def) => `${map[sort] || def} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
export const qr = url => QRCode.toDataURL(url, { width: 400, margin: 1 });

// tiny in-memory rate limiter (per process). Use Redis / express-rate-limit if you run several servers.
const hits = new Map();
export function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) throw err(429, 'Please wait a little before trying again');
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < ms)) hits.delete(k);
}
