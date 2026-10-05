# ASTCO Procurement & Logistics

Invitation-only procurement platform for ASTCO:

- **Procurement dashboard** (`/procurement.html`): procurement managers and staff describe a requirement (part, device, component or unit), pick vendor categories (discipline, product type, service, or any group you add), and the RFQ is **dispatched instantly to every registered vendor that supplies them**.
- **Supplier portal** (`/vendor.html`): vendors keep a product and price catalog, declare their supply categories, receive matching RFQs and submit or revise quotations.
- **Confidentiality is enforced on the server.** Every vendor query is scoped to the caller's own `vendor_id`. A vendor can never read another vendor's products, prices, quotes or award outcomes. Procurement users can see all catalogs and quotes.
- **Registration is by invitation only.** Managers and admins create single-use links that expire after 7 days. Only a hash of each token is stored.

The earlier project-controls modules (Control Tower, MTO, TBE/CBE, Expediting, Logistics, Laydown/CWP) are kept as-is in the procurement dashboard. **They still run on in-browser sample data and are not persisted.** They are marked "demo data" in the navigation. The MTO table's **RFQ** button now hands the line item to the live RFQ form.

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`, `node:http`, `node:crypto` and `node:test` modules).
- **No runtime npm dependencies.** Tailwind CSS, Phosphor Icons and Chart.js are pre-built into `public/vendor/` and committed, so the server does not depend on CDNs. Google Fonts is the only external request; if it fails, the pages fall back to system fonts.
- If you change Tailwind classes in `public/`, rebuild the assets: `npm install && npm run build:assets` (dev dependencies: tailwindcss 3.4.19, @phosphor-icons/web 2.1.1, chart.js 4.5.1).

## Quick start

```bash
npm run create-admin -- you@astco.com "Your Name"   # prints a generated password
npm start                                           # http://localhost:3000
```

Sign in as the admin, open **Vendor Network**, and invite procurement managers, staff and vendors. Each invitation produces a registration link that you send to the invitee yourself (email delivery is not built in).

To evaluate with sample vendors and catalogs:

```bash
npm run seed-demo     # prints demo logins (manager, staff, 4 vendors)
```

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_FILE` | `data/astco.db` | SQLite database file |
| `COOKIE_SECURE` | unset | Set to `1` when served over HTTPS (required in production). Also enables HSTS |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy or PaaS, so rate limits use the real client IP from `X-Forwarded-For` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | unset | Creates the first administrator on startup, but only while the database has no users. Remove `ADMIN_PASSWORD` afterwards |
| `DROP_PRIVILEGES_TO` | unset (`node` in Docker) | If started as root, hand the data directory to the app user and switch to it before opening the database |

## Deployment

The app is one Node process plus one SQLite file. It needs a host that can run a container **with a persistent disk**. Without one, every redeploy wipes all vendors, RFQs and quotes.

### Docker (any VPS or container host)

```bash
docker build -t astco-procurement .
docker run -d --name astco -p 3000:3000 -v astco-data:/data \
  -e ADMIN_EMAIL=you@astco.com -e ADMIN_PASSWORD='choose-a-strong-one-123' \
  astco-procurement
```

The image already sets `COOKIE_SECURE=1`, `TRUST_PROXY=1` and `DB_FILE=/data/astco.db`, so it **must be served over HTTPS**: put it behind a TLS-terminating proxy such as Caddy, nginx or the platform's load balancer. Over plain HTTP, browsers will not keep the session cookie and login will appear to do nothing. The container starts as root only long enough to fix ownership of `/data`, then runs as the unprivileged `node` user. Health check: `GET /healthz`.

### Render (Blueprint included)

1. In Render: **New → Blueprint**, then connect this GitHub repository. Render reads `render.yaml`.
2. When prompted, set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 10 characters, with letters and numbers) and optionally `ADMIN_NAME`.
3. After the first successful deploy, sign in, then delete `ADMIN_PASSWORD` from the service's environment.

The blueprint uses the `starter` plan because persistent disks are not available on Render's free tier.

### Backups

Copy `/data/astco.db` together with its `-wal` and `-shm` files while the app is stopped, or use `sqlite3 astco.db ".backup backup.db"` while it is running.

## How vendor matching works

Selected categories are grouped by kind (discipline, product type, service, ...):

- **Within a group: OR.** Selecting *Valves* and *Pumps* reaches vendors who supply either.
- **Across groups: AND.** Selecting *Piping* (discipline) and *Valves* (product type) reaches only vendors who match both.

A vendor "supplies" a category if it declared it, or if it lists an active product in that category. Suspended vendors never receive RFQs. Before dispatching, the manager sees the matched vendors and can untick any of them.

## RFQ lifecycle

1. **Open:** vendors submit and can revise quotes until the deadline. Vendors can also decline.
2. **Sealed bids** (the default): procurement sees who has quoted but not the prices until the deadline passes or a manager closes bidding early.
3. **Closed:** quotes are revealed in a comparison table (lowest total and fastest lead time are highlighted).
4. **Awarded:** the manager awards one quote. Each vendor sees only its own outcome (awarded or not awarded), never the winner or the winning price.

## Roles

| Role | Can do |
|---|---|
| `admin` | Everything; invite any role |
| `procurement_manager` | Dispatch RFQs, close/award/cancel, invite vendors and staff, suspend vendors, manage categories |
| `procurement_staff` | Dispatch RFQs, view quotes once unsealed, browse vendors and catalogs |
| `vendor` | Own catalog, own categories, RFQs addressed to them, own quotes |

## Security notes

- Passwords are hashed with scrypt (`node:crypto`). Sessions are random 256-bit tokens in `HttpOnly; SameSite=Strict` cookies, stored hashed and expiring after 12 hours.
- Mutating API calls require `Content-Type: application/json` and reject cross-origin `Origin` headers. This is CSRF defence in depth on top of the SameSite cookie.
- Login and registration are rate-limited per IP (in memory, so the limit resets when the server restarts).
- `Referrer-Policy: no-referrer` keeps invitation tokens from leaking to CDNs.
- All server data is HTML-escaped before it is rendered.
- An audit log records logins, registrations, invitations, dispatches, quotes and awards (`GET /api/audit`, managers only).

## Before going to production

- **Serve over HTTPS** and set `COOKIE_SECURE=1` (the Docker image sets it already).
- **Add email delivery** for invitations and RFQ notifications. Today, links are copied by hand and vendors see new RFQs when they sign in.
- `node:sqlite` is still flagged experimental in Node 22. Back up `data/astco.db`; WAL mode is enabled.

## Tests

```bash
npm test
```

The API tests cover: invitation-only and single-use registration, role restrictions, vendor-to-vendor price isolation, matching rules, sealed bids, award outcome privacy, suspension, CSRF guards and path traversal.
