import { createContext, useState, useEffect, useCallback } from 'react';
import { api, qs } from './api.js';

export const Ctx = createContext({ user: null, bar: null, refresh: () => {} });
export const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const when = d => d ? new Date(d).toLocaleString() : '';
export const day = d => d ? String(d).slice(0, 10) : '—';
export const bind = (f, set, k) => ({ value: f[k], onChange: e => set({ ...f, [k]: e.target.value }) });

export function useApi(path, params = {}, init = []) {
  const [data, setData] = useState(init), [error, setError] = useState('');
  const key = JSON.stringify(params);
  const load = useCallback(() => api(`${path}?${qs(params)}`).then(d => { setData(d); setError(''); }).catch(e => setError(e.message)), [path, key]);
  useEffect(() => { load(); }, [load]);
  return [data, load, error];
}
export const Th = ({ k, label, s, set }) => (
  <th className="sortable" onClick={() => set({ sort: k, dir: s.sort === k && s.dir === 'asc' ? 'desc' : 'asc' })}>
    {label}{s.sort === k ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ''}
  </th>);
export const Empty = ({ rows, text }) => rows.length ? null : <p className="note">{text}</p>;
export const Status = ({ s }) => <b className={s}>{s}</b>;
export const SOURCE = { GLOBAL_QR: 'Global QR', TABLE_QR: 'Table QR', MANUAL: 'Manual' };
export const Switch = ({ on, onChange, label, hint, disabled }) => (
  <label className={'switch' + (disabled ? ' off' : '')}>
    <input type="checkbox" role="switch" checked={!!on} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <span className="track"><span className="knob" /></span>
    <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
  </label>);
export const run = async (fn, after) => { try { await fn(); after && after(); } catch (e) { alert(e.message); } };
