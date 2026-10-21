import { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';

// Customer page (opened from a QR). Mobile-first. Nothing here needs a login.
const P = new URLSearchParams(location.search), TOKEN = P.get('t') || '', BARKEY = P.get('b') || '';
const link = TOKEN ? `token=${TOKEN}` : BARKEY ? `b=${encodeURIComponent(BARKEY)}` : '';
const body = o => ({ token: TOKEN || undefined, b: BARKEY || undefined, ...o });
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)) ?? []; localStorage.setItem(k, JSON.stringify(v)); } catch { return []; } };
// "Pay now" is only offered on phones / tablets (incl. iPhone, iPad and iPadOS that reports as a Mac)
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const STEPS = ['pending', 'served', 'paid'], STEP_LABEL = { pending: 'Received', served: 'Served', paid: 'Paid' };

export default function Menu() {
  const [m, setM] = useState(null), [msg, setMsg] = useState(''), [tab, setTab] = useState('menu');
  const [customer, setCustomer] = useState(() => localStorage.getItem('bm_name') || '');
  const [mine, setMine] = useState(0);
  useEffect(() => { api(`/public/menu?${link}`).then(setM).catch(e => setMsg(e.message)); }, []);
  if (!m) return <div className="menu"><p className="note">{msg || 'Loading menu…'}</p></div>;
  const label = m.table || customer.trim();
  const shared = { m, customer, setCustomer: v => { setCustomer(v); localStorage.setItem('bm_name', v); }, label, goOrders: () => setTab('orders') };
  return (<div className="menu cust">
    <header className="chead"><h2>{m.bar.name}</h2><small>{m.table ? `You are at ${m.table}` : 'Order from your seat'}</small></header>
    {tab === 'menu' && <MenuTab {...shared} reload={() => api(`/public/menu?${link}`).then(setM).catch(() => {})} />}
    {tab === 'orders' && <OrdersTab m={m} onCount={setMine} />}
    {tab === 'help' && <HelpTab {...shared} />}
    {tab === 'feedback' && <FeedbackTab {...shared} />}
    <nav className="bnav">{[['menu', '🍺', 'Menu'], ['orders', '🧾', 'My orders'], ['help', '🙋', 'Help'], ['feedback', '⭐', 'Feedback']].map(([k, i, t]) =>
      <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><span>{i}</span>{t}{k === 'orders' && mine > 0 && <b className="badge">{mine}</b>}</button>)}</nav>
  </div>);
}

const NameField = ({ m, customer, setCustomer }) => !m.table && <input placeholder="Your table number or name" value={customer} onChange={e => setCustomer(e.target.value)} />;

function MenuTab({ m, customer, setCustomer, goOrders, reload }) {
  const [cart, setCart] = useState({}), [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
  const add = (id, d) => setCart(c => { const q = (c[id] || 0) + d, n = { ...c }; if (q > 0) n[id] = Math.min(q, 20); else delete n[id]; return n; });
  const total = m.products.reduce((a, p) => a + (cart[p.id] || 0) * p.price, 0);
  const send = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api('/public/order', { method: 'POST', body: body({ customer, items: Object.entries(cart).map(([product_id, qty]) => ({ product_id: +product_id, qty })) }) });
      store('bm_orders', [{ token: r.token, at: Date.now(), key: link }, ...store('bm_orders')].slice(0, 20));
      setCart({}); reload(); goOrders();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  };
  return (<>
    <NameField m={m} customer={customer} setCustomer={setCustomer} />
    {msg && <p className="err">{msg}</p>}
    {[...new Set(m.products.map(p => p.category))].map(cat => (
      <section key={cat}><h3>{cat}</h3>
        {m.products.filter(p => p.category === cat).map(p => (
          <div className="item" key={p.id}><span>{p.name}<br /><small>{inr(p.price)}</small></span>
            <span className="qty"><button aria-label={`Remove ${p.name}`} onClick={() => add(p.id, -1)}>−</button>{cart[p.id] || 0}<button aria-label={`Add ${p.name}`} onClick={() => add(p.id, 1)}>+</button></span></div>))}
      </section>))}
    {!m.products.length && <p className="note">Nothing is available right now.</p>}
    <div className="stickybtn"><button className="pri wide" disabled={!total || busy} onClick={send}>{busy ? 'Placing…' : `Place order · ${inr(total)}`}</button></div>
  </>);
}

function OrdersTab({ m, onCount }) {
  const [rows, setRows] = useState(null), [ref, setRef] = useState({}), [msg, setMsg] = useState('');
  const load = useCallback(() => { const tokens = store('bm_orders').filter(o => o.key === link).map(o => o.token); return tokens.length ? api(`/public/track?tokens=${tokens.join(',')}`).then(r => { setRows(r); onCount(r.filter(o => ['pending', 'served'].includes(o.status)).length); }).catch(() => {}) : setRows([]); }, []);
  useEffect(() => { load(); const t = setInterval(() => !document.hidden && load(), 8000); return () => clearInterval(t); }, [load]);
  const claim = async o => { try { await api(`/public/track/${o.token}/claim`, { method: 'POST', body: { ref: ref[o.token] } }); setMsg(''); load(); } catch (e) { setMsg(e.message); } };
  if (!rows) return <p className="note">Loading…</p>;
  return (<>
    {msg && <p className="err">{msg}</p>}
    {rows.map(o => (<div className="card ord" key={o.token}>
      <div className="row"><b>Order #{o.no}</b><b>{inr(o.total)}</b></div>
      <small>{o.table_name || ''} {new Date(o.created_at).toLocaleTimeString()}</small>
      {o.status === 'cancelled'
        ? <p className="err">Cancelled{o.cancel_reason ? `: ${o.cancel_reason}` : ''}</p>
        : <ol className="steps">{STEPS.map((s, i) => <li key={s} className={i <= STEPS.indexOf(o.status) ? 'done' : ''}>{STEP_LABEL[s]}</li>)}</ol>}
      <p className="lines">{o.items.map(i => `${i.qty}× ${i.name}`).join(', ')}</p>
      {o.pay_claimed_at && o.status !== 'paid' && o.status !== 'cancelled' && <p className="note">Thanks — we are confirming your payment.</p>}
      {isMobile() && o.can_pay && <div className="pay">
        <a className="pri btn" href={o.upi_link}>Pay {inr(o.total)} with UPI</a>
        <input placeholder="UPI reference (optional)" value={ref[o.token] || ''} onChange={e => setRef({ ...ref, [o.token]: e.target.value })} />
        <button onClick={() => claim(o)}>I have paid</button>
        <small className="note">Paying here is optional. You can always pay at the counter.</small></div>}
    </div>))}
    {!rows.length && <p className="note">No orders yet on this phone. Place an order from the Menu tab.</p>}
  </>);
}

function HelpTab({ m, customer, setCustomer, label }) {
  const [text, setText] = useState(''), [msg, setMsg] = useState(''), [list, setList] = useState([]);
  const load = useCallback(() => { const tokens = store('bm_reqs').filter(r => r.key === link).map(r => r.token); if (tokens.length) api(`/public/requests?tokens=${tokens.join(',')}`).then(setList).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(() => !document.hidden && load(), 8000); return () => clearInterval(t); }, [load]);
  const send = async (type, message) => {
    setMsg('');
    try { const r = await api('/public/request', { method: 'POST', body: body({ type, message, customer }) }); store('bm_reqs', [{ token: r.token, key: link }, ...store('bm_reqs')].slice(0, 20)); setText(''); setMsg('Sent. Our team has been notified.'); setTimeout(load, 300); }
    catch (e) { setMsg(e.message); }
  };
  return (<>
    <NameField m={m} customer={customer} setCustomer={setCustomer} />
    <div className="two"><button className="pri" onClick={() => send('waiter')}>🙋 Call waiter</button><button onClick={() => send('bill')}>🧾 Bring the bill</button></div>
    <h3>Ask a question</h3>
    <textarea rows="3" maxLength="500" placeholder="e.g. Do you have draught beer? Is there a happy hour?" value={text} onChange={e => setText(e.target.value)} />
    <button className="wide" disabled={text.trim().length < 3} onClick={() => send('enquiry', text)}>Send enquiry</button>
    {msg && <p className="note">{msg}</p>}
    {list.map(r => <div className="card" key={r.token}><b>{{ waiter: 'Waiter called', bill: 'Bill requested', enquiry: 'Your question' }[r.type]}</b> <small>· {{ open: 'waiting', ack: 'on the way', done: 'done' }[r.status]}</small>
      {r.message && <p className="lines">{r.message}</p>}{r.reply && <p><b>Reply:</b> {r.reply}</p>}</div>)}
  </>);
}

function FeedbackTab({ m, customer }) {
  const [rating, setRating] = useState(0), [comment, setComment] = useState(''), [name, setName] = useState(''), [done, setDone] = useState(false), [msg, setMsg] = useState('');
  const last = store('bm_orders').find(o => o.key === link)?.token;
  const send = async () => { try { await api('/public/feedback', { method: 'POST', body: body({ rating, comment, name, order_token: last }) }); setDone(true); } catch (e) { setMsg(e.message); } };
  if (done) return <p className="note">Thank you for your feedback! 🙏</p>;
  return (<>
    <h3>How was your visit?</h3>
    <div className="stars" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map(n => <button key={n} role="radio" aria-checked={rating === n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}</div>
    <textarea rows="4" maxLength="1000" placeholder="Tell us more (optional)" value={comment} onChange={e => setComment(e.target.value)} />
    <input placeholder="Your name (optional)" value={name} onChange={e => setName(e.target.value)} />
    {msg && <p className="err">{msg}</p>}
    <button className="pri wide" disabled={!rating} onClick={send}>Send feedback</button>
  </>);
}
