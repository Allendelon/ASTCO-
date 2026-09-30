# Security review: ASTCO CDE

**Scope:** `app/` (Node API and browser UI), `db/migrations/` (schema, RLS, triggers, functions), and `.github/workflows/ci.yml`. Reviewed at commit `2ab1897`. Fixes are in the commit that adds this file.

**Method:** a manual review of every route, SQL statement, RLS policy, `SECURITY DEFINER` function and trigger, plus the HTTP and cookie configuration and the deployment defaults. Each fixed finding has a regression test that asserts the secure behaviour: `app/test/api.test.js` (tests named `SEC-…`) and `db/tests/test_schema.sql`. The full browser flow was re-run afterwards in production mode (`NODE_ENV=production`) as an unprivileged database role.

**Dependencies:** `npm audit` reports 0 known vulnerabilities in `express@4.22.3` and `pg@8.23.0` (2026-09-30).

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-01 | High | WIP files readable by other organisations through reusable file keys | Fixed |
| SEC-02 | High | Inspection requester could record their own inspection as passed; results could be changed later | Fixed |
| SEC-03 | Medium | Audit trail disclosed other organisations' WIP activity and downloads | Fixed |
| SEC-04 | Medium | No sign-in throttling; weak scrypt cost; scrypt held a DB connection (pool exhaustion) | Fixed |
| SEC-05 | Medium | Session cookie not `Secure` by default; no HSTS; API responses cacheable | Fixed |
| SEC-06 | Medium | App would run as a superuser/owner database role, silently disabling RLS | Fixed |
| SEC-07 | Medium | `TRUST_PROXY` misparsed; `true` allowed spoofed IPs in the audit trail | Fixed |
| SEC-08 | Medium | Unlimited upload volume per user (disk exhaustion) | Fixed |
| SEC-09 | Low | Client-declared content type trusted for inline rendering | Fixed |
| SEC-10 | Low | Database error details returned to clients | Fixed |
| SEC-11 | Low | Viewers could delete their organisation's draft transmittals | Fixed |
| SEC-12 | Low | Sessions never purged; no password-hash upgrade; malformed cookie caused 500 | Fixed |
| SEC-13 | Low | Unbounded list inputs, LIKE wildcards and credential lengths | Fixed |
| SEC-14 | Medium | Inline PDF previews are served from the application's own origin | Open |
| SEC-15 | Medium | No malware scanning of files exchanged between organisations | Open |
| SEC-16 | Medium | Local-disk storage: no encryption at rest, no Object Lock, no external audit anchoring | Open |
| SEC-17 | Medium | No SSO, MFA, password reset or admin provisioning UI | Open |
| SEC-18 | Low | The app role can mint sessions and write audit events for any user | Open |
| SEC-19 | Low | Rate limits are per process, not shared across instances | Open |
| SEC-20 | Low | CI token had default permissions; actions pinned by tag, not commit SHA | Partly fixed |

---

## Fixed findings

### SEC-01 High: WIP files readable by other organisations through reusable file keys

**Where:** `POST /api/documents/:id/revisions`, `cde_document_revisions`, `app/src/storage.js`

Files are stored under their SHA-256. A new revision accepted any `object_key` that existed in storage. Nothing checked who had uploaded that file or in which project. So knowing a file's hash was enough to attach the file to a document you own, and then download it.

Hashes were not secret. They appear on every document page, and in the audit trail as `REVISION_UPLOADED` details. Before SEC-03 was fixed, admins and document controllers of every organisation could read those audit entries, including uploads to other organisations' WIP.

**Scenario:** the client's project admin reads the audit trail and finds the hash of the contractor's work-in-progress drawing, which the client is not supposed to see. They register a document under their own organisation and create a revision pointing at that hash, then download the contractor's unreleased drawing. The same works across projects for anyone who has seen a hash. This defeats the core ISO 19650 promise that WIP stays inside the task team.

**Fix:** `0008_security_hardening.sql`
- Every upload is recorded in `cde_uploads` with its uploader, project, size and detected type. RLS makes each user's uploads visible only to them.
- A trigger (`cde_revisions_claim_upload`) only accepts an `object_key` that the current user uploaded to the same project within 24 hours and hasn't used yet. It claims the upload atomically, so each upload is single-use. Size and inline type are taken from the upload record, not from the request.
- A new constraint requires `object_key = encode(sha256, 'hex')` for new rows.
- Tests: `SEC-01` in the API suite; "upload binding" in the DB suite.

### SEC-02 High: inspection results could be self-approved and changed later

**Where:** `site_inspections` RLS and `PATCH /api/inspections/:id`

The update policy allowed the creator or the assignee to change an inspection, and any status change was accepted at any time.

**Scenario:** a site engineer raises a work inspection request (WIR) assigned to the consultant, then marks it `INSPECTED_PASS` themselves. Work gets covered up without anyone inspecting it. In a separate case, a failed inspection is quietly changed to passed weeks later. QA/QC records that can be edited this way are no use as evidence in a dispute or a handover audit.

**Fix:**
- Only the assignee can update an inspection.
- A trigger (`site_inspections_guard`) allows exactly one change, `REQUESTED` to a result, and freezes every other column.
- New inspections must start as `REQUESTED`.
- Pins must reference shared or published revisions. Before, a foreign key check (which ignores RLS) let an inspection point at another organisation's WIP revision.
- The UI shows Pass/Fail only to the assignee.
- Tests: `SEC-02`; inspection block in the DB suite.

Still a policy decision for you: a creator can assign an inspection to themselves. That suits safety self-checks but not WIRs. If WIRs must be inspected by another organisation, add that as a rule.

### SEC-03 Medium: audit trail disclosed other organisations' activity

**Where:** `audit_select` policy

Any `ADMIN` or `DOC_CONTROLLER` could read every audit entry in the project. That included uploads, status changes and deletions of other organisations' WIP revisions (revision labels, file hashes, revision ids), and every user's downloads.

**Scenario:** a competitor's document controller on a shared project watches your team's WIP churn and who read which documents. The hashes also fed SEC-01.

**Fix:**
- Revision events are visible only if the revision is visible to you under RLS, or if the actor belongs to your organisation.
- Download events are visible within your own organisation, or to project admins for revisions they can see.
- Chain verification still covers every entry, because it runs as `SECURITY DEFINER`.
- Tests: `SEC-03`; DB suite.

### SEC-04 Medium: no sign-in throttling; weak scrypt cost; pool exhaustion

**Where:** `app/src/auth.js`

- Unlimited password guesses were possible.
- The scrypt cost was N=2¹⁴, below the OWASP minimum of 2¹⁷.
- `login()` ran scrypt (tens of milliseconds, more at the new cost) inside a database transaction. Each concurrent login attempt held one of the 10 pooled connections.

**Scenario:** a credential-stuffing run against `/api/auth/login` tries leaked passwords with no limit. Even without a single hit, a burst of parallel requests holds every database connection, and the whole application stops serving users.

**Fix:**
- Failed attempts are limited per IP (30 per 15 minutes) and per account+IP (10). The response is `429` with `Retry-After`. Successful sign-ins aren't counted, and the per-account key includes the IP so an attacker can't lock a victim out from elsewhere.
- scrypt now runs outside any transaction.
- Cost is raised to N=2¹⁷. Existing hashes still verify and are upgraded transparently on the next sign-in, using a compare-and-swap in `auth_upgrade_password_hash`.
- Email and password lengths are capped.
- Test: `SEC-04`.

### SEC-05 Medium: cookie and transport headers

**Where:** `app/src/auth.js`, `app/src/server.js`

The session cookie was only `Secure` when `NODE_ENV=production`. A deployment that forgot the variable sent session tokens over any plain-HTTP hop. There was also no HSTS, no `X-Frame-Options` for older browsers, no COOP/CORP, and authenticated JSON could be cached.

**Fix:**
- The cookie is `Secure` by default and named `__Host-cde_session`. The browser then rejects it unless it is Secure, host-only and `Path=/`, so a compromised sibling subdomain can't plant or overwrite it.
- Added HSTS, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, an explicit `script-src`/`object-src` in the CSP, and `Cache-Control: no-store` on `/api`.
- Test: `SEC-05`.

### SEC-06 Medium: the app would run as a privileged database role

**Where:** `DATABASE_URL` default, `app/src/db.js`

The documented default connected as `postgres`. The app then relied on `SET LOCAL ROLE cde_app` in each transaction. As a superuser, owner or `BYPASSRLS` role, any mistake in that path, now or in future code, means no row-level security at all.

**Fix:** at startup the server checks its session role. With `NODE_ENV=production` it refuses to start if the role is a superuser, has `BYPASSRLS`, owns the tables, or isn't in `cde_app`. In development it only warns. Verified: production mode with `postgres` exits with an explanation, and the full browser flow passes as a dedicated `cde_api` role.

### SEC-07 Medium: `TRUST_PROXY` handling

**Where:** `app/src/server.js`

The value was passed to Express as a string. Express reads a string as a list of trusted addresses, so the documented `TRUST_PROXY=1` meant "trust the address 1", not "trust one hop". `true` would have trusted any `X-Forwarded-For` header a client sends.

**Scenario:** a user who wants to deny downloading a document sets `X-Forwarded-For` to someone else's IP. The audit trail then records the forged address.

**Fix:** a number means hops, a comma-separated list means addresses or subnets, and `true` is refused at startup. Test: `SEC-08`.

### SEC-08 Medium: unlimited upload volume

**Where:** `PUT /api/projects/:pid/uploads`

Any member could upload 500 MB files without limit, and uploads that never became revisions were never cleaned up.

**Fix:**
- A per-user quota of 20 GB per 24 hours (`DAILY_UPLOAD_GB`), enforced before and during streaming.
- `Content-Length` is checked up front.
- Request and header timeouts are set.
- Unclaimed uploads are now identifiable (`cde_uploads.claimed_at IS NULL AND created_at < now() - 24h`) for a cleanup job, which is still to be scheduled.

### SEC-09 Low: client-declared content type trusted for inline display

The browser's claimed type decided whether a file could be shown inline. `nosniff` already prevented script execution, but the type was still attacker-chosen. The type is now detected from the file's leading bytes (PDF, PNG, JPEG, GIF, WebP) and enforced by the database. Anything else is always an attachment. Test: `SEC-06`.

### SEC-10 Low: database error details returned to clients

Unique and foreign-key errors returned Postgres `detail` text. That text names tables and key values, and can confirm that rows you can't see exist. Responses are now fixed, plain-language messages. Test: `SEC-07`.

### SEC-11 Low: viewers could delete draft transmittals

The delete policy checked the organisation but not the role. It now excludes `VIEWER`.

### SEC-12 Low: session hygiene

- Expired and old revoked sessions are purged when the user next signs in.
- Password hashes upgrade automatically (see SEC-04).
- A malformed cookie is now treated as signed out instead of causing a 500.
- Over-long tokens are ignored.

### SEC-13 Low: input bounds

- Transmittals accept at most 500 documents and 200 recipients, and reviews at most 500 responses.
- Search input is capped, and `%`/`_` are escaped so they match literally.

---

## Open findings and recommendations

### SEC-14 Medium: inline previews share the application's origin

PDFs and images are shown inline from the same origin as the app. For PDFs the `sandbox` CSP is dropped, because Chrome's viewer won't run inside it. Browser PDF viewers have had script-execution bugs, for example pdf.js CVE-2024-4367. If one recurs, a malicious PDF would run with the app's origin and session.

**Recommendation:** serve file content from a separate, cookieless origin, e.g. `files.<domain>`, with short-lived signed URLs issued by the API. Alternatively, render PDFs to images server-side for preview.

### SEC-15 Medium: no malware scanning

Transmittals are a trusted channel for moving files between companies, which makes them an efficient way to deliver malware. Scan every upload before it can be claimed by a revision, for example with ClamAV or a commercial ICAP scanner run from a job on `cde_uploads`. Quarantine anything flagged, and record the scan result on the upload.

### SEC-16 Medium: storage and audit durability

Files are on local disk with no encryption at rest and no immutability. The audit chain is tamper-evident, but a superuser could still rewrite it from any point onwards.

**Recommendation:**
- Move files to S3 or compatible storage with SSE-KMS and Object Lock in compliance mode. `src/storage.js` is the seam for this.
- Export `audit_chain_heads` hourly to a WORM bucket.
- Enable Postgres PITR backups.
- For NCA ECC/CCC, host in-region with customer-managed keys.

### SEC-17 Medium: identity

There is no MFA, SSO, password reset or account lifecycle UI. For an enterprise SaaS, add SAML/OIDC single sign-on per customer organisation and TOTP/WebAuthn MFA, at least for admins and document controllers. Make deprovisioning revoke sessions immediately: `auth_resolve_session` already checks `users.is_active`.

### SEC-18 Low: power of the app role

`cde_app` can call `auth_create_session` for any user id, and `audit_append` with any action name, for projects where the current user is a member. This only matters if the application itself is compromised, for example by remote code execution. The database can't distinguish the app from an attacker controlling it.

**Recommendation:** move authentication to a separate service or role. Restrict `audit_append` to an allow-list of actions the app is permitted to write directly (today only `DOCUMENT_DOWNLOADED`), and keep the rest trigger-only.

### SEC-19 Low: rate limits are per process

The limits in `src/ratelimit.js` live in memory. Behind a load balancer with N instances an attacker gets N times the budget. Move the counters to Redis or a Postgres table, or enforce limits at the edge (WAF / API gateway).

### SEC-20 Low: CI supply chain

Fixed: the workflow token is now `contents: read`.

Still open: pin `actions/checkout` and `actions/setup-node` to full commit SHAs, and enable Dependabot for npm and GitHub Actions.

## Second review (R2)

**Scope:** a second pass over the whole application, focused on the code the first round added (the rate limiter, upload binding, quotas and audit policies), since new security code is new attack surface. Reviewed at commit `57ee856`.

| ID | Severity | Finding | Status |
|---|---|---|---|
| R2-01 | Medium | IPv6 address rotation bypassed sign-in limits; the limiter table grew without bound | Fixed |
| R2-02 | Medium | Audit trail showed transmittal traffic and review codes to organisations not party to it | Fixed |
| R2-03 | Medium | Parallel uploads bypassed the daily quota (check-then-act race) | Fixed |
| R2-04 | Medium | An idle database connection error crashed the whole process | Fixed |
| R2-05 | Low | Demo seed could add known-password accounts to a live database | Fixed |
| R2-06 | Low | Unbounded free-text fields (message, review comments, location) | Fixed |
| R2-07 | Low | Audit listing can scan the whole table for users who can see few rows | Open |
| R2-08 | Low | Fonts load from Google on every page view | Open |
| R2-09 | Low | Sessions have a 12-hour absolute lifetime but no idle timeout or "sign out everywhere" | Open |

### R2-01 Medium: sign-in throttling bypass and limiter memory growth

**Where:** `app/src/ratelimit.js`, `app/src/auth.js`

The SEC-04 limits had three weaknesses:

- **IPv6 rotation.** Limits were keyed by exact IP address. An IPv6 subscriber normally controls a whole /64, about 1.8×10¹⁹ addresses, so rotating addresses removed the per-IP limit entirely.
- **Unbounded memory.** Every sign-in check created a table entry, even for successful sign-ins. Enough distinct emails and addresses grew memory until the process was killed.
- **Distributed guessing.** The per-account limit was per account *and* IP, so a botnet could guess one account's password without limit.

**Scenario:** a password-spraying tool running from a single IPv6 VPS rotates through its /64. It tries thousands of passwords per account without ever tripping a limit.

**Fix:**
- IPv6 clients are keyed by their /64 prefix; IPv4 and IPv4-mapped addresses by the address.
- Checking a key no longer stores it, and the table is capped at 100,000 entries, evicting the oldest.
- A cross-network per-account limit of 100 failures per 15 minutes was added.

That last limit lets anyone who knows an email lock the account out for 15 minutes. It is set high for that reason, and MFA (SEC-17) is the lasting fix.

Tests: `R2-01`.

### R2-02 Medium: transmittal activity visible to non-parties in the audit trail

**Where:** `audit_select` policy

Transmittals themselves are visible only to their sender and recipients. Their audit entries were visible to admins and document controllers of every organisation on the project: issue and close events, transmittal numbers, review codes and which organisation responded.

**Scenario:** a subcontractor's document controller on the same project watches which drawings the contractor sent to the consultant, and whether each came back code C.

**Fix:** `0009_security_hardening_2.sql`. Transmittal events are visible only to parties of that transmittal, or within the actor's own organisation. This mirrors the transmittal's own visibility, so a project admin who isn't copied no longer sees them either.

Test: `R2-02`. With the migration removed, the test fails.

### R2-03 Medium: upload quota race

**Where:** `PUT /api/projects/:pid/uploads`

The 20 GB daily quota (SEC-08) was checked before streaming and recorded after it. Parallel uploads all read the same "used" figure, so N parallel requests could store N × 500 MB beyond the quota.

**Fix:**
- Bytes in flight are reserved per user until the upload is recorded, and the stream is capped at the reservation.
- At most 4 uploads per user can run at once.

Test: `R2-03`. With the reservation removed, the test fails.

### R2-04 Medium: process crash on idle database errors

**Where:** `app/src/db.js`

When an idle pooled connection is terminated, for example by a database restart, failover or network drop, `pg` emits an `error` event on the pool. With no listener, Node treats it as an unhandled error and exits. Every routine database maintenance window would take the application down.

**Fix:** the pool's `error` event is logged, and the pool replaces the connection. Test: `R2-04`.

### R2-05 Low: demo seed on a live database

`npm run seed` only refused when `NODE_ENV=production`. Pointed at a live database without that variable, it added five accounts sharing a password published in the README. It now refuses any database that already has projects. Verified: run against a database with one project, it exits with an error and creates no users.

### R2-06 Low: unbounded free text

Transmittal messages, review comments and inspection locations accepted anything up to the 1 MB body limit, and were shown on list pages. They are now capped at 20,000, 10,000 and 500 characters respectively. Test: `R2-06`.

### Open (R2)

- **R2-07 Low: audit listing cost.** Row-level security filters after the scan. A document controller who can see few entries makes each page scan much of the project's audit table. Set `ALTER ROLE cde_api SET statement_timeout = '15s'`, and partition `audit_trail` by month as it grows.
- **R2-08 Low: Google Fonts.** Every page view sends the user's IP address to Google, and pages depend on a third party's availability. For KSA data-residency commitments, self-host the two font families. Both are under the SIL Open Font License, which permits this.
- **R2-09 Low: session lifetime.** Add a 30–60 minute idle timeout, rotate the session token on privilege change, and add "sign out of all devices". Revoking all sessions is a single `UPDATE user_sessions SET revoked_at = now() WHERE user_id = …`.

## Production checklist

1. Run migrations as the owner role. Run the app as a login role that is only `IN ROLE cde_app`. The server enforces this when `NODE_ENV=production`.
2. Connect to Postgres with TLS (`sslmode=verify-full`). Keep `DATABASE_URL` in a secrets manager, not in environment files.
3. Terminate HTTPS at the edge, set `TRUST_PROXY` to the hop count, and put a WAF / rate limit in front of `/api/auth/login`.
4. Deal with SEC-14, SEC-15 and SEC-16 before holding real client data.
5. Alert on spikes of `401`, `403` and `429` responses, and on any `audit_verify_project` result that isn't intact.
6. Set `statement_timeout` on the app's login role (R2-07), and self-host fonts (R2-08).
7. Schedule the orphaned-upload cleanup and the audit-head export.
