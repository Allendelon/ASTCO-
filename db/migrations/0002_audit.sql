-- 0002_audit.sql
-- Append-only, hash-chained audit trail: one chain per project.
--
-- What this gives you: any edit, deletion or insertion in the middle of a
-- chain is detected by audit_verify_chain(). Chains are serialised per
-- project, so concurrent writers cannot fork a chain.
--
-- What it does not give you: protection against someone with superuser
-- access who rewrites a whole chain from some point onwards. Closing that gap
-- needs the chain heads (audit_chain_heads) exported regularly to storage the
-- database cannot write to, e.g. S3 Object Lock in compliance mode, or signed
-- with a KMS/HSM key. An HMAC key stored in the database would not help,
-- because the same superuser could read it.

CREATE TABLE audit_trail (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id      uuid NOT NULL REFERENCES projects(id),
    chain_seq       bigint NOT NULL,
    actor_id        uuid,             -- NULL only for system jobs
    actor_ip        inet,             -- NULL for system jobs
    action          varchar(64) NOT NULL,
    resource_type   varchar(32) NOT NULL,
    resource_id     uuid NOT NULL,
    details         jsonb NOT NULL DEFAULT '{}'::jsonb,
    event_timestamp timestamptz NOT NULL,
    previous_hash   bytea CHECK (octet_length(previous_hash) = 32),
    current_hash    bytea NOT NULL CHECK (octet_length(current_hash) = 32),
    UNIQUE (project_id, chain_seq),
    CHECK (chain_seq >= 1),
    CHECK ((chain_seq = 1) = (previous_hash IS NULL))
);
CREATE INDEX audit_trail_resource_idx ON audit_trail (resource_type, resource_id);

-- Serialise every hashed field into a JSON array so the encoding is
-- unambiguous: no delimiter tricks, and no dependence on DateStyle or
-- TimeZone (the timestamp is hashed as epoch microseconds).
CREATE FUNCTION audit_compute_hash(
    p_previous_hash bytea, p_project_id uuid, p_chain_seq bigint,
    p_actor_id uuid, p_actor_ip inet, p_action text, p_resource_type text,
    p_resource_id uuid, p_details jsonb, p_event_timestamp timestamptz
) RETURNS bytea
LANGUAGE sql STABLE AS $$
    SELECT sha256(
        coalesce(p_previous_hash, ''::bytea) ||
        convert_to(
            jsonb_build_array(
                p_project_id, p_chain_seq, p_actor_id, host(p_actor_ip), p_action,
                p_resource_type, p_resource_id, p_details,
                (extract(epoch FROM p_event_timestamp) * 1000000)::bigint
            )::text,
            'UTF8')
    )
$$;

CREATE FUNCTION audit_trail_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_last_seq  bigint;
    v_last_hash bytea;
BEGIN
    -- One writer per project chain at a time. Under READ COMMITTED the SELECT
    -- below sees the previous writer's committed row. Under REPEATABLE READ it
    -- might not; the UNIQUE (project_id, chain_seq) then rejects the insert
    -- instead of forking the chain.
    PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.project_id::text, 0));

    SELECT chain_seq, current_hash INTO v_last_seq, v_last_hash
      FROM audit_trail
     WHERE project_id = NEW.project_id
     ORDER BY chain_seq DESC
     LIMIT 1;

    NEW.chain_seq       := coalesce(v_last_seq, 0) + 1;
    NEW.previous_hash   := v_last_hash;
    NEW.event_timestamp := clock_timestamp();   -- server time, never client time
    NEW.current_hash    := audit_compute_hash(
        NEW.previous_hash, NEW.project_id, NEW.chain_seq, NEW.actor_id, NEW.actor_ip,
        NEW.action, NEW.resource_type, NEW.resource_id, NEW.details, NEW.event_timestamp);
    RETURN NEW;
END $$;

CREATE TRIGGER audit_trail_chain BEFORE INSERT ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION audit_trail_chain();

CREATE FUNCTION audit_trail_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_trail is append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_trail_no_update_delete BEFORE UPDATE OR DELETE ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION audit_trail_reject_change();
CREATE TRIGGER audit_trail_no_truncate BEFORE TRUNCATE ON audit_trail
    FOR EACH STATEMENT EXECUTE FUNCTION audit_trail_reject_change();

-- The only write path for the application role (see 0006). The actor and IP
-- come from the request context, not from arguments, so callers cannot
-- attribute events to someone else.
CREATE FUNCTION audit_append(
    p_project_id uuid, p_action text, p_resource_type text, p_resource_id uuid,
    p_details jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_seq bigint;
BEGIN
    IF app_member_org(p_project_id) IS NULL THEN
        RAISE EXCEPTION 'audit_append: current user is not a member of project %', p_project_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    INSERT INTO audit_trail (project_id, actor_id, actor_ip, action, resource_type, resource_id, details)
    VALUES (p_project_id, app_current_user_id(), app_client_ip(), p_action, p_resource_type,
            p_resource_id, p_details)
    RETURNING chain_seq INTO v_seq;
    RETURN v_seq;
END $$;

-- Returns the chain_seq of the first broken link, or NULL if the chain is
-- intact. Detects edited rows, deleted rows (gaps) and re-linked rows.
CREATE FUNCTION audit_verify_chain(p_project_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r             audit_trail%ROWTYPE;
    v_expect_seq  bigint := 1;
    v_expect_prev bytea  := NULL;
BEGIN
    FOR r IN SELECT * FROM audit_trail WHERE project_id = p_project_id ORDER BY chain_seq LOOP
        IF r.chain_seq <> v_expect_seq
           OR r.previous_hash IS DISTINCT FROM v_expect_prev
           OR r.current_hash <> audit_compute_hash(
                  r.previous_hash, r.project_id, r.chain_seq, r.actor_id, r.actor_ip,
                  r.action, r.resource_type, r.resource_id, r.details, r.event_timestamp)
        THEN
            RETURN v_expect_seq;
        END IF;
        v_expect_seq  := v_expect_seq + 1;
        v_expect_prev := r.current_hash;
    END LOOP;
    RETURN NULL;
END $$;

-- Latest link per project: export these to WORM storage on a schedule.
CREATE VIEW audit_chain_heads AS
SELECT DISTINCT ON (project_id) project_id, chain_seq, current_hash, event_timestamp
  FROM audit_trail
 ORDER BY project_id, chain_seq DESC;
