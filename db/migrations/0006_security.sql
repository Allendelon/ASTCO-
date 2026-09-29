-- 0006_security.sql
-- Application role and row-level security.
--
-- The API connects as a login role that is a member of cde_app, and must set
-- app.user_id (and app.client_ip) in every transaction. Migrations run as the
-- table owner, which bypasses RLS. cde_app must never own tables.

DO $$
BEGIN
    CREATE ROLE cde_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

GRANT USAGE ON SCHEMA public TO cde_app;

-- Reference data is read-only for the app. Project setup is an admin path.
GRANT SELECT ON organizations, users, projects, project_organizations, project_members,
                project_code_values, project_suitability_codes TO cde_app;

GRANT SELECT, INSERT, UPDATE ON cde_documents TO cde_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cde_document_revisions TO cde_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cde_transmittals, cde_transmittal_recipients,
                                       cde_transmittal_items TO cde_app;
GRANT SELECT, INSERT ON cde_transmittal_responses TO cde_app;
GRANT SELECT, INSERT, UPDATE ON site_inspections TO cde_app;
GRANT SELECT ON cde_document_latest, cde_transmittals_overdue TO cde_app;

-- The audit trail can only be written through audit_append().
GRANT SELECT ON audit_trail TO cde_app;
REVOKE ALL ON FUNCTION audit_append(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(uuid, text, text, uuid, jsonb) TO cde_app;
REVOKE ALL ON FUNCTION audit_verify_chain(uuid) FROM PUBLIC;

ALTER TABLE organizations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members            ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_code_values        ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_suitability_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_document_revisions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_transmittals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_transmittal_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_transmittal_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cde_transmittal_responses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_inspections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trail                ENABLE ROW LEVEL SECURITY;

-- Does the current user share at least one project with this organisation or user?
CREATE FUNCTION app_shares_project_with_org(p_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
          FROM project_organizations po
          JOIN project_members me ON me.project_id = po.project_id
         WHERE po.organization_id = p_org_id
           AND me.user_id = app_current_user_id()
           AND me.is_active)
$$;

CREATE FUNCTION app_shares_project_with_user(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
          FROM project_members them
          JOIN project_members me ON me.project_id = them.project_id
         WHERE them.user_id = p_user_id
           AND me.user_id = app_current_user_id()
           AND me.is_active)
$$;

-- Directory: you see organisations and people you work with, nobody else.
CREATE POLICY org_visible ON organizations FOR SELECT TO cde_app
    USING (app_shares_project_with_org(id));
CREATE POLICY user_visible ON users FOR SELECT TO cde_app
    USING (id = app_current_user_id() OR app_shares_project_with_user(id));

CREATE POLICY project_visible ON projects FOR SELECT TO cde_app
    USING (app_member_org(id) IS NOT NULL);
CREATE POLICY project_org_visible ON project_organizations FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL);
CREATE POLICY project_member_visible ON project_members FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL);
CREATE POLICY code_value_visible ON project_code_values FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL);
CREATE POLICY suitability_visible ON project_suitability_codes FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL);

-- Documents: the originating organisation always sees its own. Everyone else
-- on the project sees a document once it has at least one non-WIP revision.
CREATE POLICY document_select ON cde_documents FOR SELECT TO cde_app
    USING (originator_org_id = app_member_org(project_id)
           OR (app_member_org(project_id) IS NOT NULL
               AND EXISTS (SELECT 1 FROM cde_document_revisions r
                            WHERE r.document_id = cde_documents.id AND r.cde_state <> 'WIP')));
CREATE POLICY document_write ON cde_documents FOR INSERT TO cde_app
    WITH CHECK (originator_org_id = app_member_org(project_id)
                AND app_member_role(project_id) <> 'VIEWER');
CREATE POLICY document_update ON cde_documents FOR UPDATE TO cde_app
    USING (originator_org_id = app_member_org(project_id) AND app_member_role(project_id) <> 'VIEWER');

-- Revisions: WIP is visible only inside the originating organisation.
CREATE POLICY revision_select ON cde_document_revisions FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL
           AND (cde_state <> 'WIP' OR originator_org_id = app_member_org(project_id)));
CREATE POLICY revision_insert ON cde_document_revisions FOR INSERT TO cde_app
    WITH CHECK (originator_org_id = app_member_org(project_id)
                AND app_member_role(project_id) <> 'VIEWER');
CREATE POLICY revision_update ON cde_document_revisions FOR UPDATE TO cde_app
    USING (originator_org_id = app_member_org(project_id)
           AND app_member_role(project_id) IN ('ADMIN', 'DOC_CONTROLLER'));
CREATE POLICY revision_delete ON cde_document_revisions FOR DELETE TO cde_app
    USING (originator_org_id = app_member_org(project_id) AND app_member_role(project_id) <> 'VIEWER');

-- Transmittals: visible to the sender and recipient organisations only.
-- The sender check is inline so INSERT ... RETURNING can see the new row,
-- which the STABLE helper's snapshot does not yet include.
CREATE POLICY transmittal_select ON cde_transmittals FOR SELECT TO cde_app
    USING (sender_org_id = app_member_org(project_id) OR app_transmittal_party(id));
CREATE POLICY transmittal_insert ON cde_transmittals FOR INSERT TO cde_app
    WITH CHECK (sender_org_id = app_member_org(project_id) AND app_member_role(project_id) <> 'VIEWER');
CREATE POLICY transmittal_update ON cde_transmittals FOR UPDATE TO cde_app
    USING (sender_org_id = app_member_org(project_id) AND app_member_role(project_id) <> 'VIEWER');
CREATE POLICY transmittal_delete ON cde_transmittals FOR DELETE TO cde_app
    USING (sender_org_id = app_member_org(project_id));

-- Only the sender edits a draft's recipients and items. The triggers in 0004
-- lock them once the transmittal is issued.
CREATE FUNCTION app_is_transmittal_sender(p_transmittal_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM cde_transmittals t
                    WHERE t.id = p_transmittal_id
                      AND t.sender_org_id = app_member_org(t.project_id))
$$;

CREATE POLICY recipient_select ON cde_transmittal_recipients FOR SELECT TO cde_app
    USING (app_transmittal_party(transmittal_id));
CREATE POLICY recipient_write ON cde_transmittal_recipients FOR ALL TO cde_app
    USING (app_is_transmittal_sender(transmittal_id))
    WITH CHECK (app_is_transmittal_sender(transmittal_id));

CREATE POLICY item_select ON cde_transmittal_items FOR SELECT TO cde_app
    USING (app_transmittal_party(transmittal_id));
CREATE POLICY item_write ON cde_transmittal_items FOR ALL TO cde_app
    USING (app_is_transmittal_sender(transmittal_id))
    WITH CHECK (app_is_transmittal_sender(transmittal_id));

CREATE POLICY response_select ON cde_transmittal_responses FOR SELECT TO cde_app
    USING (app_transmittal_party(transmittal_id));
CREATE POLICY response_insert ON cde_transmittal_responses FOR INSERT TO cde_app
    WITH CHECK (responder_org_id = app_member_org(project_id)
                AND responded_by = app_current_user_id()
                AND app_member_role(project_id) <> 'VIEWER');

CREATE POLICY inspection_select ON site_inspections FOR SELECT TO cde_app
    USING (app_member_org(project_id) IS NOT NULL);
CREATE POLICY inspection_insert ON site_inspections FOR INSERT TO cde_app
    WITH CHECK (app_member_org(project_id) IS NOT NULL
                AND created_by = app_current_user_id()
                AND app_member_role(project_id) <> 'VIEWER');
CREATE POLICY inspection_update ON site_inspections FOR UPDATE TO cde_app
    USING (created_by = app_current_user_id() OR assigned_to = app_current_user_id());

-- Audit: readable by project admins and document controllers.
CREATE POLICY audit_select ON audit_trail FOR SELECT TO cde_app
    USING (app_member_role(project_id) IN ('ADMIN', 'DOC_CONTROLLER'));
