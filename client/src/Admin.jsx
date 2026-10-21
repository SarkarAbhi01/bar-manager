import { useState, useEffect, useContext } from 'react';
import { api, exportCsv, download, isAdmin } from './api.js';
import { Ctx, money, when, day, bind, useApi, Th, Empty, Status, SOURCE, Switch, run } from './common.jsx';

/* ---------- Staff-wise report (shared by Dashboard and My report) ---------- */
const COLS = [['Orders taken', 'orders'], ['Sales', 'sales', 1], ['Cancelled', 'cancelled'], ['Collected (count)', 'collected_orders'], ['Collection', 'collected', 1], ['Cash', 'cash', 1], ['UPI', 'upi', 1], ['Card', 'card', 1], ['Other', 'other', 1]];
function StaffTable({ data, file }) {
  const cell = (r, [, k, m]) => m ? money(r[k]) : r[k];
  return (<>
    <div className="bar"><button onClick={() => exportCsv(file, [...data.rows, { username: 'TOTAL', ...data.totals }], [['Name', r => r.username], ...COLS.map(c => [c[0], r => r[c[1]]])])}>Export CSV</button></div>
    <table><thead><tr><th>Person</th>{COLS.map(c => <th key={c[1]}>{c[0]}</th>)}</tr></thead>
      <tbody>{data.rows.map(r => <tr key={r.key}><td>{r.username} <small>{r.role}</small></td>{COLS.map(c => <td key={c[1]}>{cell(r, c)}</td>)}</tr>)}
        <tr className="tot"><td>Total</td>{COLS.map(c => <td key={c[1]}>{cell(data.totals, c)}</td>)}</tr></tbody></table>
    <Empty rows={data.rows} text="No activity in this period." />
    <p className="note">Sales = orders a person took. Collection = money that person received (by the date it was paid).</p>
  </>);
}
const Range = ({ f, setF }) => <div className="bar">From <input type="date" {...bind(f, setF, 'from')} /> To <input type="date" {...bind(f, setF, 'to')} /></div>;

export function MyReport() {
  const [f, setF] = useState({ from: '', to: '' }), [d] = useApi('/reports/mine', f, { rows: [], totals: {} });
  const r = d.rows[0] || {};
  return (<>
    <Range f={f} setF={setF} />
    <div className="cards">{[['Orders I took', r.orders || 0], ['My sales', money(r.sales)], ['Collected by me', money(r.collected)], ['Cash', money(r.cash)], ['UPI', money(r.upi)], ['Card', money(r.card)], ['Cancelled by me', r.cancelled || 0]]
      .map(([k, v]) => <div className="card" key={k}><h4>{k}</h4><b>{v}</b></div>)}</div>
    <p className="note">Only your own orders and collections are counted here.</p>
  </>);
}

/* ---------- Dashboard (admin: whole bar) ---------- */
export function Dashboard() {
  const [f, setF] = useState({ from: '', to: '' });
  const [d] = useApi('/reports/summary', f, null), [staff] = useApi('/reports/staff', f, { rows: [], totals: {} });
  return (<>
    <Range f={f} setF={setF} />
    {d && <>
      <div className="cards">
        {[['Sales', money(d.revenue)], ['Cost of goods sold', money(d.cogs)], ['Gross profit', money(d.profit)], ['Spent on purchases', money(d.purchases)], ['Orders', d.orders],
          ['Collected', money(staff.totals.collected)], ['Collected cash', money(staff.totals.cash)], ['Collected UPI', money(staff.totals.upi)], ['Collected card', money(staff.totals.card)]]
          .map(([k, v]) => <div className="card" key={k}><h4>{k}</h4><b>{v}</b></div>)}
      </div>
      <h3>Staff-wise orders &amp; collection</h3>
      <StaffTable data={staff} file="staff-collection.csv" />
      <div className="grid">
        <div>
          <h3>Sales by channel</h3>
          <table><thead><tr><th>Channel</th><th>Orders</th><th>Sales</th></tr></thead>
            <tbody>{d.by_source.map(r => <tr key={r.source}><td>{SOURCE[r.source]}</td><td>{r.orders}</td><td>{money(r.revenue)}</td></tr>)}</tbody></table>
          <Empty rows={d.by_source} text="No sales in this period." />
          <h3>Top 5 items</h3>
          <table><thead><tr><th>Item</th><th>Qty</th><th>Sales</th></tr></thead>
            <tbody>{d.top.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.qty}</td><td>{money(r.revenue)}</td></tr>)}</tbody></table>
        </div>
        <div>
          <h3>Low stock</h3>
          <table><tbody>{d.low_stock.map(r => <tr key={r.id} className="low"><td>{r.name}</td><td>{r.stock} left</td></tr>)}</tbody></table>
          <Empty rows={d.low_stock} text="Everything is above its minimum level." />
        </div>
      </div></>}
  </>);
}

/* ---------- Orders ---------- */
export function Orders() {
  const { user } = useContext(Ctx), admin = isAdmin();
  const [f, setF] = useState({ status: '', source: '', staff: '', from: '', to: '' }), [s, setS] = useState({ sort: 'created', dir: 'desc' });
  const [rows, load] = useApi('/orders', { ...f, ...s }), [people] = useApi('/users');
  const [payFor, setPayFor] = useState(null);
  useEffect(() => { const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const act = (fn) => run(fn, () => { setPayFor(null); load(); });
  const patch = (id, body) => act(() => api(`/orders/${id}/status`, { method: 'PATCH', body }));
  const cancel = o => { const reason = prompt(`Cancel order #${o.no}? Items go back to stock.\nReason (required):`); if (reason !== null) patch(o.id, { status: 'cancelled', reason }); };
  const remove = o => confirm(`Delete order #${o.no} permanently?${o.status === 'cancelled' ? '' : ' Items go back to stock.'}`) && act(() => api(`/orders/${o.id}`, { method: 'DELETE' }));
  const canCancel = admin || user.can_cancel;   // the server checks this again
  return (<>
    {!admin && <p className="note">You see the orders you took, plus new customer orders waiting for someone to pick up.</p>}
    <div className="bar">
      <select {...bind(f, setF, 'status')}><option value="">All statuses</option>{['pending', 'served', 'paid', 'cancelled'].map(x => <option key={x}>{x}</option>)}</select>
      <select {...bind(f, setF, 'source')}><option value="">All channels</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      {admin && <select {...bind(f, setF, 'staff')}><option value="">All staff</option><option value="me">My orders</option><option value="none">Customer / unassigned</option>{people.map(p => <option key={p.id} value={p.id}>{p.username}</option>)}</select>}
      <input type="date" {...bind(f, setF, 'from')} /><input type="date" {...bind(f, setF, 'to')} />
      <button onClick={() => exportCsv('orders.csv', rows, [['Order', r => r.no], ['Time', r => when(r.created_at)], ['Channel', r => SOURCE[r.source]], ['Table / customer', r => r.table_name || r.customer || ''], ['Items', r => r.items.map(i => `${i.qty}x ${i.name}`).join('; ')], ['Total', r => r.total], ['Status', r => r.status], ['Taken by', r => r.taken_by || ''], ['Collected by', r => r.collected_by || ''], ['Paid via', r => r.pay_method || ''], ['Paid at', r => when(r.paid_at)], ['Cancel reason', r => r.cancel_reason || '']])}>Export CSV</button>
    </div>
    <table><thead><tr><Th k="id" label="#" s={s} set={setS} /><Th k="created" label="Time" s={s} set={setS} /><th>Channel</th><th>Table / customer</th><th>Items</th><Th k="total" label="Total" s={s} set={setS} /><th>Taken by</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(o => <tr key={o.id} className={o.pay_claimed_at && o.status !== 'paid' && o.status !== 'cancelled' ? 'claim' : ''}>
        <td>{o.no}</td><td>{when(o.created_at)}</td><td>{SOURCE[o.source]}</td><td>{o.table_name || o.customer || '—'}</td>
        <td>{o.items.map(i => `${i.qty}× ${i.name}`).join(', ')}</td><td>{money(o.total)}</td>
        <td>{o.taken_by || <i className="note">{o.unclaimed ? 'waiting' : '—'}</i>}</td>
        <td><Status s={o.status} />
          {o.status === 'paid' && <small className="block">{o.pay_method || 'n/a'} · collected by {o.collected_by || '—'}<br />{when(o.paid_at)}</small>}
          {o.status === 'cancelled' && <small className="block">by {o.cancelled_by || '—'}: {o.cancel_reason || 'no reason recorded'}</small>}
          {o.pay_claimed_at && !['paid', 'cancelled'].includes(o.status) && <small className="block warn">Customer says paid by UPI{o.pay_ref ? ` (ref ${o.pay_ref})` : ''} — check your account, then mark Paid</small>}</td>
        <td className="acts">{!['cancelled'].includes(o.status) && <>
          {o.unclaimed && o.status !== 'paid' && <button onClick={() => act(() => api(`/orders/${o.id}/accept`, { method: 'POST' }))}>Accept</button>}
          {o.status === 'pending' && <button onClick={() => patch(o.id, { status: 'served' })}>Served</button>}
          {o.status !== 'paid' && (payFor === o.id
            ? ['cash', 'upi', 'card'].map(m => <button key={m} className="pri" onClick={() => patch(o.id, { status: 'paid', pay_method: m })}>{m}</button>)
            : <button className="pri" onClick={() => setPayFor(o.id)}>Paid…</button>)}
          {canCancel && !(o.status === 'paid' && !admin) && <button className="danger" onClick={() => cancel(o)}>Cancel</button>}</>}
          {admin && <button className="danger" onClick={() => remove(o)}>Delete</button>}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="No orders match these filters." />
  </>);
}

/* ---------- Customer requests (call waiter / bill / enquiry) ---------- */
const TYPE = { waiter: '🙋 Call waiter', bill: '🧾 Bring bill', enquiry: '❓ Enquiry' };
export function Requests() {
  const [rows, load] = useApi('/requests');
  useEffect(() => { const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const set = (r, status, reply) => run(() => api(`/requests/${r.id}`, { method: 'PATCH', body: { status, reply } }), load);
  return (<>
    <p className="note">Customers send these from their phone. This list refreshes by itself.</p>
    <table><thead><tr><th>Time</th><th>From</th><th>Request</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className={r.status === 'open' ? 'claim' : ''}>
        <td>{when(r.created_at)}</td><td>{r.table_name || r.label}</td>
        <td>{TYPE[r.type]}{r.message && <small className="block">{r.message}</small>}{r.reply && <small className="block">Reply: {r.reply}</small>}</td>
        <td><b className={r.status === 'open' ? 'pending' : 'paid'}>{r.status}</b>{r.handled_by && <small className="block">{r.handled_by}</small>}</td>
        <td className="acts">{r.status === 'open' && <button onClick={() => set(r, 'ack')}>On my way</button>}
          {r.status !== 'done' && <button className="pri" onClick={() => r.type === 'enquiry' ? set(r, 'done', prompt('Reply to customer (optional):') || undefined) : set(r, 'done')}>Done</button>}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="No customer requests yet." />
  </>);
}
export function Feedback() {
  const [d] = useApi('/feedback', {}, { rows: [], avg: null });
  return (<>
    <div className="cards"><div className="card"><h4>Average rating</h4><b>{d.avg ? d.avg.toFixed(1) + ' ★' : '—'}</b></div><div className="card"><h4>Responses</h4><b>{d.rows.length}</b></div></div>
    <table><thead><tr><th>Time</th><th>Rating</th><th>Comment</th><th>Name</th><th>Order</th></tr></thead>
      <tbody>{d.rows.map(r => <tr key={r.id}><td>{when(r.created_at)}</td><td>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</td><td>{r.comment || '—'}</td><td>{r.name || '—'}</td><td>{r.order_no ? '#' + r.order_no : '—'}</td></tr>)}</tbody></table>
    <Empty rows={d.rows} text="No feedback yet." />
  </>);
}

/* ---------- Users (admin) ---------- */
export function Users() {
  const [rows, load] = useApi('/users'), blankU = { username: '', password: '', role: 'staff' }, [form, setForm] = useState(blankU);
  const add = e => { e.preventDefault(); run(async () => { await api('/users', { method: 'POST', body: form }); setForm(blankU); }, load); };
  const patch = (u, body) => run(() => api(`/users/${u.id}`, { method: 'PUT', body }), load);
  return (<>
    <form className="bar" onSubmit={add}>
      <input required placeholder="Username" {...bind(form, setForm, 'username')} />
      <input required type="password" minLength="6" placeholder="Password (6+ characters)" {...bind(form, setForm, 'password')} />
      <select {...bind(form, setForm, 'role')}><option value="staff">Staff</option><option value="admin">Admin</option></select>
      <button className="pri">Add user</button>
    </form>
    <table><thead><tr><th>Username</th><th>Role</th><th>Can cancel orders</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(u => <tr key={u.id}><td>{u.username}</td>
        <td><select value={u.role} onChange={e => patch(u, { role: e.target.value })}><option value="staff">Staff</option><option value="admin">Admin</option></select></td>
        <td>{u.role === 'admin' ? <small>always (reason required)</small> : <Switch on={u.can_cancel} onChange={v => patch(u, { can_cancel: v })} label={u.can_cancel ? 'Allowed' : 'Not allowed'} />}</td>
        <td>{u.active ? 'Active' : 'Disabled'}</td>
        <td><button onClick={() => patch(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button> <button onClick={() => { const password = prompt(`New password for ${u.username} (6+ characters)`); if (password) patch(u, { password }); }}>Reset password</button></td></tr>)}</tbody></table>
    <p className="note">Staff with “Can cancel orders” must always type a reason; the reason is saved with the order and in the audit log. Staff can only cancel orders that are not yet paid.</p>
  </>);
}

/* ---------- Account / Settings / Backup ---------- */
export function Account() {
  const [f, setF] = useState({ old_password: '', new_password: '' });
  const go = e => { e.preventDefault(); run(async () => { await api('/account/password', { method: 'POST', body: f }); setF({ old_password: '', new_password: '' }); alert('Password changed'); }); };
  return (<form className="card narrow" onSubmit={go}><h3>Change my password</h3>
    <input required type="password" placeholder="Current password" {...bind(f, setF, 'old_password')} />
    <input required type="password" minLength="6" placeholder="New password (6+ characters)" {...bind(f, setF, 'new_password')} />
    <button className="pri">Change password</button></form>);
}
export function Settings() {
  const { bar, refresh } = useContext(Ctx), [upi, setUpi] = useState(bar.upi_id || '');
  const save = body => run(() => api('/settings', { method: 'PUT', body }), refresh);
  return (<>
    <div className="card narrow"><h3>Audit log</h3>
      <Switch on={bar.show_audit} onChange={v => save({ show_audit: v })} label={bar.show_audit ? 'Audit log tab is shown' : 'Audit log tab is hidden'} hint="Switching off only hides the tab. Every action is still recorded and the platform owner can still see it." /></div>
    <div className="card narrow"><h3>Customer payment (phones &amp; tablets)</h3>
      <p className="note">Customers can pay by UPI from their own phone, but they never have to: they can always pay at the counter. A customer tapping “I have paid” does not close the order — your staff must confirm it.</p>
      <input placeholder="Your UPI ID, e.g. mybar@okbank" value={upi} onChange={e => setUpi(e.target.value)} />
      <button onClick={() => save({ upi_id: upi })}>Save UPI ID</button>
      <Switch on={bar.online_pay} onChange={v => save({ online_pay: v, upi_id: upi })} label={bar.online_pay ? 'Customers see “Pay now”' : 'Customers do not see “Pay now”'} /></div>
    <div className="card narrow"><h3>Subscription</h3>
      <p>{bar.plan || '—'}{bar.kind === 'commission' ? ` · ${bar.commission_pct}% commission on paid sales` : ` · valid until ${day(bar.ends_on)}${bar.days_left != null ? ` (${bar.days_left} days left)` : ''}`}</p></div>
    <Account />
  </>);
}
export function Backup() {
  const { bar } = useContext(Ctx), [busy, setBusy] = useState('');
  const get = (fmt) => { setBusy(fmt); run(() => download(`/backup/${fmt}`, `backup.${fmt}`)).finally(() => setBusy('')); };
  return (<div className="card narrow"><h3>Download a backup of {bar.name}</h3>
    <p className="note">Only your bar's data is included. Keep the file somewhere safe.</p>
    <button className="pri" disabled={!!busy} onClick={() => get('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : 'Excel (.xlsx)'}</button>{' '}
    <button disabled={!!busy} onClick={() => get('bak')}>{busy === 'bak' ? 'Preparing…' : 'Database backup (.bak)'}</button>
    <p className="note">.bak is a SQL script that the platform owner can restore into a database.</p></div>);
}
