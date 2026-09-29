# CDE database schema

PostgreSQL 15+ schema for an ISO 19650 common data environment: a document register, revisions, transmittals, site inspections and a hash-chained audit trail. Tested on PostgreSQL 16.

```
db/
  migrations/
    0001_core.sql          organisations, users, projects, membership, code lists
    0002_audit.sql         append-only hash-chained audit trail
    0003_cde.sql           documents, revisions, suitability codes
    0004_transmittals.sql  transmittals, recipients, items, review responses
    0005_field.sql         site inspections pinned to sheets / IFC elements
    0006_security.sql      cde_app role, grants, row-level security
  tests/
    run.sh                 builds a scratch DB, applies migrations, runs tests
    test_schema.sql        behaviour tests (runs as cde_app under RLS)
```

Run the tests:

```sh
PGHOST=/var/run/postgresql PGUSER=postgres db/tests/run.sh
```

## Changes from the first draft

Each item below was either reproduced against the first-draft schema or is covered by a test in `test_schema.sql`.

| Area | First draft | Now |
|---|---|---|
| Tenancy | `project_id` had no foreign key and there was no isolation, so any query could read any project. | Projects, organisations and memberships are real tables. RLS runs on every table. WIP is visible only to the originating organisation, and transmittals only to their sender and recipients. |
| Revision immutability | `is_locked` was an ordinary column. `UPDATE ... SET file_s3_key='evil', is_locked=false` succeeded. | Triggers freeze file content and identity. The CDE state can only move forward, and only WIP revisions can be deleted. |
| Revision integrity | `document_id` could be NULL, a 1-byte `sha256` was accepted, and negative sizes were accepted. | NOT NULL, `octet_length(sha256) = 32`, and `size_bytes > 0`. |
| Revision order | Free-text labels, so P01.02 could be added after C01. | Prefix, major and minor are stored separately. The label is generated and must increase. Minor versions exist only in WIP. |
| Suitability | A fixed enum (`A1, A2, B1` only), with no link between code, CDE state and revision prefix. | Codes are a table per project. A composite FK ties each code to its state and prefix, so A1 on a P revision is rejected. |
| Naming fields | Free-text columns. `project_code` was repeated alongside `project_id`. | Each field is checked by an FK against the project's code lists. The originator code comes from the organisation's project registration, and the full number is a generated column. |
| Transmittal immutability | `ON DELETE CASCADE` let you delete an issued transmittal together with its items. | Issued transmittals cannot be deleted or edited. Items and recipients are locked at issue. The status only moves forward. |
| Transmittal numbers | Unique across all projects, so two customers could not both use `TR-...-00001`. | Unique per project. |
| Recipients | A single `recipient_org_id`. | Several TO and CC recipients, each checked against project membership. Only TO recipients can stamp. |
| Review codes | Stored on the item row and overwritten in place. | Separate append-only responses, one per item per organisation. Codes C and D require comments. |
| WIP leakage | Any revision could be transmitted. | WIP revisions cannot be transmitted. |
| Site inspections | `bim_guid UUID` rejects real IFC GlobalIds, which are 22 characters. Coordinates were unbounded and half-pins were allowed. Status was free text. | `char(22)` with a format check, paired with the model revision it belongs to. Coordinates are limited to 0..1, a pin must be complete, and the status is checked. |
| Audit chain | The hash was computed somewhere outside the DB. Concurrent writers could fork the chain. `actor_ip NOT NULL` broke system jobs. There was no payload, so rows could not be re-verified. | A per-project chain inside the DB, serialised by an advisory lock with `UNIQUE (project_id, chain_seq)` as a backstop. Events use canonical JSON and server time. Rows are append-only for everyone, including the owner, unless a superuser disables the triggers, and `audit_verify_chain()` catches that. |

## Audit chain limits

The chain is tamper-evident, not tamper-proof. A superuser can disable the triggers and rewrite the chain from any point onwards, recomputing every hash. What stops that is the regular export of `audit_chain_heads` to storage the database cannot modify, such as S3 Object Lock in compliance mode or a KMS signature. That export job is not in this repo yet.

An HMAC key stored in the database adds nothing here. The same superuser can read the key.

## Request context

The API must run each request in a transaction as a role that is a member of `cde_app`, and set:

```sql
SELECT set_config('app.user_id',   $1, true);  -- authenticated user
SELECT set_config('app.client_ip', $2, true);  -- client IP from the edge proxy
```

The `true` flag makes these settings transaction-local. With a pooler like PgBouncer in transaction mode, session-level settings would leak to the next client.

## Not built yet (gap to Aconex-class)

- Mail and correspondence (RFIs, site instructions, NCRs), which Aconex runs as a separate register.
- A configurable review workflow engine with multi-step parallel and serial reviewers. Transmittals here are single-step.
- Renditions and markups: PDF/viewer renditions of each revision, plus markup layers.
- Full-text search, e.g. OpenSearch fed from the revision register.
- Audit partitioning by month. Download events will dominate row counts.
- Checkpointing chain heads to WORM storage (see above).
- Data residency. For NCA ECC/CCC in KSA this means hosting in-region and holding customer-managed keys.
