-- 0003_cde.sql
-- ISO 19650 common data environment: document register and revisions.

-- CDE container states. "Archive" is not a state a revision moves into here:
-- every superseded revision is kept, unchangeable, and that retained history
-- is the archive.
CREATE TYPE cde_state AS ENUM ('WIP', 'SHARED', 'PUBLISHED');

-- Suitability codes differ between national annexes and projects, so they
-- are data per project rather than a fixed enum. Each code fixes the CDE state
-- and the revision prefix (P = preliminary, C = contractual) it may be used
-- with, and the foreign key on revisions enforces both.
CREATE TABLE project_suitability_codes (
    project_id      uuid NOT NULL REFERENCES projects(id),
    code            varchar(4) NOT NULL CHECK (code ~ '^[A-Z]{1,2}[0-9]{0,2}$'),
    cde_state       cde_state NOT NULL,
    revision_prefix char(1) NOT NULL CHECK (revision_prefix IN ('P', 'C')),
    description     text NOT NULL,
    PRIMARY KEY (project_id, code),
    UNIQUE (project_id, code, cde_state, revision_prefix)
);

-- A starting set modelled on the UK National Annex. Check it against the
-- project's information protocol before you rely on it.
CREATE FUNCTION seed_uk_na_suitability_codes(p_project_id uuid) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO project_suitability_codes (project_id, code, cde_state, revision_prefix, description)
    VALUES
        (p_project_id, 'S0', 'WIP',       'P', 'Initial status (work in progress)'),
        (p_project_id, 'S1', 'SHARED',    'P', 'Suitable for coordination'),
        (p_project_id, 'S2', 'SHARED',    'P', 'Suitable for information'),
        (p_project_id, 'S3', 'SHARED',    'P', 'Suitable for review and comment'),
        (p_project_id, 'S4', 'SHARED',    'P', 'Suitable for stage approval'),
        (p_project_id, 'A1', 'PUBLISHED', 'C', 'Authorised and accepted (stage 1)'),
        (p_project_id, 'A2', 'PUBLISHED', 'C', 'Authorised and accepted (stage 2)'),
        (p_project_id, 'A3', 'PUBLISHED', 'C', 'Authorised and accepted (stage 3)'),
        (p_project_id, 'B1', 'PUBLISHED', 'P', 'Partial sign-off with comments (stage 1)'),
        (p_project_id, 'B2', 'PUBLISHED', 'P', 'Partial sign-off with comments (stage 2)'),
        (p_project_id, 'CR', 'PUBLISHED', 'C', 'As-constructed record')
$$;

CREATE TABLE cde_documents (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        uuid NOT NULL,
    project_code      varchar(6) NOT NULL,
    originator_org_id uuid NOT NULL,
    -- ISO 19650 container name: PROJECT-ORIGINATOR-VOLUME-LEVEL-TYPE-ROLE-NUMBER
    originator_code   varchar(6) NOT NULL,
    volume_code       varchar(6) NOT NULL,
    level_code        varchar(6) NOT NULL,
    type_code         varchar(6) NOT NULL,
    role_code         varchar(6) NOT NULL,
    number_code       varchar(6) NOT NULL CHECK (number_code ~ '^[0-9]{4,6}$'),
    document_number   text GENERATED ALWAYS AS (
        project_code || '-' || originator_code || '-' || volume_code || '-' || level_code
        || '-' || type_code || '-' || role_code || '-' || number_code) STORED,
    title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
    created_by        uuid NOT NULL DEFAULT app_current_user_id() REFERENCES users(id),
    created_at        timestamptz NOT NULL DEFAULT now(),

    -- Constant columns, so each naming field can reference its own code list.
    volume_field      text NOT NULL GENERATED ALWAYS AS ('VOLUME') STORED,
    level_field       text NOT NULL GENERATED ALWAYS AS ('LEVEL') STORED,
    type_field        text NOT NULL GENERATED ALWAYS AS ('TYPE') STORED,
    role_field        text NOT NULL GENERATED ALWAYS AS ('ROLE') STORED,

    FOREIGN KEY (project_id, project_code) REFERENCES projects (id, code),
    FOREIGN KEY (project_id, originator_org_id, originator_code)
        REFERENCES project_organizations (project_id, organization_id, originator_code),
    FOREIGN KEY (project_id, volume_field, volume_code) REFERENCES project_code_values (project_id, field, code),
    FOREIGN KEY (project_id, level_field, level_code)   REFERENCES project_code_values (project_id, field, code),
    FOREIGN KEY (project_id, type_field, type_code)     REFERENCES project_code_values (project_id, field, code),
    FOREIGN KEY (project_id, role_field, role_code)     REFERENCES project_code_values (project_id, field, code),

    UNIQUE (project_id, originator_code, volume_code, level_code, type_code, role_code, number_code),
    UNIQUE (id, project_id, originator_org_id)
);

-- A document's identity never changes. Renumbering means a new document.
CREATE FUNCTION cde_documents_freeze_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.project_id, NEW.project_code, NEW.originator_org_id, NEW.originator_code,
        NEW.volume_code, NEW.level_code, NEW.type_code, NEW.role_code, NEW.number_code,
        NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.project_id, OLD.project_code, OLD.originator_org_id, OLD.originator_code,
        OLD.volume_code, OLD.level_code, OLD.type_code, OLD.role_code, OLD.number_code,
        OLD.created_by, OLD.created_at)
    THEN
        RAISE EXCEPTION 'document identity is immutable; register a new document instead'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER cde_documents_freeze_identity BEFORE UPDATE ON cde_documents
    FOR EACH ROW EXECUTE FUNCTION cde_documents_freeze_identity();

CREATE TABLE cde_document_revisions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       uuid NOT NULL,
    -- Copied from the document (and pinned by the FK) so RLS and cross-table
    -- checks do not have to join back to cde_documents.
    project_id        uuid NOT NULL,
    originator_org_id uuid NOT NULL,
    revision_seq      integer NOT NULL,   -- assigned by trigger, 1..n per document

    -- UK NA style revision: P01.01 (WIP), P01 (shared), C01 (published).
    revision_prefix   char(1) NOT NULL CHECK (revision_prefix IN ('P', 'C')),
    revision_major    smallint NOT NULL CHECK (revision_major BETWEEN 1 AND 99),
    revision_minor    smallint CHECK (revision_minor BETWEEN 1 AND 99),
    revision_label    text GENERATED ALWAYS AS (
        revision_prefix || lpad(revision_major::text, 2, '0')
        || coalesce('.' || lpad(revision_minor::text, 2, '0'), '')) STORED,

    suitability_code  varchar(4) NOT NULL,
    cde_state         cde_state NOT NULL,

    -- Immutable file content. object_key should be content-addressed
    -- (e.g. derived from sha256) in bucket storage with versioning or Object Lock.
    object_key        text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    sha256            bytea NOT NULL CHECK (octet_length(sha256) = 32),
    size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
    mime_type         text NOT NULL,
    original_filename text NOT NULL,
    uploaded_by       uuid NOT NULL DEFAULT app_current_user_id() REFERENCES users(id),
    created_at        timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (document_id, project_id, originator_org_id)
        REFERENCES cde_documents (id, project_id, originator_org_id),
    FOREIGN KEY (project_id, suitability_code, cde_state, revision_prefix)
        REFERENCES project_suitability_codes (project_id, code, cde_state, revision_prefix),
    -- Minor versions (P01.02) exist only in WIP. Sharing one means issuing a
    -- new major revision, so the CHECK also blocks promoting a minor in place.
    CHECK (revision_minor IS NULL OR cde_state = 'WIP'),
    UNIQUE (document_id, revision_label),
    UNIQUE (document_id, revision_seq),
    UNIQUE (id, project_id)
);
CREATE INDEX cde_document_revisions_project_idx ON cde_document_revisions (project_id, cde_state);

-- Sort key for revision order: P01.01 < P01.02 < P01 < P02.01 < P02 < C01 < C02.
CREATE FUNCTION cde_revision_sort_key(p_prefix char, p_major smallint, p_minor smallint)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
    SELECT (CASE p_prefix WHEN 'C' THEN 1 ELSE 0 END) * 1000000
         + p_major * 1000
         + coalesce(p_minor, 999)
$$;

CREATE FUNCTION cde_revisions_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_last record;
BEGIN
    -- Serialise revision creation per document.
    PERFORM pg_advisory_xact_lock(hashtextextended('rev:' || NEW.document_id::text, 0));

    SELECT revision_seq, revision_label, revision_prefix, revision_major, revision_minor
      INTO v_last
      FROM cde_document_revisions
     WHERE document_id = NEW.document_id
     ORDER BY revision_seq DESC
     LIMIT 1;

    IF FOUND AND cde_revision_sort_key(NEW.revision_prefix, NEW.revision_major, NEW.revision_minor)
              <= cde_revision_sort_key(v_last.revision_prefix, v_last.revision_major, v_last.revision_minor)
    THEN
        RAISE EXCEPTION 'revision % must come after the latest revision %',
            NEW.revision_prefix || lpad(NEW.revision_major::text, 2, '0')
                || coalesce('.' || lpad(NEW.revision_minor::text, 2, '0'), ''),
            v_last.revision_label
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    NEW.revision_seq := coalesce(v_last.revision_seq, 0) + 1;
    NEW.created_at   := now();
    RETURN NEW;
END $$;

CREATE TRIGGER cde_revisions_before_insert BEFORE INSERT ON cde_document_revisions
    FOR EACH ROW EXECUTE FUNCTION cde_revisions_before_insert();

-- File content and identity are frozen. Only suitability/state may change,
-- and the state may only move forward (WIP -> SHARED -> PUBLISHED).
CREATE FUNCTION cde_revisions_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.document_id, NEW.project_id, NEW.originator_org_id, NEW.revision_seq,
        NEW.revision_prefix, NEW.revision_major, NEW.revision_minor,
        NEW.object_key, NEW.sha256, NEW.size_bytes, NEW.mime_type, NEW.original_filename,
        NEW.uploaded_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.document_id, OLD.project_id, OLD.originator_org_id, OLD.revision_seq,
        OLD.revision_prefix, OLD.revision_major, OLD.revision_minor,
        OLD.object_key, OLD.sha256, OLD.size_bytes, OLD.mime_type, OLD.original_filename,
        OLD.uploaded_by, OLD.created_at)
    THEN
        RAISE EXCEPTION 'revision content is immutable; upload a new revision instead'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.cde_state < OLD.cde_state THEN
        RAISE EXCEPTION 'CDE state cannot move backwards (% -> %); upload a new revision instead',
            OLD.cde_state, NEW.cde_state
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER cde_revisions_before_update BEFORE UPDATE ON cde_document_revisions
    FOR EACH ROW EXECUTE FUNCTION cde_revisions_before_update();

-- Only WIP revisions can be deleted. Once shared, a revision is a record.
CREATE FUNCTION cde_revisions_before_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.cde_state <> 'WIP' THEN
        RAISE EXCEPTION 'revision % is % and cannot be deleted', OLD.revision_label, OLD.cde_state
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER cde_revisions_before_delete BEFORE DELETE ON cde_document_revisions
    FOR EACH ROW EXECUTE FUNCTION cde_revisions_before_delete();

CREATE FUNCTION cde_revisions_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append(NEW.project_id, 'REVISION_UPLOADED', 'REVISION', NEW.id,
            jsonb_build_object('revision', NEW.revision_label, 'suitability', NEW.suitability_code,
                               'sha256', encode(NEW.sha256, 'hex')));
    ELSIF TG_OP = 'UPDATE' THEN
        IF (NEW.suitability_code, NEW.cde_state) IS DISTINCT FROM (OLD.suitability_code, OLD.cde_state) THEN
            PERFORM audit_append(NEW.project_id, 'REVISION_STATUS_CHANGED', 'REVISION', NEW.id,
                jsonb_build_object('from', OLD.suitability_code, 'to', NEW.suitability_code));
        END IF;
    ELSE
        PERFORM audit_append(OLD.project_id, 'REVISION_DELETED', 'REVISION', OLD.id,
            jsonb_build_object('revision', OLD.revision_label));
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER cde_revisions_audit AFTER INSERT OR UPDATE OR DELETE ON cde_document_revisions
    FOR EACH ROW EXECUTE FUNCTION cde_revisions_audit();

-- Latest revision of each document the caller can see (RLS applies).
CREATE VIEW cde_document_latest WITH (security_invoker = true) AS
SELECT DISTINCT ON (r.document_id)
       d.document_number, d.title, r.*
  FROM cde_document_revisions r
  JOIN cde_documents d ON d.id = r.document_id
 ORDER BY r.document_id, r.revision_seq DESC;
