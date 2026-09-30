-- 0009_security_hardening_2.sql
-- Second security review (docs/SECURITY-AUDIT.md, R2 findings).

-- ---------------------------------------------------------------------------
-- R2-02: the audit trail showed transmittal traffic between other organisations.
--
-- Transmittals are visible only to their sender and recipients (RLS in 0006),
-- but their audit entries were not: an admin or document controller of any
-- organisation on the project could read TRANSMITTAL_ISSUED / _CLOSED and
-- CODE_STAMPED entries (number, status, review codes, responder) for
-- transmittals they are not party to. Audit visibility now follows the
-- resource's own visibility:
--   - transmittal events: only parties to that transmittal (or the actor's
--     own organisation);
--   - revision events: as in 0008 (the revision must be visible to you;
--     other organisations' downloads only to project admins);
--   - everything else (inspections, which the whole project sees): unchanged.

DROP POLICY audit_select ON audit_trail;
CREATE POLICY audit_select ON audit_trail FOR SELECT TO cde_app
    USING (
        app_member_role(project_id) IN ('ADMIN', 'DOC_CONTROLLER')
        AND (
            app_is_same_org_actor(project_id, actor_id)
            OR (resource_type = 'TRANSMITTAL' AND app_transmittal_party(resource_id))
            OR (resource_type = 'REVISION'
                AND EXISTS (SELECT 1 FROM cde_document_revisions r WHERE r.id = audit_trail.resource_id)
                AND (action <> 'DOCUMENT_DOWNLOADED' OR app_member_role(project_id) = 'ADMIN'))
            OR resource_type NOT IN ('TRANSMITTAL', 'REVISION')
        )
    );
