export const auth = () => { try { return JSON.parse(localStorage.getItem('auth')); } catch { return null; } };
export const saveAuth = d => localStorage.setItem('auth', JSON.stringify(d));
export const clearAuth = () => localStorage.removeItem('auth');
export const isAdmin = () => auth()?.user?.role === 'admin';
export const isSuper = () => auth()?.user?.role === 'superadmin';

export const api = async (path, opts = {}) => {
  const token = auth()?.token;
  const r = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) { clearAuth(); location.reload(); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
};
export const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

// Download the rows currently on screen (filters applied) as an Excel-friendly CSV
export function exportCsv(name, rows, cols) {
  const esc = v => { let s = String(v ?? ''); if (/^[=+@-]/.test(s) && isNaN(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.map(c => esc(c[0])), ...rows.map(r => cols.map(c => esc(c[1](r))))].map(r => r.join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// Download a file from an authenticated endpoint (Excel / .bak backups)
export async function download(path, fallbackName) {
  const r = await fetch('/api' + path, { headers: { Authorization: `Bearer ${auth()?.token}` } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
