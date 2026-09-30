-- 0011_session_idle_timeout.sql
-- R2-09: sessions had only a 12-hour absolute lifetime. A session left open
-- on a shared site-office PC, or a stolen cookie, stayed valid all day, and
-- nobody could end their sessions on other devices.
--
-- Sessions now also expire after a period without use (the app passes the
-- idle limit), and a user can revoke all of their sessions at once.

ALTER TABLE user_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- Resolves a session and records that it was used. last_seen_at is written
-- at most once a minute, so busy sessions do not write on every request.
-- The one-argument version from 0007 stays for compatibility; the app uses this one.
CREATE FUNCTION auth_resolve_session(p_token_sha256 bytea, p_idle interval) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid;
    v_seen timestamptz;
BEGIN
    SELECT s.user_id, s.last_seen_at INTO v_user, v_seen
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_sha256 = p_token_sha256
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.last_seen_at > now() - p_idle
       AND u.is_active;
    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_seen < now() - interval '1 minute' THEN
        UPDATE user_sessions SET last_seen_at = now() WHERE token_sha256 = p_token_sha256;
    END IF;
    RETURN v_user;
END $$;

-- Revokes every session of the user who owns this (valid) session. Taking
-- the token rather than a user id means the caller must hold a live session
-- of that user.
CREATE FUNCTION auth_revoke_all_sessions(p_token_sha256 bytea) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    WITH owner AS (
        SELECT user_id FROM user_sessions
         WHERE token_sha256 = p_token_sha256 AND revoked_at IS NULL AND expires_at > now()),
    revoked AS (
        UPDATE user_sessions s SET revoked_at = now()
          FROM owner WHERE s.user_id = owner.user_id AND s.revoked_at IS NULL
        RETURNING 1)
    SELECT count(*)::int FROM revoked
$$;

REVOKE ALL ON FUNCTION auth_resolve_session(bytea, interval), auth_revoke_all_sessions(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea, interval), auth_revoke_all_sessions(bytea) TO cde_app;
