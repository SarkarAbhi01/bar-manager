import { useState } from 'react';
import { api, download, exportCsv } from './api.js';
import { money, when, day, bind, useApi, Empty, Switch, run } from './common.jsx';
import { Account } from './Admin.jsx';

const KIND = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-yearly', yearly: 'Yearly', long_term: 'Long-term', commission: 'Commission' };
const subText = b => !b.sub_id ? 'No plan' : b.kind === 'commission' ? `${b.commission_pct}% commission · due ${money(b.commission_due)}` : `until ${day(b.ends_on)}`;

/* ---------- Plans ---------- */
export function Plans() {
  const [rows, load] = useApi('/super/plans'), blank = { name: '', kind: 'monthly', months: '', price: '', commission_pct: '' }, [f, setF] = useState(blank);
  const add = e => { e.preventDefault(); run(async () => { await api('/super/plans', { method: 'POST', body: f }); setF(blank); }, load); };
  const edit = (p, k, label) => { const v = prompt(label, p[k]); if (v !== null && v !== '') run(() => api(`/super/plans/${p.id}`, { method: 'PUT', body: { [k]: v } }), load); };
  return (<>
    <form className="bar" onSubmit={add}>
      <input required placeholder="Plan name" {...bind(f, setF, 'name')} />
      <select {...bind(f, setF, 'kind')}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      {f.kind === 'long_term' && <input required type="number" min="1" placeholder="Months (e.g. 24)" {...bind(f, setF, 'months')} />}
      {f.kind === 'commission' ? <input required type="number" min="0" max="100" step="any" placeholder="Commission %" {...bind(f, setF, 'commission_pct')} />
        : <input required type="number" min="0" step="any" placeholder="Price ₹" {...bind(f, setF, 'price')} />}
      <button className="pri">Add plan</button>
    </form>
    <table><thead><tr><th>Plan</th><th>Type</th><th>Months</th><th>Price</th><th>Commission</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(p => <tr key={p.id} className={p.active ? '' : 'dim'}><td>{p.name}</td><td>{KIND[p.kind]}</td><td>{p.months ?? '—'}</td><td>{p.kind === 'commission' ? '—' : money(p.price)}</td><td>{p.commission_pct != null ? p.commission_pct + '%' : '—'}</td><td>{p.active ? 'Available' : 'Hidden'}</td>
        <td>{p.kind !== 'commission' && <button onClick={() => edit(p, 'price', 'New price ₹')}>Change price</button>} {p.kind === 'long_term' && <button onClick={() => edit(p, 'months', 'New length in months')}>Change months</button>} {p.kind === 'commission' && <button onClick={() => edit(p, 'commission_pct', 'New commission %')}>Change %</button>} <button onClick={() => run(() => api(`/super/plans/${p.id}`, { method: 'PUT', body: { active: !p.active } }), load)}>{p.active ? 'Hide' : 'Show'}</button></td></tr>)}</tbody></table>
    <p className="note">Changing a plan only affects bars you assign it to afterwards. A bar's running subscription keeps its own price and dates (change those from the bar's page).</p>
  </>);
}

/* ---------- Bars ---------- */
export function Bars() {
  const [rows, load] = useApi('/super/bars'), [plans] = useApi('/super/plans'), [open, setOpen] = useState(null);
  const blank = { name: '', admin_username: '', admin_password: '', plan_id: '', starts_on: '' }, [f, setF] = useState(blank);
  const add = e => { e.preventDefault(); run(async () => { const r = await api('/super/bars', { method: 'POST', body: f }); setF(blank); setOpen(r.id); }, load); };
  if (open) return <BarDetail id={open} onClose={() => { setOpen(null); load(); }} plans={plans} />;
  return (<>
    <form className="bar" onSubmit={add}>
      <input required placeholder="Bar name" {...bind(f, setF, 'name')} />
      <input required placeholder="Admin username" {...bind(f, setF, 'admin_username')} />
      <input required type="password" minLength="6" placeholder="Admin password" {...bind(f, setF, 'admin_password')} />
      <select required {...bind(f, setF, 'plan_id')}><option value="">Plan…</option>{plans.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name}{p.kind === 'commission' ? '' : ` — ${money(p.price)}`}</option>)}</select>
      <input type="date" title="Start date (default today)" {...bind(f, setF, 'starts_on')} />
      <button className="pri">Create bar + admin</button>
    </form>
    <table><thead><tr><th>Bar</th><th>Admin login(s)</th><th>Staff</th><th>Plan</th><th>Subscription</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(b => <tr key={b.id} className={b.active ? '' : 'dim'}><td>{b.name}<br /><small>/menu?b={b.slug}</small></td><td>{b.admins || '—'}</td><td>{b.staff_count}</td><td>{b.plan_name || '—'}</td>
        <td><b className={b.sub_status === 'active' ? 'paid' : 'cancelled'}>{b.sub_status}</b> <small>{subText(b)}</small></td><td>{b.active ? 'Enabled' : 'Disabled'}</td>
        <td><button onClick={() => setOpen(b.id)}>Manage</button></td></tr>)}</tbody></table>
    <Empty rows={rows} text="No bars yet. Create the first one above." />
  </>);
}

function BarDetail({ id, onClose, plans }) {
  const [d, load] = useApi(`/super/bars/${id}`, {}, null);
  const [adm, setAdm] = useState({ username: '', password: '' }), [adj, setAdj] = useState({ ends_on: '', shift_months: '', price: '', commission_pct: '', note: '' });
  const [asg, setAsg] = useState({ plan_id: '', starts_on: '', price: '', months: '', commission_pct: '', note: '' });
  if (!d) return <p className="note">Loading…</p>;
  const { bar, users, subscriptions } = d, cur = subscriptions.find(s => s.status === 'active'), plan = plans.find(p => p.id === +asg.plan_id);
  const put = body => run(() => api(`/super/bars/${id}`, { method: 'PUT', body }), load);
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  return (<>
    <div className="bar"><button onClick={onClose}>← All bars</button><h3 style={{ margin: 0 }}>{bar.name}</h3><button onClick={() => { const name = prompt('Bar name', bar.name); name && put({ name }); }}>Rename</button></div>
    <div className="grid2">
      <div className="card"><h4>Access</h4>
        <Switch on={bar.active} onChange={v => put({ active: v })} label={bar.active ? 'Bar is enabled' : 'Bar is disabled'} hint="Disabled bars cannot log in and their QR menus close." />
        <Switch on={bar.show_audit} onChange={v => put({ show_audit: v })} label="Audit log visible to Bar Admin" hint="The bar admin can also switch this in their Settings." />
        <Switch on={bar.backup_enabled} onChange={v => put({ backup_enabled: v })} label="Backup enabled for Bar Admin" hint="Lets the bar admin download their own Excel / .bak." /></div>
      <div className="card"><h4>Current subscription</h4>
        {cur ? <><p><b>{cur.plan_name}</b> ({KIND[cur.kind]})<br />Started {day(cur.starts_on)} · {cur.kind === 'commission' ? `${cur.commission_pct}% commission · due ${money(bar.commission_due)}` : `ends ${day(cur.ends_on)}`}<br />Price {money(cur.price)}{cur.note && <><br /><small>{cur.note}</small></>}</p>
          <form onSubmit={e => { e.preventDefault(); run(() => api(`/super/subscriptions/${cur.id}`, { method: 'PATCH', body: clean(adj) }), () => { setAdj({ ends_on: '', shift_months: '', price: '', commission_pct: '', note: '' }); load(); }); }}>
            <b>Reduce / extend</b>
            {cur.kind !== 'commission' && <div className="bar"><select value={adj.shift_months} onChange={e => setAdj({ ...adj, shift_months: e.target.value, ends_on: '' })}><option value="">Shift end date by…</option>{[-12, -6, -3, -1, 1, 3, 6, 12].map(m => <option key={m} value={m}>{m > 0 ? '+' : ''}{m} month{Math.abs(m) > 1 ? 's' : ''}</option>)}</select>
              <input type="date" title="…or set exact end date" value={adj.ends_on} onChange={e => setAdj({ ...adj, ends_on: e.target.value, shift_months: '' })} /></div>}
            <div className="bar">{cur.kind === 'commission' ? <input type="number" min="0" max="100" step="any" placeholder="New commission %" {...bind(adj, setAdj, 'commission_pct')} /> : <input type="number" min="0" step="any" placeholder="New price ₹" {...bind(adj, setAdj, 'price')} />}</div>
            <input required placeholder="Reason / note (required)" {...bind(adj, setAdj, 'note')} /><button className="pri">Apply change</button>
          </form></> : <p className="note">No active subscription.</p>}</div>
    </div>
    <div className="card"><h4>Assign a new plan (ends the current one)</h4>
      <form className="bar" onSubmit={e => { e.preventDefault(); run(() => api(`/super/bars/${id}/subscription`, { method: 'POST', body: clean(asg) }), () => { setAsg({ plan_id: '', starts_on: '', price: '', months: '', commission_pct: '', note: '' }); load(); }); }}>
        <select required {...bind(asg, setAsg, 'plan_id')}><option value="">Plan…</option>{plans.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <input type="date" {...bind(asg, setAsg, 'starts_on')} />
        {plan && plan.kind !== 'commission' && <input type="number" min="0" step="any" placeholder={`Price (default ${plan.price})`} {...bind(asg, setAsg, 'price')} />}
        {plan?.kind === 'long_term' && <input type="number" min="1" placeholder={`Months (default ${plan.months})`} {...bind(asg, setAsg, 'months')} />}
        {plan?.kind === 'commission' && <input type="number" min="0" max="100" step="any" placeholder={`Commission % (default ${plan.commission_pct})`} {...bind(asg, setAsg, 'commission_pct')} />}
        <input placeholder="Note" {...bind(asg, setAsg, 'note')} /><button className="pri">Assign</button></form></div>
    <h3>Logins</h3>
    <table><thead><tr><th>Username</th><th>Role</th><th>Status</th><th /></tr></thead>
      <tbody>{users.map(u => <tr key={u.id}><td>{u.username}</td><td>{u.role}{u.can_cancel ? ' (can cancel)' : ''}</td><td>{u.active ? 'Active' : 'Disabled'}</td>
        <td><button onClick={() => run(() => api(`/super/users/${u.id}`, { method: 'PUT', body: { active: !u.active } }), load)}>{u.active ? 'Disable' : 'Enable'}</button> <button onClick={() => { const password = prompt(`New password for ${u.username}`); password && run(() => api(`/super/users/${u.id}`, { method: 'PUT', body: { password } }), load); }}>Reset password</button></td></tr>)}</tbody></table>
    <form className="bar" onSubmit={e => { e.preventDefault(); run(async () => { await api(`/super/bars/${id}/admins`, { method: 'POST', body: adm }); setAdm({ username: '', password: '' }); }, load); }}>
      <input required placeholder="New admin username" {...bind(adm, setAdm, 'username')} /><input required type="password" minLength="6" placeholder="Password" {...bind(adm, setAdm, 'password')} /><button>Add admin login</button></form>
    <h3>Subscription history</h3>
    <table><thead><tr><th>Plan</th><th>From</th><th>To</th><th>Price</th><th>Status</th><th>Note</th></tr></thead>
      <tbody>{subscriptions.map(s => <tr key={s.id}><td>{s.plan_name}</td><td>{day(s.starts_on)}</td><td>{s.kind === 'commission' ? `${s.commission_pct}% commission` : day(s.ends_on)}</td><td>{money(s.price)}</td><td>{s.status}</td><td>{s.note || ''}</td></tr>)}</tbody></table>
  </>);
}

/* ---------- Backups ---------- */
export function Backups() {
  const [bars] = useApi('/super/bars'), [scope, setScope] = useState(''), [busy, setBusy] = useState('');
  const get = fmt => { setBusy(fmt); run(() => download(`/backup/${fmt}${scope ? `?bar_id=${scope}` : ''}`, `backup.${fmt}`)).finally(() => setBusy('')); };
  return (<div className="card narrow"><h3>Backup data</h3>
    <select value={scope} onChange={e => setScope(e.target.value)}><option value="">All bars (whole platform)</option>{bars.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
    <button className="pri" disabled={!!busy} onClick={() => get('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : 'Download Excel (.xlsx)'}</button>{' '}
    <button disabled={!!busy} onClick={() => get('bak')}>{busy === 'bak' ? 'Preparing…' : 'Download .bak'}</button>
    <p className="note">Excel: one sheet per table, no passwords or QR tokens. .bak: a SQL script (includes password hashes for the whole-platform file — keep it private). Restore a whole-platform .bak into an empty database with <code>node restore.js file.bak</code>.</p>
    <p className="note">To let a bar admin download their own backup, open the bar and switch “Backup enabled”.</p></div>);
}

/* ---------- Platform log ---------- */
export function PlatformLog() {
  const [rows] = useApi('/super/log');
  return (<>
    <div className="bar"><button onClick={() => exportCsv('platform-log.csv', rows, [['Time', r => when(r.created_at)], ['By', r => r.actor], ['Record', r => `${r.entity} #${r.entity_id}`], ['Action', r => r.action], ['Details', r => JSON.stringify(r.new_data || r.old_data)]])}>Export CSV</button></div>
    <table><thead><tr><th>Time</th><th>By</th><th>Record</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.actor}</td><td>{r.entity} #{r.entity_id}</td><td><b className={r.action}>{r.action}</b></td><td className="ellip" title={JSON.stringify({ old: r.old_data, new: r.new_data }, null, 1)}>{JSON.stringify(r.new_data || r.old_data)}</td></tr>)}</tbody></table>
    <Empty rows={rows} text="Nothing logged yet." />
  </>);
}
export { Account };
