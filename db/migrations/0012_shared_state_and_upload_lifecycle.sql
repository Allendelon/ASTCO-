-- 0012_shared_state_and_upload_lifecycle.sql
-- Moves the last per-process state into Postgres, so the app can run as
-- several instances behind a load balancer (ADR-003 in docs/ARCHITECTURE.md):
--   1. Rate-limit counters (sign-in failures, audit verification), which
--      were held in each process's memory. With N instances an attacker got
--      N times the budget.
--   2. Upload quota reservations, which were also held in memory. The quota
--      race fixed in R2-03 came back with more than one instance.
--
-- It also gives uploads a lifecycle (receiving -> ready | rejected). That is
-- what direct-to-storage multipart uploads of large BIM models will use
-- (ADR-005): a row is reserved first, the bytes arrive, and the row is
-- completed or rejected afterwards.
--
-- Errors raised here use custom SQLSTATEs (class "CD") so the API can map
-- them to stable error codes without parsing message text.

-- ---------------------------------------------------------------- uploads
ALTER TABLE cde_uploads
    ADD COLUMN status text NOT NULL DEFAULT 'ready' CHECK (status IN ('receiving', 'ready', 'rejected')),
    ADD COLUMN reserved_bytes bigint CHECK (reserved_bytes > 0),
    ALTER COLUMN object_key DROP NOT NULL,
    ALTER COLUMN size_bytes DROP NOT NULL,
    ALTER COLUMN detected_mime DROP NOT NULL,
    ADD CONSTRAINT cde_uploads_ready_is_complete
        CHECK (status <> 'ready' OR (object_key IS NOT NULL AND size_bytes IS NOT NULL AND detected_mime IS NOT NULL));
CREATE INDEX cde_uploads_quota_idx ON cde_uploads (uploaded_by, created_at) WHERE status <> 'rejected';

-- Reserves quota for an upload about to arrive and returns its id. Quota
-- and parallel-upload checks run under a per-user lock, so they hold across
-- every app instance. Rows still 'receiving' after p_stale (an instance died
-- mid-upload) stop counting.
CREATE FUNCTION upload_begin(p_project_id uuid, p_reserve_bytes bigint, p_daily_quota bigint,
                             p_max_parallel integer, p_stale interval)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user     uuid := app_current_user_id();
    v_used     bigint;
    v_inflight integer;
    v_id       uuid;
BEGIN
    IF app_member_role(p_project_id) NOT IN ('ADMIN', 'DOC_CONTROLLER', 'MEMBER') OR app_member_role(p_project_id) IS NULL THEN
        RAISE EXCEPTION 'you cannot upload files to this project' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('quota:' || v_user::text, 0));

    SELECT coalesce(sum(coalesce(size_bytes, reserved_bytes)), 0),
           count(*) FILTER (WHERE status = 'receiving')
      INTO v_used, v_inflight
      FROM cde_uploads
     WHERE uploaded_by = v_user
       AND created_at > now() - interval '24 hours'
       AND (status = 'ready' OR (status = 'receiving' AND created_at > now() - p_stale));

    IF v_inflight >= p_max_parallel THEN
        RAISE EXCEPTION 'too many uploads in progress' USING ERRCODE = 'CDQ02';
    END IF;
    IF v_used + p_reserve_bytes > p_daily_quota THEN
        RAISE EXCEPTION 'daily upload limit reached' USING ERRCODE = 'CDQ01';
    END IF;

    INSERT INTO cde_uploads (project_id, uploaded_by, status, reserved_bytes)
    VALUES (p_project_id, v_user, 'receiving', p_reserve_bytes)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- Completes an upload with what the server measured while receiving it.
CREATE FUNCTION upload_complete(p_upload_id uuid, p_object_key text, p_size_bytes bigint, p_detected_mime text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    WITH done AS (
        UPDATE cde_uploads
           SET status = 'ready', object_key = p_object_key, size_bytes = p_size_bytes, detected_mime = p_detected_mime
         WHERE id = p_upload_id AND uploaded_by = app_current_user_id() AND status = 'receiving'
           AND p_size_bytes <= reserved_bytes
        RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM done)
$$;

CREATE FUNCTION upload_abort(p_upload_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE cde_uploads SET status = 'rejected'
     WHERE id = p_upload_id AND uploaded_by = app_current_user_id() AND status = 'receiving'
$$;

-- The app no longer inserts upload rows directly; it goes through the
-- functions above, which enforce quota and ownership.
REVOKE INSERT ON cde_uploads FROM cde_app;

-- A revision can only claim a finished upload.
CREATE OR REPLACE FUNCTION cde_revisions_claim_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_upload cde_uploads%ROWTYPE;
BEGIN
    -- Inserts by the table owner (migrations, bulk imports) run without a
    -- request user. The application role always has one: its RLS policies
    -- require it.
    IF app_current_user_id() IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE cde_uploads u
       SET claimed_at = now(), revision_id = NEW.id
     WHERE u.id = (SELECT x.id FROM cde_uploads x
                    WHERE x.object_key = NEW.object_key
                      AND x.uploaded_by = app_current_user_id()
                      AND x.project_id = NEW.project_id
                      AND x.status = 'ready'
                      AND x.claimed_at IS NULL
                      AND x.created_at > now() - interval '24 hours'
                    ORDER BY x.created_at
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED)
    RETURNING u.* INTO v_upload;

    IF v_upload.id IS NULL THEN
        RAISE EXCEPTION 'upload the file again before creating this revision (an upload can be used once, by the person who uploaded it, within 24 hours)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    NEW.size_bytes := v_upload.size_bytes;
    -- Types a browser may render inline must match the file's real content.
    IF v_upload.detected_mime <> 'application/octet-stream' THEN
        NEW.mime_type := v_upload.detected_mime;
    ELSIF NEW.mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif') THEN
        NEW.mime_type := 'application/octet-stream';
    END IF;
    RETURN NEW;
END $$;

-- ----------------------------------------------------------- rate limits
-- Fixed-window counters shared by all instances. UNLOGGED: fast, and losing
-- the counters in a database crash only resets the windows. Keys are SHA-256
-- hex of the limiter key, so no emails or addresses are stored.
CREATE UNLOGGED TABLE rate_limit_counters (
    key      text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
    count    integer NOT NULL,
    reset_at timestamptz NOT NULL
);

-- Seconds until every key is under its limit (0 = not blocked).
CREATE FUNCTION rate_limit_blocked(p_keys text[], p_maxes integer[]) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT coalesce(max(ceil(extract(epoch FROM c.reset_at - now())))::integer, 0)
      FROM unnest(p_keys, p_maxes) AS k(key, max_count)
      JOIN rate_limit_counters c ON c.key = k.key
     WHERE c.reset_at > now() AND c.count >= k.max_count
$$;

CREATE FUNCTION rate_limit_hit(p_keys text[], p_window interval) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO rate_limit_counters AS c (key, count, reset_at)
    SELECT k, 1, now() + p_window FROM unnest(p_keys) AS k
    ON CONFLICT (key) DO UPDATE
       SET count    = CASE WHEN c.reset_at <= now() THEN 1 ELSE c.count + 1 END,
           reset_at = CASE WHEN c.reset_at <= now() THEN now() + p_window ELSE c.reset_at END;
    -- Keep the table small: now and then, drop windows that ended.
    IF random() < 0.02 THEN
        DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 hour';
    END IF;
END $$;

CREATE FUNCTION rate_limit_reset(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    DELETE FROM rate_limit_counters WHERE key = p_key
$$;

REVOKE ALL ON FUNCTION upload_begin(uuid, bigint, bigint, integer, interval), upload_complete(uuid, text, bigint, text),
                       upload_abort(uuid), rate_limit_blocked(text[], integer[]), rate_limit_hit(text[], interval),
                       rate_limit_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upload_begin(uuid, bigint, bigint, integer, interval), upload_complete(uuid, text, bigint, text),
                          upload_abort(uuid), rate_limit_blocked(text[], integer[]), rate_limit_hit(text[], interval),
                          rate_limit_reset(text) TO cde_app;
