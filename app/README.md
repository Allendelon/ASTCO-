# ASTCO CDE web app

A web app for the document register, transmittals, site inspections and audit trail. It is built on the schema in [`../db`](../db/README.md).

- **Server:** Node.js 22, `express@4.22.3` and `pg@8.23.0`. Everything else comes from the Node standard library: scrypt password hashing, SHA-256 hashing, streamed uploads and `node:test`.
- **Frontend:** plain ES modules with no build step.

## Run it locally

You need PostgreSQL 15 or later and Node 22.

```sh
createdb cde
cd app
npm install
export DATABASE_URL=postgres://postgres@localhost:5432/cde
npm run migrate      # applies db/migrations, tracked in schema_migrations
npm run seed         # demo project, users and documents (refuses if NODE_ENV=production)
npm start            # http://localhost:3000
```

The seed prints the demo accounts. The password is `cde-demo-2026` unless you set `SEED_PASSWORD`. Sign in as different people to see the organisation boundaries:

| Account | Organisation | What to try |
|---|---|---|
| `dc@astco.test` | Contractor, document controller | Register documents, upload revisions, change status, issue transmittals |
| `site@astco.test` | Contractor, member | Request inspections pinned to a sheet |
| `mep@meridian.test` | Consultant, member | Review transmittals. The contractor's WIP is not visible from this account. |
| `pm@rda.test` | Client, admin | Audit trail and chain verification |

## Tests

```sh
TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test
```

The API tests create a throwaway database, run the migrations and seed, and start the server. They then cover sign-in and CSRF, WIP isolation, revision numbering, immutability, download auditing, the transmittal review cycle, inspections and audit access. Database-level tests live in `db/tests/run.sh`. CI runs both (`.github/workflows/ci.yml`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres@localhost:5432/cde` | Connection string |
| `PORT` | `3000` | HTTP port |
| `STORAGE_DIR` | `app/storage` | Where uploaded files are kept, named by their SHA-256 |
| `MAX_UPLOAD_MB` | `500` | Upload size limit |
| `SESSION_TTL_HOURS` | `12` | Session lifetime |
| `TRUST_PROXY` | unset | Behind a load balancer: the number of proxy hops (e.g. `1`) or the proxy subnets, so the audit trail records the client IP. `true` is refused because clients could then choose their own IP |
| `NODE_ENV` | unset | `production` refuses to start with a privileged database role and disables the seed script |
| `COOKIE_SECURE` | `true` | Session cookie is `__Host-` prefixed and `Secure`, and HSTS is sent. Set `false` only for plain-HTTP development on a host other than localhost |
| `DAILY_UPLOAD_GB` | `20` | Upload volume allowed per user in any 24 hours |
| `LOGIN_MAX_FAILURES_PER_IP` / `_PER_ACCOUNT` / `_PER_ACCOUNT_GLOBAL` | `30` / `10` / `100` | Failed sign-ins allowed per 15 minutes before `429`: per client (IPv6 counted per /64), per account from one client, and per account from anywhere |
| `REQUEST_TIMEOUT_MS` | `900000` | Longest a single request (e.g. an upload) may take |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Longest wait for a database connection before answering `503` |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | Longest single query. Raise it if audit verification of a very long chain needs more |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Longest wait for a lock held by someone else (a migration, a long report) before `503` |
| `DB_IDLE_TX_TIMEOUT_MS` | `60000` | The server ends a transaction left open with nothing running |
| `SHUTDOWN_GRACE_MS` | `25000` | On SIGTERM, how long in-flight requests get to finish. Keep it below your orchestrator's kill timeout |
| `ALLOW_PRIVILEGED_DB_ROLE` | unset | `1` overrides the production role check. Do not use this in production |

## How the app relies on the database

- **Row-level security.** Every request runs in its own transaction as `cde_app`, with `app.user_id` and `app.client_ip` set transaction-locally. The database, not the API code, decides what each user can see and change. A bug in a route can't leak another organisation's WIP.
- **Production login role.** Connect as a login role that is a member of `cde_app` but owns nothing, e.g. `CREATE ROLE cde_api LOGIN PASSWORD '…' IN ROLE cde_app;`. Run migrations with the owner role separately. With `NODE_ENV=production` the server refuses to start as a superuser, a `BYPASSRLS` role or the table owner. In development it only warns.
- **Uploads.** Files are stored under their SHA-256, computed by the server while receiving the bytes. The client never supplies the hash. Each upload is recorded against its uploader and project, and the database lets a revision use it only once, by that person, within 24 hours. The content type shown inline comes from the file's bytes, not from the browser's claim.
- **Downloads and previews.** Each one is written to the audit chain before any bytes are sent. Only PDF and common image types may display inline. Everything else is sent as an attachment with `Content-Security-Policy: sandbox`, so an uploaded HTML file cannot run script on the app's origin.
- **Sessions and CSRF.** Sessions are server-side, and only the token's hash is stored. The cookie is `HttpOnly` and `SameSite=Strict`. State-changing requests must also carry an `X-CDE-Request` header.

## Security

See [`../docs/SECURITY-AUDIT.md`](../docs/SECURITY-AUDIT.md) for the review, the fixes, and what is still open.

## Not built yet

- Admin screens for projects, organisations, members and code lists. Today the seed script or SQL does this.
- Password reset, SSO/SAML and MFA. There is no login rate limiting either; put one in front of `/api/auth/login`.
- Page-accurate PDF pinning. Inspections can be pinned to image sheets only. PDF sheets need pdf.js rendering.
- Markups, multi-step review workflows, RFIs and other correspondence, full-text search, and email notifications.
- S3 storage with Object Lock, and export of the audit chain heads to WORM storage. `src/storage.js` is the seam for S3.
- Cleanup of orphaned uploads, i.e. files uploaded but never attached to a revision.
