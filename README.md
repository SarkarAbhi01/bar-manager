# Bar Manager (multi-bar SaaS)

Stock, sales, purchases, reports and audit trail for bars, with Global QR, Table QR and Manual ordering.
Now one installation serves **many bars**, run by a **SuperAdmin** (platform owner).
Stack: React (Vite) · Node.js · Express · PostgreSQL.

## Who can do what
| | Customer | Staff | Bar Admin | SuperAdmin |
|---|---|---|---|---|
| Menu, order, track, call waiter, enquiry, feedback, optional UPI pay | ✅ | | | |
| New sale; see **own** orders (+ waiting customer orders); mark served/paid; **own report** | | ✅ | ✅ | |
| Cancel an order (reason **required**) | | only if admin allowed it, not paid orders | ✅ | |
| Stock/purchases/tables/QR, all orders, staff-wise collection report, users, feedback, settings | | – | ✅ | |
| Audit log tab | | – | ✅ if switched on | |
| Create bars + admin logins, plans, subscriptions, backups, enable/disable bars | | | | ✅ |

## What changed (your 8 points)
1. **SuperAdmin** → *Bars*: creates a bar + its Admin login + a plan in one step; add more admin logins, reset passwords, disable a bar. *Plans*: Monthly, Quarterly, Half-yearly, Yearly, **Commission (% of paid sales)** and **Long-term** (any number of months). You can **decrease** later: lower a plan's price/months, or on a bar *Reduce / extend* the running subscription (shift end date by ±months or set an exact date, with a required note). Expired or disabled bars cannot log in and their QR menus close. Every platform action is in *Platform log* (never visible to bars).
2. **Audit log toggle**: Bar Admin → *Settings* switch (SuperAdmin can also flip it per bar). Hiding only hides the tab/API; everything is still recorded.
3. **Ownership & collection**: every order stores *taken by* and *collected by* (+ cash/UPI/card, time). Staff see only their own orders (plus unclaimed customer QR orders, which they can **Accept**). *My report* = own orders, sales, collection. Admin *Dashboard* has a **staff-wise orders & collection** table; admin can filter orders by person.
4. **Cancel permission**: Bar Admin → *Users* → “Can cancel orders” switch per staff. A reason (5+ chars) is mandatory, saved on the order and in the audit log. Staff can't cancel paid orders.
5. **Customer side** (`/menu`): order, **live tracking** (Received → Served → Paid, refreshes every 8s), **Call waiter / Bring bill / Ask a question** (staff reply shown to the customer), **feedback** (1–5 ★ + comment). Staff see requests in *Requests* (badge in the header); admin reads *Feedback*.
6. **Optional customer payment**: Bar Admin → *Settings*: enter UPI ID and switch on. On **phones/tablets/iPad/iOS only**, orders show “Pay ₹X with UPI” (opens the customer's UPI app) and “I have paid”. Paying is never required — the customer can always pay at the counter. A UPI link cannot confirm payment automatically, so “I have paid” only flags the order; **staff verify and mark Paid**. (For automatic confirmation you'd integrate a gateway such as Razorpay — not included.)
7. **Backups**: SuperAdmin → *Backups*: Excel (`.xlsx`, one sheet per table) or `.bak` for the whole platform or one bar. Switch *Backup enabled* on a bar to let that bar's admin download **only their own** data. `.bak` is a plain SQL script (PostgreSQL has no native “.bak”): restore a whole-platform file into an empty DB with `npm run restore --prefix server -- file.bak` (or `psql -f file.bak`). Excel never contains passwords/tokens; bar-admin `.bak` has password hashes blanked.
8. **No overlap between bars**: every data row carries `bar_id`; every query filters by the logged-in user's bar; products/tables used in an order must belong to the same bar; public QR links resolve the bar from the table token / bar slug only; order numbers are per bar. `server/test/e2e.mjs` checks 95 cross-bar and permission cases.

## Upgrading your existing database
Just start the new server. Existing data moves into one bar named **My Bar** (rename it in SuperAdmin) with a free 12-month yearly subscription; existing admin/staff stay as that bar's users. A SuperAdmin is created from `SUPER_USER` / `SUPER_PASS`.
**Reprint the Global QR** from *Tables & QR* — it now contains the bar (`/menu?b=<slug>`). The old Global QR keeps working only while the platform has exactly one bar. Table QRs are unchanged.
Take a backup of your database before upgrading.

## Quick start
```bash
docker compose up -d                 # PostgreSQL (or your own; edit DATABASE_URL)
cp server/.env.example server/.env   # set JWT_SECRET, PUBLIC_URL, SUPER_PASS
npm run install:all
npm run seed                         # optional: "Demo Bar" (demo / demo123)
npm run dev:server                   # API :4000 (tables/migration run automatically)
npm run dev:client                   # app http://localhost:5173
```
Sign in as the SuperAdmin (`SUPER_USER`/`SUPER_PASS`, default `superadmin` / `super123`) → change the password in *Account* → *Bars* → create a bar.

Tests (use a throw-away database): `npm test --prefix server` with the server running.

## Production
```bash
npm run build && npm start      # Express serves API + built app on :4000
```
Strong `JWT_SECRET`, HTTPS (Nginx/Caddy), `PUBLIC_URL` = your domain, `TRUST_PROXY=1` behind a proxy. Backups are generated in memory — fine for normal bars; for very large data use `pg_dump` on the server as well.

## API additions (all `/api`)
`/super/*` SuperAdmin · `/me`, `/settings`, `/account/password` · `/reports/mine`, `/reports/staff` · `POST /orders/:id/accept` · `PATCH /orders/:id/status` `{status, pay_method, reason}` · `/requests`, `/feedback` · `/backup/xlsx|bak` · public: `/public/menu|order|track|track/:token/claim|request|requests|feedback`.

## Known limits
Per-process rate limiting (use Redis/`express-rate-limit` for several servers) · no GST/KOT printing · UPI deep links depend on the customer's UPI app (iOS support varies) · usernames are unique across the whole platform.
