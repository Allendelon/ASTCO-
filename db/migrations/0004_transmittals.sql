-- 0004_transmittals.sql
-- Transmittals: formal, unchangeable transfer of revisions between organisations.
-- Content can be edited only while the transmittal is a DRAFT. After it is
-- issued, only the status can move forward, and reviews are added as
-- separate response rows instead of overwriting the items.

CREATE TYPE transmittal_status AS ENUM ('DRAFT', 'ISSUED', 'UNDER_REVIEW', 'CLOSED');
CREATE TYPE review_code AS ENUM ('CODE_A', 'CODE_B', 'CODE_C', 'CODE_D');

CREATE TABLE cde_transmittals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         uuid NOT NULL REFERENCES projects(id),
    transmittal_number varchar(64) NOT NULL,        -- e.g. TR-CONT-CONS-MEP-00142
    sender_org_id      uuid NOT NULL,
    created_by         uuid NOT NULL DEFAULT app_current_user_id() REFERENCES users(id),
    subject            text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    message            text,
    reason_for_issue   text NOT NULL CHECK (reason_for_issue IN (
                           'FOR_APPROVAL', 'FOR_REVIEW', 'FOR_INFORMATION',
                           'FOR_CONSTRUCTION', 'FOR_TENDER', 'AS_BUILT')),
    status             transmittal_status NOT NULL DEFAULT 'DRAFT',
    sla_due_date       date,
    issued_at          timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, sender_org_id) REFERENCES project_organizations (project_id, organization_id),
    UNIQUE (project_id, transmittal_number),
    UNIQUE (id, project_id),
    CHECK ((status = 'DRAFT') = (issued_at IS NULL)),
    -- Anything that asks for a response needs a due date before it is issued.
    CHECK (status = 'DRAFT'
           OR reason_for_issue NOT IN ('FOR_APPROVAL', 'FOR_REVIEW')
           OR sla_due_date IS NOT NULL)
);

-- Recipients are people. Their organisation is recorded and checked against
-- their project membership. Several TO and CC recipients are allowed, across
-- organisations.
CREATE TABLE cde_transmittal_recipients (
    transmittal_id  uuid NOT NULL,
    project_id      uuid NOT NULL,
    user_id         uuid NOT NULL,
    organization_id uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('TO', 'CC')),
    PRIMARY KEY (transmittal_id, user_id),
    FOREIGN KEY (transmittal_id, project_id) REFERENCES cde_transmittals (id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, user_id, organization_id)
        REFERENCES project_members (project_id, user_id, organization_id)
);
CREATE INDEX cde_transmittal_recipients_org_idx ON cde_transmittal_recipients (organization_id, transmittal_id);

CREATE TABLE cde_transmittal_items (
    transmittal_id uuid NOT NULL,
    project_id     uuid NOT NULL,
    revision_id    uuid NOT NULL,
    PRIMARY KEY (transmittal_id, revision_id),
    FOREIGN KEY (transmittal_id, project_id) REFERENCES cde_transmittals (id, project_id) ON DELETE CASCADE,
    -- Same project only: you cannot transmit another project's revision.
    FOREIGN KEY (revision_id, project_id) REFERENCES cde_document_revisions (id, project_id)
);

-- Append-only review responses, one per item per responding organisation.
CREATE TABLE cde_transmittal_responses (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transmittal_id   uuid NOT NULL,
    revision_id      uuid NOT NULL,
    project_id       uuid NOT NULL,
    responder_org_id uuid NOT NULL,
    responded_by     uuid NOT NULL DEFAULT app_current_user_id() REFERENCES users(id),
    review_code      review_code NOT NULL,
    comments         text,
    responded_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (transmittal_id, revision_id) REFERENCES cde_transmittal_items (transmittal_id, revision_id),
    FOREIGN KEY (transmittal_id, project_id) REFERENCES cde_transmittals (id, project_id),
    UNIQUE (transmittal_id, revision_id, responder_org_id),
    -- Codes C and D mean the item is returned, so the reason must be written down.
    CHECK (review_code IN ('CODE_A', 'CODE_B') OR coalesce(length(trim(comments)), 0) > 0)
);

-- Party check for RLS and triggers: is the current user's organisation the
-- sender or a recipient of the transmittal?
CREATE FUNCTION app_transmittal_party(p_transmittal_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
          FROM cde_transmittals t
         WHERE t.id = p_transmittal_id
           AND (t.sender_org_id = app_member_org(t.project_id)
                OR EXISTS (SELECT 1 FROM cde_transmittal_recipients r
                            WHERE r.transmittal_id = t.id
                              AND r.organization_id = app_member_org(t.project_id)))
    )
$$;

CREATE FUNCTION cde_transmittals_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        IF (NEW.project_id, NEW.transmittal_number, NEW.sender_org_id, NEW.created_by, NEW.subject,
            NEW.message, NEW.reason_for_issue, NEW.sla_due_date, NEW.issued_at, NEW.created_at)
           IS DISTINCT FROM
           (OLD.project_id, OLD.transmittal_number, OLD.sender_org_id, OLD.created_by, OLD.subject,
            OLD.message, OLD.reason_for_issue, OLD.sla_due_date, OLD.issued_at, OLD.created_at)
        THEN
            RAISE EXCEPTION 'transmittal % has been issued and is immutable', OLD.transmittal_number
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status < OLD.status THEN
            RAISE EXCEPTION 'transmittal status cannot move backwards (% -> %)', OLD.status, NEW.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- OLD.status = 'DRAFT'
    IF NEW.status = 'DRAFT' THEN
        RETURN NEW;
    ELSIF NEW.status <> 'ISSUED' THEN
        RAISE EXCEPTION 'a draft transmittal can only move to ISSUED'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM cde_transmittal_items WHERE transmittal_id = NEW.id) THEN
        RAISE EXCEPTION 'transmittal % has no items', NEW.transmittal_number
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cde_transmittal_recipients WHERE transmittal_id = NEW.id AND kind = 'TO') THEN
        RAISE EXCEPTION 'transmittal % has no TO recipient', NEW.transmittal_number
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.issued_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER cde_transmittals_before_update BEFORE UPDATE ON cde_transmittals
    FOR EACH ROW EXECUTE FUNCTION cde_transmittals_before_update();

CREATE FUNCTION cde_transmittals_before_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'transmittal % has been issued and cannot be deleted', OLD.transmittal_number
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER cde_transmittals_before_delete BEFORE DELETE ON cde_transmittals
    FOR EACH ROW EXECUTE FUNCTION cde_transmittals_before_delete();

-- Items and recipients can only change while the parent is a DRAFT. If the
-- parent row is gone, this is a cascade from deleting a draft (issued
-- transmittals cannot be deleted), so it is allowed.
CREATE FUNCTION cde_transmittal_children_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_transmittal_id uuid;
    v_status         transmittal_status;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.transmittal_id <> NEW.transmittal_id THEN
        RAISE EXCEPTION 'cannot move % rows between transmittals', TG_TABLE_NAME
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_transmittal_id := OLD.transmittal_id;
    ELSE
        v_transmittal_id := NEW.transmittal_id;
    END IF;

    SELECT status INTO v_status FROM cde_transmittals WHERE id = v_transmittal_id;
    IF FOUND AND v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'transmittal has been issued; % on % rejected', TG_OP, TG_TABLE_NAME
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- WIP information stays inside the originating team (ISO 19650).
    IF TG_TABLE_NAME = 'cde_transmittal_items' AND TG_OP <> 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM cde_document_revisions WHERE id = NEW.revision_id AND cde_state = 'WIP') THEN
            RAISE EXCEPTION 'WIP revisions cannot be transmitted; share them first'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER cde_transmittal_items_guard BEFORE INSERT OR UPDATE OR DELETE ON cde_transmittal_items
    FOR EACH ROW EXECUTE FUNCTION cde_transmittal_children_guard();
CREATE TRIGGER cde_transmittal_recipients_guard BEFORE INSERT OR UPDATE OR DELETE ON cde_transmittal_recipients
    FOR EACH ROW EXECUTE FUNCTION cde_transmittal_children_guard();

-- Only a TO recipient's organisation may respond, and only while the
-- transmittal is open. SECURITY DEFINER because moving the transmittal to
-- UNDER_REVIEW is an update on a row the recipient cannot otherwise update.
CREATE FUNCTION cde_transmittal_responses_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status transmittal_status;
BEGIN
    SELECT status INTO v_status FROM cde_transmittals WHERE id = NEW.transmittal_id FOR UPDATE;
    IF v_status NOT IN ('ISSUED', 'UNDER_REVIEW') THEN
        RAISE EXCEPTION 'transmittal is % and does not accept responses', v_status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cde_transmittal_recipients
                    WHERE transmittal_id = NEW.transmittal_id
                      AND organization_id = NEW.responder_org_id
                      AND kind = 'TO') THEN
        RAISE EXCEPTION 'only TO recipients can respond to a transmittal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.responded_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER cde_transmittal_responses_before_insert BEFORE INSERT ON cde_transmittal_responses
    FOR EACH ROW EXECUTE FUNCTION cde_transmittal_responses_before_insert();

CREATE FUNCTION cde_transmittal_responses_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE cde_transmittals SET status = 'UNDER_REVIEW'
     WHERE id = NEW.transmittal_id AND status = 'ISSUED';

    PERFORM audit_append(NEW.project_id, 'CODE_STAMPED', 'TRANSMITTAL', NEW.transmittal_id,
        jsonb_build_object('revision_id', NEW.revision_id, 'code', NEW.review_code,
                           'responder_org_id', NEW.responder_org_id));
    RETURN NULL;
END $$;

CREATE TRIGGER cde_transmittal_responses_after_insert AFTER INSERT ON cde_transmittal_responses
    FOR EACH ROW EXECUTE FUNCTION cde_transmittal_responses_after_insert();

CREATE FUNCTION cde_transmittal_responses_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'transmittal responses are append-only; submit a new transmittal to revise a review'
        USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER cde_transmittal_responses_no_change BEFORE UPDATE OR DELETE ON cde_transmittal_responses
    FOR EACH ROW EXECUTE FUNCTION cde_transmittal_responses_reject_change();

CREATE FUNCTION cde_transmittals_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM audit_append(NEW.project_id, 'TRANSMITTAL_' || NEW.status::text, 'TRANSMITTAL', NEW.id,
            jsonb_build_object('number', NEW.transmittal_number, 'from', OLD.status, 'to', NEW.status));
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER cde_transmittals_audit AFTER UPDATE ON cde_transmittals
    FOR EACH ROW EXECUTE FUNCTION cde_transmittals_audit();

-- Items waiting on a response past their SLA date.
CREATE VIEW cde_transmittals_overdue WITH (security_invoker = true) AS
SELECT t.id AS transmittal_id, t.project_id, t.transmittal_number, t.sla_due_date, i.revision_id
  FROM cde_transmittals t
  JOIN cde_transmittal_items i ON i.transmittal_id = t.id
 WHERE t.status IN ('ISSUED', 'UNDER_REVIEW')
   AND t.sla_due_date < current_date
   AND NOT EXISTS (SELECT 1 FROM cde_transmittal_responses r
                    WHERE r.transmittal_id = t.id AND r.revision_id = i.revision_id);
