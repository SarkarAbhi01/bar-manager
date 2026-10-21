CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Platform (SuperAdmin) =====
CREATE TABLE IF NOT EXISTS bars(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 active BOOLEAN NOT NULL DEFAULT true,
 show_audit BOOLEAN NOT NULL DEFAULT true,        -- Bar Admin can hide/show the Audit log
 backup_enabled BOOLEAN NOT NULL DEFAULT false,   -- SuperAdmin enables backups for this bar
 online_pay BOOLEAN NOT NULL DEFAULT false,       -- customer "Pay now" (UPI) on phones/tablets
 upi_id TEXT, order_seq INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS plans(
 id SERIAL PRIMARY KEY, name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('monthly','quarterly','half_yearly','yearly','long_term','commission')),
 months INT CHECK(months IS NULL OR months>0), price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(price>=0),
 commission_pct NUMERIC(5,2) CHECK(commission_pct IS NULL OR (commission_pct>=0 AND commission_pct<=100)),
 active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS subscriptions(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE,
 plan_id INT REFERENCES plans ON DELETE SET NULL, plan_name TEXT NOT NULL, kind TEXT NOT NULL,
 months INT, price NUMERIC(12,2) NOT NULL DEFAULT 0, commission_pct NUMERIC(5,2),
 starts_on DATE NOT NULL DEFAULT CURRENT_DATE, ends_on DATE,   -- NULL = no end (commission plan)
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','ended')), note TEXT,
 created_by TEXT, created_at TIMESTAMPTZ DEFAULT now());

-- ===== Bar data (every row belongs to one bar) =====
CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'staff', active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS products(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
 price NUMERIC(10,2) NOT NULL CHECK(price>=0), cost NUMERIC(10,2) NOT NULL DEFAULT 0,
 stock INT NOT NULL DEFAULT 0 CHECK(stock>=0), min_stock INT NOT NULL DEFAULT 5,
 created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS bar_tables(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, name TEXT NOT NULL, token UUID NOT NULL DEFAULT gen_random_uuid(), deleted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS orders(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, no INT NOT NULL DEFAULT 0,
 source TEXT NOT NULL CHECK(source IN('GLOBAL_QR','TABLE_QR','MANUAL')),
 table_id INT REFERENCES bar_tables(id), customer TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','served','paid','cancelled')),
 total NUMERIC(10,2) NOT NULL DEFAULT 0, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items(
 id SERIAL PRIMARY KEY, order_id INT NOT NULL REFERENCES orders ON DELETE CASCADE,
 product_id INT NOT NULL REFERENCES products, qty INT NOT NULL CHECK(qty>0),
 price NUMERIC(10,2) NOT NULL, cost NUMERIC(10,2) NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchases(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, product_id INT NOT NULL REFERENCES products, supplier TEXT,
 qty INT NOT NULL CHECK(qty>0), unit_cost NUMERIC(10,2) NOT NULL, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(
 id BIGSERIAL PRIMARY KEY, bar_id INT REFERENCES bars ON DELETE CASCADE, entity TEXT NOT NULL, entity_id INT,   -- bar_id NULL = platform (SuperAdmin) log
 action TEXT NOT NULL CHECK(action IN('CREATE','UPDATE','DELETE')),
 old_data JSONB, new_data JSONB, actor TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS service_requests(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, table_id INT REFERENCES bar_tables(id), label TEXT,
 type TEXT NOT NULL CHECK(type IN('waiter','bill','enquiry')), message TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','ack','done')), reply TEXT,
 handled_by_id INT REFERENCES users ON DELETE SET NULL, token UUID NOT NULL DEFAULT gen_random_uuid(),
 created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS feedback(
 id SERIAL PRIMARY KEY, bar_id INT NOT NULL REFERENCES bars ON DELETE CASCADE, order_id INT REFERENCES orders ON DELETE SET NULL,
 rating INT NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT, name TEXT, created_at TIMESTAMPTZ DEFAULT now());

-- ===== Upgrade from the single-bar version (safe to run every start) =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_cancel BOOLEAN NOT NULL DEFAULT false;  -- Bar Admin lets this staff cancel orders
ALTER TABLE products ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE bar_tables ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bar_id INT REFERENCES bars ON DELETE CASCADE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS no INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS taken_by_id INT REFERENCES users ON DELETE SET NULL;      -- staff/admin who took the order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_by_id INT REFERENCES users ON DELETE SET NULL;  -- who collected the money
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_ref TEXT;             -- UPI reference typed by the customer
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_claimed_at TIMESTAMPTZ; -- customer tapped "I have paid" (staff must verify)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by_id INT REFERENCES users ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_pay_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_pay_method_check CHECK(pay_method IS NULL OR pay_method IN('cash','upi','card'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN('superadmin','admin','staff'));
DROP INDEX IF EXISTS ux_bar_tables_name;
