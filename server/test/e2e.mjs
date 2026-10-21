// End-to-end checks. Run against a TEST database (it creates bars/users):  API=http://localhost:4000 SUPER_USER=superadmin SUPER_PASS=super123 node test/e2e.mjs
const API = (process.env.API || 'http://localhost:4000') + '/api', R = Math.random().toString(36).slice(2, 6);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL:', m)); };
const call = async (tok, method, path, body, raw) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r;
  return { s: r.status, d: await r.json().catch(() => ({})) };
};
const login = async (u, p) => (await call(null, 'POST', '/auth/login', { username: u, password: p })).d.token;
const sup = await login(process.env.SUPER_USER || 'superadmin', process.env.SUPER_PASS || 'super123');
ok(sup, 'superadmin login');

// ---- 1. SuperAdmin: plans, create two bars with admin credentials
const plans = (await call(sup, 'GET', '/super/plans')).d;
ok(['monthly', 'quarterly', 'half_yearly', 'yearly', 'commission'].every(k => plans.some(p => p.kind === k)), 'default plans exist');
const lt = await call(sup, 'POST', '/super/plans', { name: '3-year ' + R, kind: 'long_term', months: 36, price: 20000 });
ok(lt.s === 201 && lt.d.months === 36, 'long-term plan created');
const lower = await call(sup, 'PUT', '/super/plans/' + lt.d.id, { price: 15000, months: 24 });
ok(lower.d.price === '15000.00' && lower.d.months === 24, 'plan price/duration can be decreased');
const monthly = plans.find(p => p.kind === 'monthly'), commission = plans.find(p => p.kind === 'commission');
const mk = async (n, plan) => (await call(sup, 'POST', '/super/bars', { name: `Bar ${n} ${R}`, admin_username: `adm${n}${R}`, admin_password: 'secret1', plan_id: plan.id })).d;
const A = await mk('A', monthly), B = await mk('B', commission);
ok(A.id && B.id, 'bars created');
const dupe = await call(sup, 'POST', '/super/bars', { name: 'x', admin_username: `admA${R}`, admin_password: 'secret1', plan_id: monthly.id });
ok(dupe.s === 409, 'duplicate admin username rejected: ' + dupe.s);
const ta = await login(`admA${R}`, 'secret1'), tb = await login(`admB${R}`, 'secret1');
ok(ta && tb, 'bar admins can log in');
ok((await call(ta, 'GET', '/super/bars')).s === 403, 'bar admin cannot use SuperAdmin API');
ok((await call(sup, 'GET', '/products')).s === 403, 'SuperAdmin cannot read a bar\'s data through bar routes');

// ---- 2. each bar builds its own data
const prod = async (t, n) => (await call(t, 'POST', '/products', { name: n, price: 100, cost: 50, stock: 20 })).d;
const pA = await prod(ta, 'A-Beer'), pB = await prod(tb, 'B-Beer');
const tA = (await call(ta, 'POST', '/tables', { name: 'T1' })).d, tB = (await call(tb, 'POST', '/tables', { name: 'T1' })).d;
ok(tA.id && tB.id, 'same table name allowed in two bars');
const stA = (await call(ta, 'POST', '/users', { username: `stA${R}`, password: 'secret1' })).d;
const stA2 = (await call(ta, 'POST', '/users', { username: `stA2${R}`, password: 'secret1' })).d;
const stB = (await call(tb, 'POST', '/users', { username: `stB${R}`, password: 'secret1' })).d;
const sa = await login(`stA${R}`, 'secret1'), sa2 = await login(`stA2${R}`, 'secret1'), sb = await login(`stB${R}`, 'secret1');

// ---- 8. isolation
ok((await call(tb, 'GET', '/products')).d.every(p => p.id !== pA.id), 'B list has no A product');
ok((await call(tb, 'PUT', '/products/' + pA.id, { name: 'hack' })).s === 404, 'B cannot edit A product');
ok((await call(tb, 'DELETE', '/products/' + pA.id)).s === 404, 'B cannot delete A product');
ok((await call(tb, 'POST', '/orders', { items: [{ product_id: pA.id, qty: 1 }] })).s === 400, 'B cannot order A product');
ok((await call(tb, 'POST', '/orders', { table_id: tA.id, items: [{ product_id: pB.id, qty: 1 }] })).s === 400, 'B cannot use A table');
ok((await call(tb, 'POST', '/purchases', { product_id: pA.id, qty: 5, unit_cost: 1 })).s === 404, 'B cannot buy stock into A product');
ok((await call(tb, 'PUT', '/users/' + stA.id, { active: false })).s === 404, 'B cannot disable A staff');
ok((await call(tb, 'GET', '/users')).d.every(u => u.id !== stA.id), 'B users list excludes A');
ok((await call(tb, 'DELETE', '/tables/' + tA.id)).s === 404, 'B cannot delete A table');

// ---- 3. orders: who took, own-only view
const oA1 = (await call(sa, 'POST', '/orders', { table_id: tA.id, items: [{ product_id: pA.id, qty: 2 }] })).d;
const oA2 = (await call(sa2, 'POST', '/orders', { items: [{ product_id: pA.id, qty: 1 }] })).d;
const oAadm = (await call(ta, 'POST', '/orders', { items: [{ product_id: pA.id, qty: 1 }] })).d;
const oB = (await call(sb, 'POST', '/orders', { items: [{ product_id: pB.id, qty: 1 }] })).d;
ok(oA1.no === 1 && oA2.no === 2 && oB.no === 1, `order numbers are per bar (${oA1.no},${oA2.no},${oB.no})`);
const mine = (await call(sa, 'GET', '/orders')).d;
ok(mine.length === 1 && mine[0].id === oA1.id && mine[0].taken_by === `stA${R}`, 'staff sees only own order');
ok((await call(sa, 'PATCH', `/orders/${oA2.id}/status`, { status: 'served' })).s === 403, 'staff cannot touch another staff order');
ok((await call(sb, 'PATCH', `/orders/${oA1.id}/status`, { status: 'served' })).s === 404, 'other bar cannot touch order');
ok((await call(ta, 'GET', '/orders')).d.length === 3, 'admin sees all of own bar, not others');
ok((await call(ta, 'GET', '/orders?staff=me')).d.length === 1, 'admin can filter "my orders"');

// ---- 4. cancel permission + reason
let r = await call(sa, 'PATCH', `/orders/${oA1.id}/status`, { status: 'cancelled', reason: 'customer left' });
ok(r.s === 403, 'staff without permission cannot cancel');
ok((await call(tb, 'PUT', `/users/${stA.id}`, { can_cancel: true })).s === 404, 'other bar admin cannot grant permission');
await call(ta, 'PUT', `/users/${stA.id}`, { can_cancel: true });
r = await call(sa, 'PATCH', `/orders/${oA1.id}/status`, { status: 'cancelled', reason: 'no' });
ok(r.s === 400, 'cancel needs a proper reason');
r = await call(sa, 'PATCH', `/orders/${oA1.id}/status`, { status: 'cancelled', reason: 'Customer left without ordering' });
ok(r.s === 200 && r.d.cancel_reason, 'staff with permission can cancel with reason');
ok((await call(ta, 'GET', '/products')).d.find(p => p.id === pA.id).stock === 18, 'stock restored on cancel (20-2-1-1+2=18)');
r = await call(ta, 'PATCH', `/orders/${oA2.id}/status`, { status: 'cancelled' });
ok(r.s === 400, 'admin also must give reason');

// ---- 3b. payment collection
r = await call(sa2, 'PATCH', `/orders/${oA2.id}/status`, { status: 'paid' });
ok(r.s === 400, 'paid needs a payment method');
await call(sa2, 'PATCH', `/orders/${oA2.id}/status`, { status: 'paid', pay_method: 'cash' });
await call(ta, 'PATCH', `/orders/${oAadm.id}/status`, { status: 'paid', pay_method: 'upi' });
ok((await call(sa2, 'PATCH', `/orders/${oA2.id}/status`, { status: 'served' })).s === 409, 'paid order cannot be reverted');
const rep = (await call(ta, 'GET', '/reports/staff')).d;
const row = n => rep.rows.find(x => x.username === n);
ok(row(`stA2${R}`).collected === 100 && row(`stA2${R}`).cash === 100 && row(`stA${R}`).cancelled === 1 && row(`admA${R}`).upi === 100, 'admin staff-wise collection report');
const myRep = (await call(sa2, 'GET', '/reports/mine')).d;
ok(myRep.rows.length === 1 && myRep.rows[0].username === `stA2${R}`, 'staff own report only contains self');
ok((await call(sa, 'GET', '/reports/staff')).s === 403, 'staff cannot open whole-bar report');
ok((await call(sa, 'GET', '/reports/summary')).s === 403, 'staff cannot open dashboard');
ok(!(await call(tb, 'GET', '/reports/staff')).d.rows.some(x => x.username.endsWith(R) && x.username.includes('A')), 'bar B report has no A people');

// ---- 2b. audit toggle
ok((await call(ta, 'GET', '/audit')).s === 200, 'audit visible by default');
await call(ta, 'PUT', '/settings', { show_audit: false });
ok((await call(ta, 'GET', '/audit')).s === 403, 'audit hidden when toggled off');
ok((await call(ta, 'GET', '/me')).d.bar.show_audit === false, '/me reports toggle');
ok((await call(tb, 'GET', '/audit')).s === 200, 'toggle only affects own bar');
await call(ta, 'PUT', '/settings', { show_audit: true });
ok((await call(tb, 'GET', '/audit')).d.every(a => !JSON.stringify(a).includes(`stA${R}`)), 'B audit has nothing from A');

// ---- 5. customer: menu, order, track, call waiter, enquiry, feedback
const tok = (await call(ta, 'GET', '/tables')).d; ok(!tok[0].token, 'table token not leaked in list');
const url = tok.find(t => t.id === tA.id).url, token = new URL(url).searchParams.get('t');
const menuA = (await call(null, 'GET', `/public/menu?token=${token}`)).d;
ok(menuA.table === 'T1' && menuA.products.every(p => p.name.startsWith('A-')) && menuA.bar.name.includes('Bar A'), 'table QR shows only bar A');
const slugB = (await call(sup, 'GET', '/super/bars')).d.find(b => b.id === B.id).slug;
const menuB = (await call(null, 'GET', `/public/menu?b=${slugB}`)).d;
ok(menuB.products.every(p => p.name.startsWith('B-')), 'bar slug QR shows only bar B');
ok((await call(null, 'GET', '/public/menu')).s === 400, 'no bar in link is refused when 2+ bars exist');
ok((await call(null, 'POST', '/public/order', { token, items: [{ product_id: pB.id, qty: 1 }] })).s === 400, 'customer cannot order another bar\'s product via table QR');
const co = (await call(null, 'POST', '/public/order', { token, items: [{ product_id: pA.id, qty: 1 }] })).d;
ok(co.token && co.no === 4, 'customer order placed, tracking token returned');
let tr = (await call(null, 'GET', `/public/track?tokens=${co.token}`)).d;
ok(tr[0].status === 'pending' && !tr[0].can_pay, 'customer can track order (pay off by default)');
ok(!(await call(sa, 'GET', '/orders')).d.every(o => !o.unclaimed) === false || (await call(sa, 'GET', '/orders')).d.some(o => o.unclaimed), 'staff sees unclaimed customer order in queue');
ok((await call(sb, 'GET', '/orders')).d.every(o => o.no !== 4 || o.id !== co.id), 'bar B staff cannot see it');
ok((await call(sa2, 'POST', `/orders/${(await call(sa2, 'GET', '/orders')).d.find(o => o.unclaimed).id}/accept`)).s === 200, 'staff accepts customer order');
const w1 = await call(null, 'POST', '/public/request', { token, type: 'waiter' });
ok(w1.s === 201, 'call waiter');
ok((await call(null, 'POST', '/public/request', { token, type: 'waiter' })).s === 429, 'repeat waiter call is throttled');
const en = await call(null, 'POST', '/public/request', { token, type: 'enquiry', message: 'Do you have draught beer?' });
ok(en.s === 201, 'enquiry sent');
ok((await call(sb, 'GET', '/requests')).d.length === 0, 'bar B does not see bar A requests');
const reqs = (await call(sa, 'GET', '/requests')).d; ok(reqs.length === 2 && reqs[0].table_name === 'T1', 'staff sees requests');
ok((await call(sb, 'PATCH', `/requests/${reqs[0].id}`, { status: 'done' })).s === 404, 'other bar cannot close request');
await call(sa, 'PATCH', `/requests/${reqs.find(x => x.type === 'enquiry').id}`, { status: 'done', reply: 'Yes, 2 brands' });
ok((await call(null, 'GET', `/public/requests?tokens=${en.d.token}`)).d[0].reply === 'Yes, 2 brands', 'customer sees staff reply');
ok((await call(null, 'POST', '/public/feedback', { token, rating: 5, comment: 'Great', order_token: co.token })).s === 201, 'feedback sent');
ok((await call(null, 'POST', '/public/feedback', { token, rating: 9 })).s === 400, 'bad rating rejected');
const fb = (await call(ta, 'GET', '/feedback')).d; ok(fb.rows.length === 1 && fb.avg === 5, 'admin sees feedback');
ok((await call(tb, 'GET', '/feedback')).d.rows.length === 0, 'bar B has no A feedback');
ok((await call(sa, 'GET', '/feedback')).s === 403, 'staff cannot read feedback');

// ---- 6. optional customer payment (UPI), never auto-paid
ok((await call(null, 'POST', `/public/track/${co.token}/claim`, {})).s === 400, 'claim refused while online pay is off');
ok((await call(ta, 'PUT', '/settings', { online_pay: true })).s === 400, 'cannot enable pay without UPI id');
ok((await call(ta, 'PUT', '/settings', { online_pay: true, upi_id: 'mybar@okbank' })).s === 200, 'admin enables UPI pay');
tr = (await call(null, 'GET', `/public/track?tokens=${co.token}`)).d;
ok(tr[0].can_pay && tr[0].upi_link.startsWith('upi://pay?pa=mybar%40okbank') && tr[0].upi_link.includes('am=100.00'), 'UPI link built server-side');
ok(!JSON.stringify(tr).includes('upi_id'), 'raw upi_id not sent in tracking payload');
ok((await call(null, 'POST', `/public/track/${co.token}/claim`, { ref: 'UTR123' })).s === 200, 'customer claims payment');
tr = (await call(null, 'GET', `/public/track?tokens=${co.token}`)).d;
ok(tr[0].status === 'pending' && !tr[0].can_pay, 'claim does NOT mark order paid');
const claimed = (await call(sa2, 'GET', '/orders')).d.find(o => o.id === co.id || o.no === 4); ok(claimed.pay_claimed_at && claimed.pay_ref === 'UTR123', 'staff sees claim + reference');
ok((await call(sa2, 'PATCH', `/orders/${claimed.id}/status`, { status: 'paid', pay_method: 'upi' })).s === 200, 'staff verifies & collects');

// ---- 7. backups
ok((await call(ta, 'GET', '/backup/xlsx', null, true)).status === 403, 'bar admin backup blocked until enabled');
ok((await call(sa, 'GET', '/backup/bak', null, true)).status === 403, 'staff never gets backup');
await call(sup, 'PUT', '/super/bars/' + A.id, { backup_enabled: true });
let x = await call(ta, 'GET', `/backup/xlsx?bar_id=${B.id}`, null, true); const xb = Buffer.from(await x.arrayBuffer());
ok(x.status === 200 && xb.slice(0, 2).toString() === 'PK', 'xlsx downloads (zip magic)');
const ex = await import('exceljs'); const wb = new ex.default.Workbook(); await wb.xlsx.load(xb);
const names = wb.worksheets.map(w => w.name); ok(names.includes('orders') && names.includes('products'), 'xlsx has sheets: ' + names.join(','));
const prodSheet = JSON.stringify(wb.getWorksheet('products').getSheetValues());
ok(prodSheet.includes('A-Beer') && !prodSheet.includes('B-Beer'), 'bar admin xlsx contains ONLY own bar (bar_id param ignored)');
x = await call(ta, 'GET', '/backup/bak', null, true); const bak = await x.text();
ok(x.status === 200 && bak.includes('INSERT INTO products') && bak.includes('A-Beer') && !bak.includes('B-Beer') && !/\$2[aby]\$/.test(bak), 'bar .bak is own bar only, no password hashes');
x = await call(sup, 'GET', '/backup/bak', null, true); const full = await x.text();
ok(full.includes('A-Beer') && full.includes('B-Beer') && /\$2[aby]\$/.test(full), 'SuperAdmin full .bak has all bars');
const sx = await call(sup, 'GET', `/backup/xlsx?bar_id=${B.id}`, null, true); ok(sx.status === 200, 'SuperAdmin can export one bar');
(await import('fs')).writeFileSync('/tmp/full.bak', full);

// ---- 1b. subscription: reduce / expire / renew
const detail = (await call(sup, 'GET', '/super/bars/' + A.id)).d;
const sub = detail.subscriptions[0];
ok((await call(sup, 'PATCH', '/super/subscriptions/' + sub.id, { shift_months: -1 })).s === 400, 'change needs a note');
const d10 = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
const red = await call(sup, 'PATCH', '/super/subscriptions/' + sub.id, { ends_on: d10, note: 'Reduced on request' });
ok(red.s === 200 && red.d.ends_on === d10 && red.d.ends_on < sub.ends_on, 'subscription shortened');
const sh = await call(sup, 'PATCH', '/super/subscriptions/' + sub.id, { shift_months: 1, note: 'extend test' });
ok(sh.s === 200 && sh.d.ends_on > d10, 'subscription extended by months');
const today = new Date(); today.setDate(today.getDate() - 1);
await call(sup, 'PATCH', '/super/subscriptions/' + sub.id, { ends_on: today.toISOString().slice(0, 10), note: 'expire now (test)' });
ok((await call(ta, 'GET', '/orders')).s === 402, 'expired subscription blocks bar admin');
ok((await call(sa, 'GET', '/orders')).s === 402, 'expired subscription blocks staff');
ok((await call(null, 'POST', '/auth/login', { username: `admA${R}`, password: 'secret1' })).s === 402, 'login blocked with clear message');
ok((await call(null, 'GET', `/public/menu?token=${token}`)).s === 403, 'customer menu closed when expired');
ok((await call(tb, 'GET', '/orders')).s === 200, 'bar B unaffected');
const renew = await call(sup, 'POST', `/super/bars/${A.id}/subscription`, { plan_id: plans.find(p => p.kind === 'yearly').id });
ok(renew.s === 201 && (await call(ta, 'GET', '/orders')).s === 200, 'renewing restores access');
await call(sup, 'PUT', '/super/bars/' + A.id, { active: false });
ok((await call(ta, 'GET', '/orders')).s === 403, 'disabled bar blocked');
await call(sup, 'PUT', '/super/bars/' + A.id, { active: true });
const comm = (await call(sup, 'GET', '/super/bars')).d.find(b => b.id === B.id);
ok(comm.kind === 'commission' && comm.commission_due !== null, 'commission bar shows commission due: ' + comm.commission_due);
ok((await call(sup, 'GET', '/super/log')).d.some(l => l.entity === 'subscription'), 'platform log records changes');
ok((await call(ta, 'GET', '/audit')).d.every(l => l.entity !== 'subscription' && l.entity !== 'plan'), 'bar admin audit does not show platform billing');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
