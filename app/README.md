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
| `TRUST_PROXY` | unset | Set behind a load balancer so the audit trail records the client IP, not the proxy's |
| `NODE_ENV` | unset | `production` adds `Secure` to the session cookie and disables the seed script |

## How the app relies on the database

- **Row-level security.** Every request runs in its own transaction as `cde_app`, with `app.user_id` and `app.client_ip` set transaction-locally. The database, not the API code, decides what each user can see and change. A bug in a route can't leak another organisation's WIP.
- **Production login role.** Connect as a login role that is a member of `cde_app` but owns nothing, e.g. `CREATE ROLE cde_api LOGIN PASSWORD '…' IN ROLE cde_app;`. In development a superuser works because of `SET LOCAL ROLE cde_app`, but don't run production that way.
- **Uploads.** Files are stored under their SHA-256, computed by the server while receiving the bytes. The client never supplies the hash.
- **Downloads and previews.** Each one is written to the audit chain before any bytes are sent. Only PDF and common image types may display inline. Everything else is sent as an attachment with `Content-Security-Policy: sandbox`, so an uploaded HTML file cannot run script on the app's origin.
- **Sessions and CSRF.** Sessions are server-side, and only the token's hash is stored. The cookie is `HttpOnly` and `SameSite=Strict`. State-changing requests must also carry an `X-CDE-Request` header.

## Not built yet

- Admin screens for projects, organisations, members and code lists. Today the seed script or SQL does this.
- Password reset, SSO/SAML and MFA. There is no login rate limiting either; put one in front of `/api/auth/login`.
- Page-accurate PDF pinning. Inspections can be pinned to image sheets only. PDF sheets need pdf.js rendering.
- Markups, multi-step review workflows, RFIs and other correspondence, full-text search, and email notifications.
- S3 storage with Object Lock, and export of the audit chain heads to WORM storage. `src/storage.js` is the seam for S3.
- Cleanup of orphaned uploads, i.e. files uploaded but never attached to a revision.
