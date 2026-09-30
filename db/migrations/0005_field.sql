-- 0005_field.sql
-- Site inspections and field issues, pinned to a 2D sheet and/or a 3D model element.

CREATE TABLE site_inspections (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            uuid NOT NULL REFERENCES projects(id),
    inspection_type       text NOT NULL CHECK (inspection_type IN ('WIR', 'MIR', 'SAFETY', 'QAQC')),
    inspection_number     varchar(64) NOT NULL,
    location_description  text,

    -- 3D pin. An IFC GlobalId is a 22-character compressed GUID, not a
    -- 36-character UUID, and the first character is always 0-3. It only means
    -- something together with the model revision it was taken from.
    ifc_global_id         char(22) CHECK (ifc_global_id ~ '^[0-3][0-9A-Za-z_$]{21}$'),
    model_revision_id     uuid,

    -- 2D pin, as coordinates normalised to the page (0..1).
    sheet_revision_id     uuid,
    sheet_page            integer CHECK (sheet_page >= 1),
    sheet_x_norm          double precision CHECK (sheet_x_norm BETWEEN 0 AND 1),
    sheet_y_norm          double precision CHECK (sheet_y_norm BETWEEN 0 AND 1),

    status                text NOT NULL DEFAULT 'REQUESTED'
                          CHECK (status IN ('REQUESTED', 'INSPECTED_PASS', 'INSPECTED_FAIL')),
    created_by            uuid NOT NULL DEFAULT app_current_user_id(),
    assigned_to           uuid NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),

    UNIQUE (project_id, inspection_number),
    FOREIGN KEY (model_revision_id, project_id) REFERENCES cde_document_revisions (id, project_id),
    FOREIGN KEY (sheet_revision_id, project_id) REFERENCES cde_document_revisions (id, project_id),
    FOREIGN KEY (project_id, created_by)  REFERENCES project_members (project_id, user_id),
    FOREIGN KEY (project_id, assigned_to) REFERENCES project_members (project_id, user_id),
    CHECK ((ifc_global_id IS NULL) = (model_revision_id IS NULL)),
    CHECK ((sheet_revision_id IS NULL) = (sheet_x_norm IS NULL)
       AND (sheet_x_norm IS NULL) = (sheet_y_norm IS NULL)
       AND (sheet_x_norm IS NULL) = (sheet_page IS NULL))
);
CREATE INDEX site_inspections_assignee_idx ON site_inspections (project_id, assigned_to, status);

CREATE FUNCTION site_inspections_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append(NEW.project_id, 'INSPECTION_REQUESTED', 'INSPECTION', NEW.id,
            jsonb_build_object('number', NEW.inspection_number, 'type', NEW.inspection_type));
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM audit_append(NEW.project_id, 'INSPECTION_' || NEW.status, 'INSPECTION', NEW.id,
            jsonb_build_object('number', NEW.inspection_number, 'from', OLD.status));
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER site_inspections_audit AFTER INSERT OR UPDATE ON site_inspections
    FOR EACH ROW EXECUTE FUNCTION site_inspections_audit();
