-- 0008_security_hardening.sql
-- Fixes from the security review (docs/SECURITY-AUDIT.md). Each section names
-- the finding it closes.

-- ---------------------------------------------------------------------------
-- SEC-01: bind stored files to the person and project that uploaded them.
--
-- Files are content-addressed, and a revision used to accept any object key.
-- Knowing a file's SHA-256 was therefore enough to attach that file to your
-- own document and download it. Hashes are visible in the audit trail and on
-- document pages, so this bypassed WIP confidentiality. Now a revision can
-- only use an upload that the current user made, in the same project, within
-- 24 hours, and each upload can be used once.

CREATE TABLE cde_uploads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id),
    uploaded_by   uuid NOT NULL DEFAULT app_current_user_id() REFERENCES users(id),
    object_key    text NOT NULL CHECK (object_key ~ '^[0-9a-f]{64}$'),
    size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
    detected_mime text NOT NULL,             -- from the file's leading bytes, not the client
    created_at    timestamptz NOT NULL DEFAULT now(),
    claimed_at    timestamptz,
    revision_id   uuid
);
CREATE INDEX cde_uploads_user_idx ON cde_uploads (uploaded_by, created_at);
CREATE INDEX cde_uploads_unclaimed_idx ON cde_uploads (object_key, uploaded_by, project_id) WHERE claimed_at IS NULL;

ALTER TABLE cde_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY upload_select ON cde_uploads FOR SELECT TO cde_app
    USING (uploaded_by = app_current_user_id());
CREATE POLICY upload_insert ON cde_uploads FOR INSERT TO cde_app
    WITH CHECK (uploaded_by = app_current_user_id()
                AND app_member_role(project_id) IN ('ADMIN', 'DOC_CONTROLLER', 'MEMBER'));
GRANT SELECT, INSERT ON cde_uploads TO cde_app;

-- Object key and hash must agree. NOT VALID: enforced for new rows without
-- failing on rows written before this migration.
ALTER TABLE cde_document_revisions
    ADD CONSTRAINT cde_document_revisions_object_key_sha256_check
    CHECK (object_key = encode(sha256, 'hex')) NOT VALID;

CREATE FUNCTION cde_revisions_claim_upload() RETURNS trigger
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

CREATE TRIGGER cde_revisions_claim_upload BEFORE INSERT ON cde_document_revisions
    FOR EACH ROW EXECUTE FUNCTION cde_revisions_claim_upload();

-- ---------------------------------------------------------------------------
-- SEC-02: inspection results. The requester could record their own inspection
-- as passed, and a result could be flipped afterwards. Now only the assignee
-- records the result, once. Everything else about an inspection is fixed at
-- creation, and pins must point at revisions everyone on the project can see.

DROP POLICY inspection_update ON site_inspections;
CREATE POLICY inspection_update ON site_inspections FOR UPDATE TO cde_app
    USING (assigned_to = app_current_user_id() AND app_member_role(project_id) <> 'VIEWER');

CREATE FUNCTION site_inspections_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'REQUESTED' THEN
            RAISE EXCEPTION 'a new inspection starts as REQUESTED'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM cde_document_revisions r
                    WHERE r.id IN (NEW.sheet_revision_id, NEW.model_revision_id) AND r.cde_state = 'WIP') THEN
            RAISE EXCEPTION 'inspections can only be pinned to shared or published revisions'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF (NEW.project_id, NEW.inspection_type, NEW.inspection_number, NEW.location_description,
        NEW.ifc_global_id, NEW.model_revision_id, NEW.sheet_revision_id, NEW.sheet_page,
        NEW.sheet_x_norm, NEW.sheet_y_norm, NEW.created_by, NEW.assigned_to, NEW.created_at)
       IS DISTINCT FROM
       (OLD.project_id, OLD.inspection_type, OLD.inspection_number, OLD.location_description,
        OLD.ifc_global_id, OLD.model_revision_id, OLD.sheet_revision_id, OLD.sheet_page,
        OLD.sheet_x_norm, OLD.sheet_y_norm, OLD.created_by, OLD.assigned_to, OLD.created_at)
    THEN
        RAISE EXCEPTION 'only the result of an inspection can be recorded; raise a new inspection instead'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'REQUESTED' THEN
        RAISE EXCEPTION 'inspection % already has a result (%) and cannot be changed', OLD.inspection_number, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER site_inspections_guard BEFORE INSERT OR UPDATE ON site_inspections
    FOR EACH ROW EXECUTE FUNCTION site_inspections_guard();

-- ---------------------------------------------------------------------------
-- SEC-03: audit trail visibility across organisations. An admin or document
-- controller of any organisation could read every entry, including uploads to
-- other organisations' WIP (revision labels, hashes, ids) and everyone's
-- downloads. Now:
--   - revision events are visible only if the revision is visible to you
--     (RLS on revisions applies) or the actor is in your organisation;
--   - download events are visible to project admins, or within your own organisation.

CREATE FUNCTION app_is_same_org_actor(p_project_id uuid, p_actor_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM project_members m
                    WHERE m.project_id = p_project_id AND m.user_id = p_actor_id
                      AND m.organization_id = app_member_org(p_project_id))
$$;

DROP POLICY audit_select ON audit_trail;
CREATE POLICY audit_select ON audit_trail FOR SELECT TO cde_app
    USING (
        app_member_role(project_id) IN ('ADMIN', 'DOC_CONTROLLER')
        AND (
            app_is_same_org_actor(project_id, actor_id)
            OR (action = 'DOCUMENT_DOWNLOADED' AND app_member_role(project_id) = 'ADMIN'
                AND EXISTS (SELECT 1 FROM cde_document_revisions r WHERE r.id = audit_trail.resource_id))
            OR (action <> 'DOCUMENT_DOWNLOADED'
                AND (resource_type <> 'REVISION'
                     OR EXISTS (SELECT 1 FROM cde_document_revisions r WHERE r.id = audit_trail.resource_id)))
        )
    );

-- ---------------------------------------------------------------------------
-- SEC-11: viewers of the sending organisation could delete its drafts.

DROP POLICY transmittal_delete ON cde_transmittals;
CREATE POLICY transmittal_delete ON cde_transmittals FOR DELETE TO cde_app
    USING (sender_org_id = app_member_org(project_id) AND app_member_role(project_id) <> 'VIEWER');

-- ---------------------------------------------------------------------------
-- SEC-12: sessions were never purged, and password hashes could not be
-- upgraded when the scrypt cost is raised.

CREATE OR REPLACE FUNCTION auth_create_session(p_user_id uuid, p_token_sha256 bytea, p_ttl interval, p_client_ip inet)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_expires timestamptz;
BEGIN
    DELETE FROM user_sessions
     WHERE user_id = p_user_id AND (expires_at < now() OR revoked_at < now() - interval '30 days');
    INSERT INTO user_sessions (token_sha256, user_id, client_ip, expires_at)
    VALUES (p_token_sha256, p_user_id, p_client_ip, now() + p_ttl)
    RETURNING expires_at INTO v_expires;
    RETURN v_expires;
END $$;

-- Compare-and-swap, so a stale login cannot overwrite a newer password.
CREATE FUNCTION auth_upgrade_password_hash(p_user_id uuid, p_old_hash text, p_new_hash text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    WITH u AS (
        UPDATE user_credentials SET password_hash = p_new_hash, updated_at = now()
         WHERE user_id = p_user_id AND password_hash = p_old_hash
        RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM u)
$$;
REVOKE ALL ON FUNCTION auth_upgrade_password_hash(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_upgrade_password_hash(uuid, text, text) TO cde_app;
