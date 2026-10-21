import { useState, useEffect, useCallback } from 'react';
import { api, auth, saveAuth, clearAuth, isAdmin, exportCsv } from './api.js';
import { Ctx, money, when, bind, useApi, Th, Empty } from './common.jsx';
import { Dashboard, Orders, Users, MyReport, Requests, Feedback, Settings, Backup, Account } from './Admin.jsx';
import { Bars, Plans, Backups, PlatformLog } from './Super.jsx';

/* ---------- Stock ---------- */
const blank = { name: '', category: '', price: '', cost: '', stock: '', min_stock: 5 };
function Stock() {
  const [f, setF] = useState({ q: '', category: '', low: '' }), [s, setS] = useState({ sort: 'name', dir: 'asc' });
  const [rows, load, error] = useApi('/products', { ...f, ...s });
  const [form, setForm] = useState(blank), [editId, setEditId] = useState(null);
  const save = async e => {
    e.preventDefault();
    try { await api(editId ? `/products/${editId}` : '/products', { method: editId ? 'PUT' : 'POST', body: form }); setForm(blank); setEditId(null); load(); }
    catch (er) { alert(er.message); }
  };
  const edit = p => { setEditId(p.id); setForm({ name: p.name, category: p.category, price: p.price, cost: p.cost, stock: p.stock, min_stock: p.min_stock }); };
  const del = async p => { if (confirm(`Delete ${p.name}?`)) { await api(`/products/${p.id}`, { method: 'DELETE' }); load(); } };
  const fld = (k, ph, type = 'number') => <input required placeholder={ph} type={type} min="0" step="any" {...bind(form, setForm, k)} />;
  return (<>
    {isAdmin() && <form className="bar" onSubmit={save}>
      {fld('name', 'Item name', 'text')}{fld('category', 'Category', 'text')}{fld('price', 'Sell price')}{fld('cost', 'Cost price')}{fld('stock', 'Stock')}{fld('min_stock', 'Min stock')}
      <button className="pri">{editId ? 'Save changes' : 'Add item'}</button>
      {editId && <button type="button" onClick={() => { setEditId(null); setForm(blank); }}>Cancel</button>}
    </form>}
    <div className="bar">
      <input placeholder="Search item" {...bind(f, setF, 'q')} /><input placeholder="Filter category" {...bind(f, setF, 'category')} />
      <label><input type="checkbox" checked={f.low === '1'} onChange={e => setF({ ...f, low: e.target.checked ? '1' : '' })} /> Low stock only</label>
      {isAdmin() && <button onClick={() => exportCsv('stock.csv', rows, [['Item', r => r.name], ['Category', r => r.category], ['Price', r => r.price], ['Cost', r => r.cost], ['Stock', r => r.stock], ['Min stock', r => r.min_stock], ['Updated', r => when(r.updated_at)]])}>Export CSV</button>}
    </div>
    {error && <p className="err">{error}</p>}
    <table><thead><tr><Th k="name" label="Item" s={s} set={setS} /><Th k="category" label="Category" s={s} set={setS} /><Th k="price" label="Price" s={s} set={setS} />{isAdmin() && <th>Cost</th>}<Th k="stock" label="Stock" s={s} set={setS} /><Th k="updated" label="Updated" s={s} set={setS} /><th /></tr></thead>
      <tbody>{rows.map(p => <tr key={p.id} className={p.stock <= p.min_stock ? 'low' : ''}>
        <td>{p.name}</td><td>{p.category}</td><td>{money(p.price)}</td>{isAdmin() && <td>{money(p.cost)}</td>}<td>{p.stock} <small>(min {p.min_stock})</small></td><td>{when(p.updated_at)}</td>
        <td>{isAdmin() && <><button onClick={() => edit(p)}>Edit</button> <button className="danger" onClick={() => del(p)}>Delete</button></>}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="No items yet. Add your first item above." />
  </>);
}

/* ---------- Manual sale ---------- */
function Sale() {
  const [q, setQ] = useState(''), [products, reload] = useApi('/products', { q }), [tables] = useApi('/tables');
  const [cart, setCart] = useState({}), [tableId, setTableId] = useState(''), [customer, setCustomer] = useState('');
  const add = (p, d) => setCart(c => { const qty = (c[p.id]?.qty || 0) + d, n = { ...c }; if (qty > 0) n[p.id] = { p, qty }; else delete n[p.id]; return n; });
  const lines = Object.values(cart), total = lines.reduce((a, l) => a + l.qty * l.p.price, 0);
  const submit = async () => {
    try {
      await api('/orders', { method: 'POST', body: { table_id: tableId || null, customer, items: lines.map(l => ({ product_id: l.p.id, qty: l.qty })) } });
      setCart({}); setCustomer(''); reload(); alert('Order saved');
    } catch (e) { alert(e.message); }
  };
  return (
    <div className="grid">
      <div><div className="bar"><input placeholder="Search item" value={q} onChange={e => setQ(e.target.value)} /></div>
        <table><tbody>{products.filter(p => p.stock > 0).map(p => <tr key={p.id}><td>{p.name}<br /><small>{p.category} · {p.stock} in stock</small></td><td>{money(p.price)}</td><td><button onClick={() => add(p, 1)}>Add</button></td></tr>)}</tbody></table></div>
      <div className="card"><h3>Current order</h3>
        <select value={tableId} onChange={e => setTableId(e.target.value)}><option value="">No table (counter)</option>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <input placeholder="Customer (optional)" value={customer} onChange={e => setCustomer(e.target.value)} />
        {lines.map(l => <div className="item" key={l.p.id}><span>{l.p.name}</span><span className="qty"><button onClick={() => add(l.p, -1)}>−</button>{l.qty}<button onClick={() => add(l.p, 1)}>+</button></span></div>)}
        <Empty rows={lines} text="Add items from the list." />
        <button className="pri wide" disabled={!lines.length} onClick={submit}>Save order · {money(total)}</button></div>
    </div>);
}

/* ---------- Purchases ---------- */
function Purchases() {
  const [f, setF] = useState({ q: '', from: '', to: '' }), [s, setS] = useState({ sort: 'date', dir: 'desc' });
  const [rows, load] = useApi('/purchases', { ...f, ...s }), [products] = useApi('/products');
  const [form, setForm] = useState({ product_id: '', supplier: '', qty: '', unit_cost: '' });
  const save = async e => {
    e.preventDefault();
    try { await api('/purchases', { method: 'POST', body: form }); setForm({ product_id: '', supplier: '', qty: '', unit_cost: '' }); load(); }
    catch (er) { alert(er.message); }
  };
  return (<>
    <form className="bar" onSubmit={save}>
      <select required {...bind(form, setForm, 'product_id')}><option value="">Select item</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <input placeholder="Supplier" {...bind(form, setForm, 'supplier')} />
      <input required type="number" min="1" placeholder="Quantity" {...bind(form, setForm, 'qty')} />
      <input required type="number" min="0" step="any" placeholder="Unit cost" {...bind(form, setForm, 'unit_cost')} />
      <button className="pri">Add purchase</button>
    </form>
    <div className="bar"><input placeholder="Search item or supplier" {...bind(f, setF, 'q')} /><input type="date" {...bind(f, setF, 'from')} /><input type="date" {...bind(f, setF, 'to')} /><button onClick={() => exportCsv('purchases.csv', rows, [['Date', r => when(r.created_at)], ['Item', r => r.product], ['Supplier', r => r.supplier], ['Qty', r => r.qty], ['Unit cost', r => r.unit_cost], ['Total', r => r.qty * r.unit_cost]])}>Export CSV</button></div>
    <table><thead><tr><Th k="date" label="Date" s={s} set={setS} /><Th k="product" label="Item" s={s} set={setS} /><th>Supplier</th><Th k="qty" label="Qty" s={s} set={setS} /><th>Unit cost</th><Th k="cost" label="Total" s={s} set={setS} /></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.product}</td><td>{r.supplier || '—'}</td><td>{r.qty}</td><td>{money(r.unit_cost)}</td><td>{money(r.qty * r.unit_cost)}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="No purchases recorded." />
  </>);
}

/* ---------- Tables & QR ---------- */
const QR = ({ title, sub, img, url, onDelete }) => (
  <div className="card qr"><h4>{title}</h4><img src={img} alt={title} /><p>{sub}</p><small>{url}</small>
    <div className="bar"><button onClick={() => window.print()}>Print</button>{onDelete && <button className="danger" onClick={onDelete}>Delete</button>}</div></div>);
function Tables() {
  const [g, setG] = useState(null), [tables, load] = useApi('/tables'), [name, setName] = useState('');
  useEffect(() => { api('/qr/global').then(setG); }, []);
  const add = async e => { e.preventDefault(); try { await api('/tables', { method: 'POST', body: { name } }); setName(''); load(); } catch (er) { alert(er.message); } };
  const del = async t => { if (confirm(`Delete ${t.name}? Its printed QR will stop working.`)) { await api(`/tables/${t.id}`, { method: 'DELETE' }); load(); } };
  return (<>
    <form className="bar" onSubmit={add}><input required placeholder="New table name, e.g. Table 7" value={name} onChange={e => setName(e.target.value)} /><button className="pri">Add table</button></form>
    <div className="qrgrid">
      {g && <QR title="Global QR" sub="One QR for the whole bar. Customer enters table number or name." img={g.image} url={g.url} />}
      {tables.map(t => <QR key={t.id} title={t.name} sub="Table QR. The table is detected automatically." img={t.qr} url={t.url} onDelete={() => del(t)} />)}
    </div></>);
}

/* ---------- Audit log ---------- */
const diff = (a, b) => {
  if (!a || !b) return JSON.stringify(a || b);
  return Object.keys(b).filter(k => k !== 'updated_at' && JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => `${k}: ${a[k]} → ${b[k]}`).join(', ');
};
function Audit() {
  const [f, setF] = useState({ entity: '', action: '', from: '', to: '', dir: 'desc' });
  const [rows] = useApi('/audit', f);
  return (<>
    <div className="bar">
      <select {...bind(f, setF, 'entity')}><option value="">All records</option>{['product', 'order', 'purchase', 'table'].map(x => <option key={x}>{x}</option>)}</select>
      <select {...bind(f, setF, 'action')}><option value="">All actions</option>{['CREATE', 'UPDATE', 'DELETE'].map(x => <option key={x}>{x}</option>)}</select>
      <input type="date" {...bind(f, setF, 'from')} /><input type="date" {...bind(f, setF, 'to')} /><button onClick={() => exportCsv('audit-log.csv', rows, [['Time', r => when(r.created_at)], ['By', r => r.actor], ['Record', r => `${r.entity} #${r.entity_id}`], ['Action', r => r.action], ['Details', r => r.action === 'UPDATE' ? diff(r.old_data, r.new_data) : JSON.stringify(r.new_data || r.old_data)]])}>Export CSV</button>
    </div>
    <table><thead><tr><th className="sortable" onClick={() => setF({ ...f, dir: f.dir === 'desc' ? 'asc' : 'desc' })}>Time {f.dir === 'desc' ? '▼' : '▲'}</th><th>By</th><th>Record</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.actor}</td><td>{r.entity} #{r.entity_id}</td><td><b className={r.action}>{r.action}</b></td>
        <td className="ellip" title={JSON.stringify({ old: r.old_data, new: r.new_data }, null, 1)}>{r.action === 'UPDATE' ? diff(r.old_data, r.new_data) : JSON.stringify(r.new_data || r.old_data)}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="No activity recorded for these filters." />
  </>);
}

/* ---------- Login ---------- */
function Login({ onDone }) {
  const [f, setF] = useState({ username: '', password: '' }), [error, setError] = useState('');
  const go = async e => { e.preventDefault(); try { const d = await api('/auth/login', { method: 'POST', body: f }); saveAuth(d); onDone(d.user); } catch (er) { setError(er.message); } };
  return (
    <form className="card login" onSubmit={go}>
      <h2>Bar Manager</h2>
      <input required autoFocus placeholder="Username" {...bind(f, setF, 'username')} />
      <input required type="password" placeholder="Password" {...bind(f, setF, 'password')} />
      {error && <p className="err">{error}</p>}
      <button className="pri wide">Sign in</button>
    </form>);
}


/* ---------- Shell ---------- */
const ADMIN_TABS = { Dashboard, 'New sale': Sale, Orders, Requests, 'My report': MyReport, Stock, Purchases, 'Tables & QR': Tables, Feedback, 'Audit log': Audit, Users, Backup, Settings };
const STAFF_TABS = { 'New sale': Sale, Orders, Requests, 'My report': MyReport, Stock, Account };
const SUPER_TABS = { Bars, Plans, Backups, 'Platform log': PlatformLog, Account };
function tabsFor(ctx) {
  if (ctx.user.role === 'superadmin') return SUPER_TABS;
  if (ctx.user.role === 'staff') return STAFF_TABS;
  const t = { ...ADMIN_TABS };
  if (!ctx.bar?.show_audit) delete t['Audit log'];       // Bar Admin switched the audit log off
  if (!ctx.bar?.backup_enabled) delete t.Backup;         // SuperAdmin has not enabled backups for this bar
  return t;
}
export default function App() {
  const [ctx, setCtx] = useState(auth() ? { user: auth().user, bar: null } : null), [tab, setTab] = useState(''), [open, setOpen] = useState(0), [blocked, setBlocked] = useState('');
  const refresh = useCallback(() => api('/me').then(d => { setCtx(d); setBlocked(''); }).catch(e => setBlocked(e.message)), []);
  useEffect(() => { if (auth()) refresh(); }, []);
  const staffSide = ctx && ctx.user.role !== 'superadmin';
  useEffect(() => {   // badge for waiting customer requests
    if (!staffSide) return;
    const poll = () => api('/requests/count').then(d => setOpen(d.open)).catch(() => {});
    poll(); const t = setInterval(poll, 10000); return () => clearInterval(t);
  }, [staffSide]);
  if (!ctx) return <Login onDone={u => { setCtx({ user: u, bar: null }); refresh(); }} />;
  const out = () => { clearAuth(); setCtx(null); setTab(''); };
  if (blocked) return <div className="card login"><h2>Bar Manager</h2><p className="err">{blocked}</p><button className="wide" onClick={out}>Sign out</button></div>;
  if (staffSide && !ctx.bar) return <p className="note" style={{ padding: 16 }}>Loading…</p>;
  const tabs = tabsFor(ctx), Page = tabs[tab] || Object.values(tabs)[0];
  const days = ctx.bar?.days_left;
  return (<Ctx.Provider value={{ ...ctx, refresh }}>
    <header><span className="brand">{ctx.bar?.name || 'Bar Manager'}</span>
      <nav>{Object.keys(tabs).map(k => <button key={k} className={tabs[k] === Page ? 'on' : ''} onClick={() => setTab(k)}>{k}{k === 'Requests' && open > 0 && <span className="badge">{open}</span>}</button>)}</nav>
      <span>{ctx.user.username} ({ctx.user.role})</span>
      <button onClick={out}>Sign out</button></header>
    {ctx.user.role === 'admin' && days != null && days <= 7 && <div className="banner">Your subscription ends in {Math.max(days, 0)} day(s). Please contact the platform owner to renew.</div>}
    <main><Page key={Object.keys(tabs).find(k => tabs[k] === Page)} /></main></Ctx.Provider>);
}
