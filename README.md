# ASTCO Procurement & Logistics

Invitation-only procurement platform for ASTCO:

- **Procurement dashboard** (`/procurement.html`): procurement managers and staff describe a requirement (part, device, component or unit), pick vendor categories (discipline, product type, service, or any group you add), and the RFQ is **dispatched instantly to every registered vendor that supplies them**.
- **Supplier portal** (`/vendor.html`): vendors keep a product and price catalog, declare their supply categories, receive matching RFQs and submit or revise quotations.
- **Confidentiality is enforced on the server.** Every vendor query is scoped to the caller's own `vendor_id`. A vendor can never read another vendor's products, prices, quotes or award outcomes. Procurement users can see all catalogs and quotes.
- **Registration is by invitation only.** Managers and admins create single-use links that expire after 7 days. Only a hash of each token is stored.

The earlier project-controls modules (Control Tower, MTO, TBE/CBE, Expediting, Logistics, Laydown/CWP) are kept as-is in the procurement dashboard. **They still run on in-browser sample data and are not persisted.** They are marked "demo data" in the navigation. The MTO table's **RFQ** button now hands the line item to the live RFQ form.

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`, `node:http`, `node:crypto` and `node:test` modules).
- **No npm dependencies.** The browser pages load Tailwind (Play CDN), Phosphor Icons, Google Fonts and Chart.js from public CDNs.

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
| `COOKIE_SECURE` | unset | Set to `1` when served over HTTPS (required in production) |

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

- **Serve over HTTPS** and set `COOKIE_SECURE=1`.
- **Replace the Tailwind Play CDN** with a compiled stylesheet. Tailwind does not support the Play CDN for production, and if the CDN is unreachable the pages render unstyled.
- **Add email delivery** for invitations and RFQ notifications. Today, links are copied by hand and vendors see new RFQs when they sign in.
- `node:sqlite` is still flagged experimental in Node 22. Back up `data/astco.db`; WAL mode is enabled.

## Tests

```bash
npm test
```

The API tests cover: invitation-only and single-use registration, role restrictions, vendor-to-vendor price isolation, matching rules, sealed bids, award outcome privacy, suspension, CSRF guards and path traversal.
