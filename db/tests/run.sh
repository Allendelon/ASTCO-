#!/usr/bin/env bash
# Applies db/migrations to a scratch database and runs the tests.
#
# Uses the standard libpq variables (PGHOST, PGPORT, PGUSER). PGUSER must be
# able to create databases and roles. Example:
#   PGHOST=/var/run/postgresql PGUSER=postgres db/tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
db="${TEST_DB:-cde_test}"
psql_q=(psql -X -q -v ON_ERROR_STOP=1)

"${psql_q[@]}" -d postgres -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"

for f in "$here"/../migrations/*.sql; do
    echo "migrate $(basename "$f")"
    "${psql_q[@]}" -d "$db" --single-transaction -f "$f"
done

echo "run test_schema.sql"
"${psql_q[@]}" -d "$db" -f "$here/test_schema.sql"

# Concurrency: parallel writers on one project must produce one unbroken chain.
echo "run audit chain concurrency test"
writers=8
per_writer=100
# Each writer commits after every append, so the chain lock is contended.
for _ in $(seq "$writers"); do
    # Separate -c commands so the DO block runs outside an implicit transaction
    # and can COMMIT.
    "${psql_q[@]}" -d "$db" -c "SET ROLE cde_app" \
        -c "SELECT set_config('app.user_id', 'b0000000-0000-0000-0000-000000000004', false)" \
        -c "DO \$\$ BEGIN
            FOR i IN 1..$per_writer LOOP
                PERFORM audit_append('c0000000-0000-0000-0000-000000000002', 'DOCUMENT_DOWNLOADED',
                                     'REVISION', gen_random_uuid());
                COMMIT;
            END LOOP;
        END \$\$;" >/dev/null &
done
wait
"${psql_q[@]}" -d "$db" -At -c "
    SELECT CASE
        WHEN count(*) = $writers * $per_writer
         AND max(chain_seq) = count(*)
         AND audit_verify_chain('c0000000-0000-0000-0000-000000000002') IS NULL
        THEN 'concurrency ok: ' || count(*) || ' links, no gaps, chain verifies'
        ELSE 'CONCURRENCY FAILURE: ' || count(*) || ' rows, max seq ' || max(chain_seq)
    END
    FROM audit_trail WHERE project_id = 'c0000000-0000-0000-0000-000000000002'" | tee /dev/stderr \
    | grep -q '^concurrency ok'

echo "all tests passed"
