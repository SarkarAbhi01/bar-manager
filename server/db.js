import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';

pg.types.setTypeParser(1082, v => v);   // DATE columns as 'YYYY-MM-DD' strings (no timezone shifts)
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', e => console.error('DB pool error:', e.message));   // an idle-connection error must not crash the server

const DEFAULT_PLANS = [
  ['Monthly', 'monthly', 1, 999, null], ['Quarterly', 'quarterly', 3, 2699, null], ['Half-yearly', 'half_yearly', 6, 4999, null],
  ['Yearly', 'yearly', 12, 8999, null], ['Commission (2% of paid sales)', 'commission', null, 0, 2]];

// Creates / upgrades all tables. Existing single-bar data is moved into one bar so nothing is lost.
export async function init() {
  await pool.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (!(await pool.query('SELECT 1 FROM plans LIMIT 1')).rowCount)
    for (const [n, k, m, p, c] of DEFAULT_PLANS) await pool.query('INSERT INTO plans(name,kind,months,price,commission_pct) VALUES($1,$2,$3,$4,$5)', [n, k, m, p, c]);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('LOCK TABLE users, bars IN SHARE ROW EXCLUSIVE MODE');
    const legacy = await c.query("SELECT (SELECT count(*) FROM users WHERE bar_id IS NULL AND role<>'superadmin')::int u, (SELECT count(*) FROM products WHERE bar_id IS NULL)::int p");
    if (legacy.rows[0].u || legacy.rows[0].p) {
      const { rows: [bar] } = await c.query("INSERT INTO bars(name,slug) VALUES('My Bar','my-bar') ON CONFLICT(slug) DO UPDATE SET name=bars.name RETURNING id");
      const { rows: [plan] } = await c.query("SELECT * FROM plans WHERE kind='yearly' ORDER BY id LIMIT 1");
      if (!(await c.query('SELECT 1 FROM subscriptions WHERE bar_id=$1', [bar.id])).rowCount)
        await c.query(`INSERT INTO subscriptions(bar_id,plan_id,plan_name,kind,months,price,starts_on,ends_on,note,created_by)
          VALUES($1,$2,$3,$4,$5,0,CURRENT_DATE,(CURRENT_DATE + interval '12 months')::date - 1,'Migrated from single-bar version (free 12 months - SuperAdmin can change)','system')`, [bar.id, plan.id, plan.name, plan.kind, plan.months]);
      for (const t of ['products', 'bar_tables', 'purchases', 'orders', 'audit_logs']) await c.query(`UPDATE ${t} SET bar_id=$1 WHERE bar_id IS NULL AND ${t === 'audit_logs' ? "entity<>'platform'" : 'TRUE'}`, [bar.id]);
      await c.query("UPDATE users SET bar_id=$1 WHERE bar_id IS NULL AND role<>'superadmin'", [bar.id]);
      await c.query('UPDATE orders SET no=id WHERE no IS NULL');
      await c.query('UPDATE orders SET paid_at=created_at WHERE status=\'paid\' AND paid_at IS NULL');
      await c.query('UPDATE orders o SET taken_by_id=u.id FROM users u WHERE o.taken_by_id IS NULL AND o.created_by=u.username AND u.bar_id=o.bar_id');
      await c.query('UPDATE bars SET order_seq=(SELECT COALESCE(max(no),0) FROM orders WHERE bar_id=bars.id) WHERE id=$1', [bar.id]);
      console.log('Upgraded: existing data moved into bar "My Bar" (SuperAdmin can rename it).');
    }
    for (const t of ['products', 'bar_tables', 'purchases', 'orders']) await c.query(`ALTER TABLE ${t} ALTER COLUMN bar_id SET NOT NULL`);
    await c.query('ALTER TABLE orders ALTER COLUMN no SET NOT NULL');
    await c.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bar_chk');
    await c.query("ALTER TABLE users ADD CONSTRAINT users_bar_chk CHECK((role='superadmin') = (bar_id IS NULL))");
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_tables_bar_name ON bar_tables(bar_id,name) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_tables_token ON bar_tables(token);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_bar_no ON orders(bar_id,no);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_track ON orders(track_token);
      CREATE INDEX IF NOT EXISTS ix_orders_bar ON orders(bar_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_orders_taken ON orders(bar_id, taken_by_id);
      CREATE INDEX IF NOT EXISTS ix_orders_collected ON orders(bar_id, collected_by_id, paid_at);
      CREATE INDEX IF NOT EXISTS ix_products_bar ON products(bar_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS ix_purchases_bar ON purchases(bar_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_audit_bar ON audit_logs(bar_id, entity, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_users_bar ON users(bar_id);
      CREATE INDEX IF NOT EXISTS ix_sub_bar ON subscriptions(bar_id, status);
      CREATE INDEX IF NOT EXISTS ix_req_bar ON service_requests(bar_id, status, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_req_token ON service_requests(token);
      CREATE INDEX IF NOT EXISTS ix_feedback_bar ON feedback(bar_id, created_at DESC);`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
