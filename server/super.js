// SuperAdmin (platform owner) API - mounted at /api/super, guarded in index.js (role must be superadmin)
import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { h, err, actor, audit, tx } from './util.js';

const r = express.Router();
r.use((req, res, next) => req.user?.role === 'superadmin' ? next() : res.status(403).json({ error: 'SuperAdmin only' }));
const KIND_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'bar';
const pct = v => (v === '' || v == null) ? null : Number(v);
const pos = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw err(400, `${what} must be a number 0 or more`); return n; };

function planFields(b) {
  const kind = b.kind;
  if (!['monthly', 'quarterly', 'half_yearly', 'yearly', 'long_term', 'commission'].includes(kind)) throw err(400, 'Invalid plan type');
  if (!String(b.name || '').trim()) throw err(400, 'Plan name is required');
  const months = kind === 'commission' ? null : (KIND_MONTHS[kind] ?? parseInt(b.months));
  if (kind !== 'commission' && !(months > 0)) throw err(400, 'Months must be 1 or more');
  const commission_pct = kind === 'commission' ? pct(b.commission_pct) : null;
  if (kind === 'commission' && !(commission_pct >= 0 && commission_pct <= 100)) throw err(400, 'Commission % must be between 0 and 100');
  return { name: b.name.trim(), kind, months, price: kind === 'commission' ? 0 : pos(b.price, 'Price'), commission_pct };
}

/* ---- plans ---- (editing a plan only affects FUTURE assignments; running subscriptions keep their own snapshot) */
r.get('/plans', h(async (_, res) => res.json((await pool.query('SELECT * FROM plans ORDER BY active DESC, months NULLS LAST, id')).rows)));
r.post('/plans', h(async (req, res) => {
  const f = planFields(req.body);
  res.status(201).json(await tx(async c => {
    const { rows: [p] } = await c.query('INSERT INTO plans(name,kind,months,price,commission_pct) VALUES($1,$2,$3,$4,$5) RETURNING *', [f.name, f.kind, f.months, f.price, f.commission_pct]);
    await audit(c, null, 'plan', p.id, 'CREATE', null, p, actor(req)); return p;
  }));
}));
r.put('/plans/:id', h(async (req, res) => {
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query('SELECT * FROM plans WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!old) throw err(404, 'Plan not found');
    const f = planFields({ ...old, ...req.body });
    const { rows: [p] } = await c.query('UPDATE plans SET name=$1,kind=$2,months=$3,price=$4,commission_pct=$5,active=$6 WHERE id=$7 RETURNING *', [f.name, f.kind, f.months, f.price, f.commission_pct, req.body.active ?? old.active, old.id]);
    await audit(c, null, 'plan', old.id, 'UPDATE', old, p, actor(req)); return p;
  }));
}));

/* ---- bars ---- */
const BAR_LIST = `SELECT b.id,b.name,b.slug,b.active,b.show_audit,b.backup_enabled,b.online_pay,b.created_at,
    s.id sub_id,s.plan_name,s.kind,s.months,s.price,s.commission_pct,s.starts_on,s.ends_on,
    CASE WHEN s.id IS NULL THEN 'none' WHEN s.ends_on IS NOT NULL AND s.ends_on < CURRENT_DATE THEN 'expired' ELSE 'active' END sub_status,
    (SELECT string_agg(username, ', ' ORDER BY id) FROM users WHERE bar_id=b.id AND role='admin') admins,
    (SELECT count(*)::int FROM users WHERE bar_id=b.id AND role='staff') staff_count,
    (SELECT COALESCE(SUM(total),0) FROM orders WHERE bar_id=b.id AND status='paid' AND s.kind='commission' AND paid_at >= s.starts_on) commission_base
  FROM bars b LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE bar_id=b.id AND status='active' ORDER BY id DESC LIMIT 1) s ON true`;
const withDue = b => ({ ...b, commission_due: b.kind === 'commission' ? Math.round(Number(b.commission_base) * Number(b.commission_pct || 0)) / 100 : null });
r.get('/bars', h(async (_, res) => res.json((await pool.query(BAR_LIST + ' ORDER BY b.id')).rows.map(withDue))));

async function newSubscription(c, barId, plan, o, by) {
  await c.query("UPDATE subscriptions SET status='ended', ends_on=LEAST(COALESCE(ends_on, CURRENT_DATE), CURRENT_DATE) WHERE bar_id=$1 AND status='active'", [barId]);
  const months = o.months ?? plan.months, price = o.price ?? plan.price, cp = plan.kind === 'commission' ? (o.commission_pct ?? plan.commission_pct) : null;
  const { rows: [s] } = await c.query(`INSERT INTO subscriptions(bar_id,plan_id,plan_name,kind,months,price,commission_pct,starts_on,ends_on,note,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date,CURRENT_DATE), CASE WHEN $5::int IS NULL THEN NULL ELSE ((COALESCE($8::date,CURRENT_DATE) + make_interval(months=>$5::int))::date - 1) END, $9,$10) RETURNING *`,
    [barId, plan.id, plan.name, plan.kind, plan.kind === 'commission' ? null : months, plan.kind === 'commission' ? 0 : price, cp, o.starts_on || null, o.note || null, by]);
  await audit(c, null, 'subscription', s.id, 'CREATE', null, { bar_id: barId, ...s }, by);
  return s;
}
const getPlan = async (c, id) => { const { rows: [p] } = await c.query('SELECT * FROM plans WHERE id=$1 AND active', [id]); if (!p) throw err(400, 'Choose an active plan'); return p; };

r.post('/bars', h(async (req, res) => {
  const { name, admin_username, admin_password, plan_id, starts_on } = req.body;
  if (!name?.trim()) throw err(400, 'Bar name is required');
  if (!admin_username?.trim() || String(admin_password || '').length < 6) throw err(400, 'Admin username and a password of 6+ characters are required');
  res.status(201).json(await tx(async c => {
    const plan = await getPlan(c, plan_id);
    let slug = slugify(name);
    if ((await c.query('SELECT 1 FROM bars WHERE slug=$1', [slug])).rowCount) slug += '-' + Math.random().toString(36).slice(2, 6);
    const { rows: [bar] } = await c.query('INSERT INTO bars(name,slug) VALUES($1,$2) RETURNING *', [name.trim(), slug]);
    const { rows: [u] } = await c.query("INSERT INTO users(username,password_hash,role,bar_id) VALUES($1,$2,'admin',$3) RETURNING id,username", [admin_username.trim(), await bcrypt.hash(admin_password, 10), bar.id]);
    await newSubscription(c, bar.id, plan, { starts_on }, actor(req));
    await audit(c, null, 'bar', bar.id, 'CREATE', null, { ...bar, admin: u.username, plan: plan.name }, actor(req));
    await audit(c, bar.id, 'user', u.id, 'CREATE', null, { id: u.id, username: u.username, role: 'admin' }, actor(req));
    return { id: bar.id, slug };
  }));
}));
r.get('/bars/:id', h(async (req, res) => {
  const bar = (await pool.query(BAR_LIST + ' WHERE b.id=$1', [req.params.id])).rows[0];
  if (!bar) throw err(404, 'Bar not found');
  const [users, subs] = await Promise.all([
    pool.query('SELECT id,username,role,active,can_cancel FROM users WHERE bar_id=$1 ORDER BY role,id', [bar.id]),
    pool.query('SELECT * FROM subscriptions WHERE bar_id=$1 ORDER BY id DESC', [bar.id])]);
  res.json({ bar: withDue(bar), users: users.rows, subscriptions: subs.rows });
}));
r.put('/bars/:id', h(async (req, res) => {
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query('SELECT * FROM bars WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!old) throw err(404, 'Bar not found');
    const n = { name: req.body.name?.trim() || old.name, active: req.body.active ?? old.active, show_audit: req.body.show_audit ?? old.show_audit, backup_enabled: req.body.backup_enabled ?? old.backup_enabled };
    await c.query('UPDATE bars SET name=$1,active=$2,show_audit=$3,backup_enabled=$4 WHERE id=$5', [n.name, !!n.active, !!n.show_audit, !!n.backup_enabled, old.id]);
    await audit(c, null, 'bar', old.id, 'UPDATE', { name: old.name, active: old.active, show_audit: old.show_audit, backup_enabled: old.backup_enabled }, n, actor(req));
    return { ok: true };
  }));
}));
// extra Admin credentials for a bar, or reset / disable any user of that bar
r.post('/bars/:id/admins', h(async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || String(password || '').length < 6) throw err(400, 'Username and a password of 6+ characters are required');
  res.status(201).json(await tx(async c => {
    if (!(await c.query('SELECT 1 FROM bars WHERE id=$1', [req.params.id])).rowCount) throw err(404, 'Bar not found');
    const { rows: [u] } = await c.query("INSERT INTO users(username,password_hash,role,bar_id) VALUES($1,$2,'admin',$3) RETURNING id,username", [username.trim(), await bcrypt.hash(password, 10), req.params.id]);
    await audit(c, null, 'user', u.id, 'CREATE', null, { bar_id: +req.params.id, username: u.username, role: 'admin' }, actor(req));
    return u;
  }));
}));
r.put('/users/:id', h(async (req, res) => {
  const { password, active } = req.body;
  if (password && password.length < 6) throw err(400, 'Password must be 6+ characters');
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query("SELECT * FROM users WHERE id=$1 AND role<>'superadmin' FOR UPDATE", [req.params.id]);
    if (!old) throw err(404, 'User not found');
    await c.query('UPDATE users SET active=$1, password_hash=$2 WHERE id=$3', [active ?? old.active, password ? await bcrypt.hash(password, 10) : old.password_hash, old.id]);
    await audit(c, null, 'user', old.id, 'UPDATE', { active: old.active }, { active: active ?? old.active, ...(password && { password: 'reset by SuperAdmin' }) }, actor(req));
    return { ok: true };
  }));
}));

/* ---- subscriptions: assign a new plan, or adjust the running one (shorten = "decrease", or extend) ---- */
r.post('/bars/:id/subscription', h(async (req, res) => {
  const { plan_id, starts_on, price, commission_pct, months, note } = req.body;
  res.status(201).json(await tx(async c => {
    if (!(await c.query('SELECT 1 FROM bars WHERE id=$1 FOR UPDATE', [req.params.id])).rowCount) throw err(404, 'Bar not found');
    const plan = await getPlan(c, plan_id);
    if (months != null && months !== '' && !(parseInt(months) > 0)) throw err(400, 'Months must be 1 or more');
    return newSubscription(c, +req.params.id, plan, { starts_on, price: price === '' || price == null ? null : pos(price, 'Price'), commission_pct: pct(commission_pct), months: months ? parseInt(months) : null, note }, actor(req));
  }));
}));
r.patch('/subscriptions/:id', h(async (req, res) => {
  const { ends_on, shift_months, price, commission_pct, note } = req.body;
  res.json(await tx(async c => {
    const { rows: [old] } = await c.query("SELECT * FROM subscriptions WHERE id=$1 AND status='active' FOR UPDATE", [req.params.id]);
    if (!old) throw err(404, 'Active subscription not found');
    if (!String(note || '').trim()) throw err(400, 'Please write a reason / note for this change');
    let end = old.ends_on;
    if (old.kind !== 'commission') {
      if (ends_on) end = ends_on;
      else if (shift_months) end = (await c.query("SELECT (($1::date + make_interval(months=>$2::int))::date) d", [old.ends_on, parseInt(shift_months)])).rows[0].d;
    }
    const { rows: [s] } = await c.query('UPDATE subscriptions SET ends_on=$1, starts_on=LEAST(starts_on, COALESCE($1::date, starts_on)), price=$2, commission_pct=$3, note=$4 WHERE id=$5 RETURNING *',
      [end, price === undefined || price === '' ? old.price : pos(price, 'Price'), old.kind === 'commission' && commission_pct !== undefined ? pct(commission_pct) : old.commission_pct, String(note).trim().slice(0, 300), old.id]);
    await audit(c, null, 'subscription', old.id, 'UPDATE', { ends_on: old.ends_on, price: old.price, commission_pct: old.commission_pct }, { ends_on: s.ends_on, price: s.price, commission_pct: s.commission_pct, note: s.note }, actor(req));
    return s;
  }));
}));

/* ---- platform log ---- */
r.get('/log', h(async (_, res) => res.json((await pool.query('SELECT * FROM audit_logs WHERE bar_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 300')).rows)));
export default r;
