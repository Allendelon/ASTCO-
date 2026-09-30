-- 0007_app_support.sql
-- Tables and functions the web application needs: password credentials,
-- server-side sessions, per-project running numbers and a guarded audit check.
-- cde_app gets no direct access to the tables, only to the functions.

CREATE TABLE user_credentials (
    user_id       uuid PRIMARY KEY REFERENCES users(id),
    password_hash text NOT NULL,          -- scrypt$N$r$p$salt$hash (base64url)
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Only the SHA-256 of the session token is stored, so a copy of this table
-- cannot be replayed as cookies.
CREATE TABLE user_sessions (
    token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
    user_id      uuid NOT NULL REFERENCES users(id),
    client_ip    inet,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE FUNCTION auth_lookup_credentials(p_email text)
RETURNS TABLE (user_id uuid, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT u.id, c.password_hash
      FROM users u
      JOIN user_credentials c ON c.user_id = u.id
     WHERE lower(u.email) = lower(p_email)
       AND u.is_active
$$;

CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_sha256 bytea, p_ttl interval, p_client_ip inet)
RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO user_sessions (token_sha256, user_id, client_ip, expires_at)
    VALUES (p_token_sha256, p_user_id, p_client_ip, now() + p_ttl)
    RETURNING expires_at
$$;

CREATE FUNCTION auth_resolve_session(p_token_sha256 bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT s.user_id
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_sha256 = p_token_sha256
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active
$$;

CREATE FUNCTION auth_revoke_session(p_token_sha256 bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE user_sessions SET revoked_at = now()
     WHERE token_sha256 = p_token_sha256 AND revoked_at IS NULL
$$;

-- Running numbers per project and kind (transmittals, inspections by type).
CREATE TABLE project_counters (
    project_id uuid NOT NULL REFERENCES projects(id),
    kind       text NOT NULL,
    last_value integer NOT NULL,
    PRIMARY KEY (project_id, kind)
);

CREATE FUNCTION next_project_number(p_project_id uuid, p_kind text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_value integer;
BEGIN
    IF app_member_org(p_project_id) IS NULL THEN
        RAISE EXCEPTION 'not a member of project %', p_project_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO project_counters AS c (project_id, kind, last_value)
    VALUES (p_project_id, p_kind, 1)
    ON CONFLICT (project_id, kind) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_value;
    RETURN v_value;
END $$;

-- audit_verify_chain() reads every row, so only admins and document
-- controllers of the project may run it.
CREATE FUNCTION audit_verify_project(p_project_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF app_member_role(p_project_id) NOT IN ('ADMIN', 'DOC_CONTROLLER') OR app_member_role(p_project_id) IS NULL THEN
        RAISE EXCEPTION 'only project admins and document controllers can verify the audit trail'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN audit_verify_chain(p_project_id);
END $$;

REVOKE ALL ON FUNCTION auth_lookup_credentials(text), auth_create_session(uuid, bytea, interval, inet),
                       auth_resolve_session(bytea), auth_revoke_session(bytea),
                       next_project_number(uuid, text), audit_verify_project(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_credentials(text), auth_create_session(uuid, bytea, interval, inet),
                          auth_resolve_session(bytea), auth_revoke_session(bytea),
                          next_project_number(uuid, text), audit_verify_project(uuid) TO cde_app;
