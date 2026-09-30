-- 0010_system_audit_entries.sql
-- Failure hunt E6: bulk-loading revisions as the table owner (an import, a
-- data migration from another CDE) failed, because the audit trigger calls
-- audit_append(), which required a project member. audit_trail was designed
-- for system entries (actor_id NULL "only for system jobs"), but nothing
-- could write one.
--
-- audit_append now accepts a request with no user only from a system
-- session: one that has not switched to cde_app (the app always runs
-- "SET LOCAL ROLE cde_app"), and whose login role is a superuser or is not a
-- member of cde_app, so the app's own login role cannot write system entries
-- either. Inside this SECURITY DEFINER function current_user is the owner;
-- current_setting('role') still reports the caller's SET ROLE, and
-- session_user the login role (both verified on PostgreSQL 16).

CREATE OR REPLACE FUNCTION audit_append(
    p_project_id uuid, p_action text, p_resource_type text, p_resource_id uuid,
    p_details jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_seq    bigint;
    v_system boolean;
BEGIN
    IF app_current_user_id() IS NULL THEN
        SELECT current_setting('role') <> 'cde_app'
               AND (r.rolsuper OR NOT pg_has_role(session_user, 'cde_app', 'MEMBER'))
          INTO v_system
          FROM pg_roles r WHERE r.rolname = session_user;
        IF NOT coalesce(v_system, false) THEN
            RAISE EXCEPTION 'audit_append: no user in the request context'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    ELSIF app_member_org(p_project_id) IS NULL THEN
        RAISE EXCEPTION 'audit_append: current user is not a member of project %', p_project_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    INSERT INTO audit_trail (project_id, actor_id, actor_ip, action, resource_type, resource_id, details)
    VALUES (p_project_id, app_current_user_id(), app_client_ip(), p_action, p_resource_type,
            p_resource_id, p_details)
    RETURNING chain_seq INTO v_seq;
    RETURN v_seq;
END $$;
