-- Behavioural tests for db/migrations. Run with db/tests/run.sh.
-- Any failed assertion aborts the script (ON_ERROR_STOP).

\set ON_ERROR_STOP 1
\pset tuples_only on
\o /dev/null
SET client_min_messages = warning;

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION t_expect_error(p_sql text, p_like text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN others THEN
        IF SQLERRM NOT ILIKE '%' || p_like || '%' THEN
            RAISE EXCEPTION 'wrong error for [%]: got "%", wanted "%"', p_sql, SQLERRM, p_like;
        END IF;
        RETURN;
    END;
    RAISE EXCEPTION 'expected an error containing "%" from [%]', p_like, p_sql;
END $$;

CREATE FUNCTION t_assert(p_ok boolean, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'assertion failed: %', p_msg;
    END IF;
END $$;

CREATE FUNCTION t_as(p_user uuid) RETURNS void
LANGUAGE sql AS $$
    SELECT set_config('app.user_id', p_user::text, false),
           set_config('app.client_ip', '203.0.113.10', false)
$$;

-- ------------------------------------------------------------------ seed
-- Seeded as the owner (bypasses RLS). Everything after runs as cde_app.
INSERT INTO organizations (id, legal_name) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'Contractor Co'),
    ('a0000000-0000-0000-0000-000000000002', 'Consultant Co'),
    ('a0000000-0000-0000-0000-000000000003', 'Unrelated Co'),
    ('a0000000-0000-0000-0000-000000000004', 'Client Co');

INSERT INTO users (id, organization_id, email, display_name) VALUES
    ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'dc@cont.test',     'Contractor DC'),
    ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'viewer@cont.test', 'Contractor Viewer'),
    ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'eng@cons.test',    'Consultant Engineer'),
    ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'x@othr.test',      'Outsider'),
    ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000004', 'pm@clnt.test',     'Client PM');

INSERT INTO projects (id, owner_org_id, code, name) VALUES
    ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000004', 'PRJ1', 'Tower A'),
    ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'PRJ2', 'Other job');

INSERT INTO project_organizations (project_id, organization_id, originator_code) VALUES
    ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'CONT'),
    ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'CONS'),
    ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000004', 'CLNT'),
    ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'OTHR');

INSERT INTO project_members (project_id, user_id, organization_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DOC_CONTROLLER'),
    ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'VIEWER'),
    ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'MEMBER'),
    ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000004', 'ADMIN'),
    ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'ADMIN');

-- A member must act for their own employer.
SELECT t_expect_error($$
    INSERT INTO project_members (project_id, user_id, organization_id, role)
    VALUES ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000003', 'MEMBER') $$, 'foreign key');

INSERT INTO project_code_values (project_id, field, code, description)
SELECT p, f, c, c
  FROM (VALUES ('c0000000-0000-0000-0000-000000000001'::uuid),
               ('c0000000-0000-0000-0000-000000000002'::uuid)) AS pr(p),
       (VALUES ('VOLUME', 'ZZ'), ('VOLUME', 'B1'), ('LEVEL', '00'), ('LEVEL', '01'),
               ('TYPE', 'DR'), ('TYPE', 'M3'), ('ROLE', 'A'), ('ROLE', 'M')) AS v(f, c);

SELECT seed_uk_na_suitability_codes('c0000000-0000-0000-0000-000000000001');
SELECT seed_uk_na_suitability_codes('c0000000-0000-0000-0000-000000000002');

-- Inserts a revision as the current user. Not SECURITY DEFINER: RLS applies.
-- Uploads through the lifecycle functions, as the API does (0012).
CREATE FUNCTION t_upload(p_project uuid, p_content text) RETURNS text
LANGUAGE sql AS $$
    SELECT k.key
      FROM (SELECT encode(sha256(convert_to(p_content, 'UTF8')), 'hex') AS key,
                   octet_length(convert_to(p_content, 'UTF8'))::bigint AS size) k,
           LATERAL (SELECT upload_begin(p_project, greatest(k.size, 1), 1099511627776, 100,
                                        interval '15 minutes') AS id) u
     WHERE upload_complete(u.id, k.key, k.size, 'application/pdf')
$$;

-- Uploads a file and inserts a revision as the current user, the way the API
-- does. Not SECURITY DEFINER: RLS applies.
CREATE FUNCTION t_rev(p_doc uuid, p_prefix char, p_major int, p_minor int,
                      p_suitability text, p_state cde_state) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_project uuid;
    v_key     text;
    v_id      uuid;
BEGIN
    SELECT project_id INTO v_project FROM cde_documents WHERE id = p_doc;
    v_key := t_upload(coalesce(v_project, '00000000-0000-0000-0000-000000000000'), gen_random_uuid()::text);
    INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id,
        revision_prefix, revision_major, revision_minor, suitability_code, cde_state,
        object_key, sha256, size_bytes, mime_type, original_filename)
    SELECT d.id, d.project_id, d.originator_org_id, p_prefix, p_major, p_minor,
           p_suitability, p_state, v_key, decode(v_key, 'hex'), 1, 'application/pdf', 'file.pdf'
      FROM cde_documents d WHERE d.id = p_doc
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

SET ROLE cde_app;


-- ------------------------------------------------------ document register
\echo document register
SELECT t_as('b0000000-0000-0000-0000-000000000001');   -- contractor DC

INSERT INTO cde_documents (id, project_id, project_code, originator_org_id, originator_code,
                           volume_code, level_code, type_code, role_code, number_code, title)
VALUES ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'PRJ1',
        'a0000000-0000-0000-0000-000000000001', 'CONT', 'ZZ', '01', 'DR', 'M', '0001', 'Level 01 HVAC layout'),
       ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'PRJ1',
        'a0000000-0000-0000-0000-000000000001', 'CONT', 'B1', '00', 'M3', 'M', '0002', 'MEP model');

SELECT t_assert((SELECT document_number FROM cde_documents
                  WHERE id = 'd0000000-0000-0000-0000-000000000001') = 'PRJ1-CONT-ZZ-01-DR-M-0001',
                'generated ISO 19650 document number');

-- Level code not in the project's code list.
SELECT t_expect_error($$
    INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code,
                               volume_code, level_code, type_code, role_code, number_code, title)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'PRJ1', 'a0000000-0000-0000-0000-000000000001',
            'CONT', 'ZZ', '99', 'DR', 'M', '0003', 'x') $$, 'foreign key');
-- Originator code belonging to another organisation.
SELECT t_expect_error($$
    INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code,
                               volume_code, level_code, type_code, role_code, number_code, title)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'PRJ1', 'a0000000-0000-0000-0000-000000000001',
            'CONS', 'ZZ', '01', 'DR', 'M', '0003', 'x') $$, 'foreign key');
-- Registering a document under another organisation's name (RLS).
SELECT t_expect_error($$
    INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code,
                               volume_code, level_code, type_code, role_code, number_code, title)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'PRJ1', 'a0000000-0000-0000-0000-000000000002',
            'CONS', 'ZZ', '01', 'DR', 'M', '0003', 'x') $$, 'row-level security');
-- Duplicate container name.
SELECT t_expect_error($$
    INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code,
                               volume_code, level_code, type_code, role_code, number_code, title)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'PRJ1', 'a0000000-0000-0000-0000-000000000001',
            'CONT', 'ZZ', '01', 'DR', 'M', '0001', 'dup') $$, 'duplicate key');
-- Identity is frozen; title is not.
SELECT t_expect_error($$ UPDATE cde_documents SET number_code = '0009'
                          WHERE id = 'd0000000-0000-0000-0000-000000000001' $$, 'identity is immutable');
UPDATE cde_documents SET title = 'Level 01 HVAC layout (rev title)' WHERE id = 'd0000000-0000-0000-0000-000000000001';

-- ------------------------------------------------------------- revisions
\echo revisions
SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 1, 1, 'S0', 'WIP');

-- WIP is invisible outside the originating organisation.
SELECT t_as('b0000000-0000-0000-0000-000000000003');   -- consultant
SELECT t_assert((SELECT count(*) FROM cde_document_revisions) = 0, 'consultant cannot see WIP revisions');
SELECT t_assert((SELECT count(*) FROM cde_documents) = 0, 'consultant cannot see WIP-only documents');
SELECT t_as('b0000000-0000-0000-0000-000000000001');

-- Suitability / state / prefix must agree (S2 is SHARED, not WIP; A1 needs a C revision).
SELECT t_expect_error($$ SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 1, 2, 'S2', 'WIP') $$, 'foreign key');
SELECT t_expect_error($$ SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 2, NULL, 'A1', 'PUBLISHED') $$, 'foreign key');
-- Minor versions exist only in WIP.
SELECT t_expect_error($$ SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 1, 2, 'S1', 'SHARED') $$, 'check constraint');
-- Integrity fields.
SELECT t_expect_error($$
    INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
        revision_major, suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename)
    VALUES ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000001', 'P', 1, 'S2', 'SHARED', 'k', '\x00', 10, 'x', 'x') $$,
    'upload the file again');   -- rejected by the upload binding before the CHECKs run

SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 1, NULL, 'S2', 'SHARED');

-- Revisions only move forward: P01 already exists after P01.01, so P01.02 is backdating.
SELECT t_expect_error($$ SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 1, 2, 'S0', 'WIP') $$, 'must come after');

SELECT t_as('b0000000-0000-0000-0000-000000000003');
SELECT t_assert((SELECT count(*) FROM cde_document_revisions) = 1, 'consultant sees the shared revision only');
SELECT t_assert((SELECT revision_label FROM cde_document_latest) = 'P01', 'latest view shows P01');
-- Consultant cannot upload into the contractor's document.
SELECT t_expect_error($$ SELECT t_rev('d0000000-0000-0000-0000-000000000001', 'P', 2, NULL, 'S2', 'SHARED') $$, 'row-level security');
SELECT t_as('b0000000-0000-0000-0000-000000000001');

-- Content is immutable, even for the originator's document controller.
SELECT t_expect_error($$ UPDATE cde_document_revisions SET object_key = 'evil'
                          WHERE revision_label = 'P01' $$, 'immutable');
SELECT t_expect_error($$ UPDATE cde_document_revisions SET sha256 = sha256('x'::bytea)
                          WHERE revision_label = 'P01' $$, 'immutable');
-- State moves forward only; S2 -> S3 inside SHARED is allowed.
UPDATE cde_document_revisions SET suitability_code = 'S3' WHERE revision_label = 'P01';
SELECT t_expect_error($$ UPDATE cde_document_revisions SET suitability_code = 'S0', cde_state = 'WIP'
                          WHERE revision_label = 'P01' $$, 'cannot move backwards');
-- Promoting a P revision to A1 in place is impossible: A1 requires a C revision.
SELECT t_expect_error($$ UPDATE cde_document_revisions SET suitability_code = 'A1', cde_state = 'PUBLISHED'
                          WHERE revision_label = 'P01' $$, 'foreign key');
-- Shared revisions are records and cannot be deleted; WIP ones can.
SELECT t_expect_error($$ DELETE FROM cde_document_revisions WHERE revision_label = 'P01' $$, 'cannot be deleted');

-- A viewer cannot change suitability (RLS: the update matches zero rows).
SELECT t_as('b0000000-0000-0000-0000-000000000002');
UPDATE cde_document_revisions SET suitability_code = 'S4' WHERE revision_label = 'P01';
SELECT t_as('b0000000-0000-0000-0000-000000000001');
SELECT t_assert((SELECT suitability_code FROM cde_document_revisions WHERE revision_label = 'P01') = 'S3',
                'viewer update had no effect');

SELECT t_rev('d0000000-0000-0000-0000-000000000002', 'P', 1, NULL, 'S1', 'SHARED');
SELECT t_rev('d0000000-0000-0000-0000-000000000002', 'P', 2, 1, 'S0', 'WIP');

-- ----------------------------------------------------------- transmittals
\echo transmittals
INSERT INTO cde_transmittals (id, project_id, transmittal_number, sender_org_id, subject, reason_for_issue)
VALUES ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
        'TR-CONT-CONS-MEP-00001', 'a0000000-0000-0000-0000-000000000001', 'HVAC L01 for approval',
        'FOR_APPROVAL');

-- WIP revisions cannot be transmitted.
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_items (transmittal_id, project_id, revision_id)
    SELECT 'e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', id
      FROM cde_document_revisions WHERE document_id = 'd0000000-0000-0000-0000-000000000002'
       AND cde_state = 'WIP' $$, 'WIP revisions cannot be transmitted');

INSERT INTO cde_transmittal_items (transmittal_id, project_id, revision_id)
SELECT 'e0000000-0000-0000-0000-000000000001', project_id, id
  FROM cde_document_revisions WHERE cde_state <> 'WIP';

-- Issue checks: needs a TO recipient and, for approval, an SLA date.
SELECT t_expect_error($$ UPDATE cde_transmittals SET status = 'ISSUED'
                          WHERE id = 'e0000000-0000-0000-0000-000000000001' $$, 'no TO recipient');
INSERT INTO cde_transmittal_recipients (transmittal_id, project_id, user_id, organization_id, kind) VALUES
    ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'TO'),
    ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000004', 'CC');
-- A recipient from outside the project.
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_recipients (transmittal_id, project_id, user_id, organization_id, kind)
    VALUES ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'TO') $$,
    'foreign key');
SELECT t_expect_error($$ UPDATE cde_transmittals SET status = 'ISSUED'
                          WHERE id = 'e0000000-0000-0000-0000-000000000001' $$, 'check constraint');

UPDATE cde_transmittals SET sla_due_date = current_date + 14 WHERE id = 'e0000000-0000-0000-0000-000000000001';
UPDATE cde_transmittals SET status = 'ISSUED' WHERE id = 'e0000000-0000-0000-0000-000000000001';
SELECT t_assert((SELECT issued_at IS NOT NULL FROM cde_transmittals
                  WHERE id = 'e0000000-0000-0000-0000-000000000001'), 'issued_at stamped');

-- Issued means frozen.
SELECT t_expect_error($$ UPDATE cde_transmittals SET subject = 'edited'
                          WHERE id = 'e0000000-0000-0000-0000-000000000001' $$, 'immutable');
SELECT t_expect_error($$ UPDATE cde_transmittals SET status = 'DRAFT'
                          WHERE id = 'e0000000-0000-0000-0000-000000000001' $$, 'cannot move backwards');
SELECT t_expect_error($$ DELETE FROM cde_transmittals
                          WHERE id = 'e0000000-0000-0000-0000-000000000001' $$, 'cannot be deleted');
SELECT t_expect_error($$ DELETE FROM cde_transmittal_items
                          WHERE transmittal_id = 'e0000000-0000-0000-0000-000000000001' $$, 'has been issued');
SELECT t_expect_error($$ DELETE FROM cde_transmittal_recipients
                          WHERE transmittal_id = 'e0000000-0000-0000-0000-000000000001' $$, 'has been issued');

-- The sender cannot stamp its own submission.
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code)
    SELECT transmittal_id, revision_id, project_id, 'a0000000-0000-0000-0000-000000000001', 'CODE_A'
      FROM cde_transmittal_items LIMIT 1 $$, 'only TO recipients');

-- Outsiders on another project see nothing, not even through the audit trail.
SELECT t_as('b0000000-0000-0000-0000-000000000004');
SELECT t_assert((SELECT count(*) FROM cde_transmittals) = 0, 'outsider sees no transmittals');
SELECT t_assert((SELECT count(*) FROM cde_document_revisions) = 0, 'outsider sees no revisions');
SELECT t_assert((SELECT count(*) FROM users) = 1, 'outsider sees only themselves in the directory');
SELECT t_assert((SELECT count(*) FROM audit_trail) = 0, 'outsider sees no audit rows');
SELECT t_expect_error($$ SELECT audit_append('c0000000-0000-0000-0000-000000000001', 'DOCUMENT_DOWNLOADED',
                          'REVISION', gen_random_uuid()) $$, 'not a member');

-- The CC recipient can read but not stamp.
SELECT t_as('b0000000-0000-0000-0000-000000000005');
SELECT t_assert((SELECT count(*) FROM cde_transmittal_items) = 2, 'CC recipient sees the items');
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code)
    SELECT transmittal_id, revision_id, project_id, 'a0000000-0000-0000-0000-000000000004', 'CODE_A'
      FROM cde_transmittal_items LIMIT 1 $$, 'only TO recipients');
-- ...nor stamp in the name of the TO organisation.
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code)
    SELECT transmittal_id, revision_id, project_id, 'a0000000-0000-0000-0000-000000000002', 'CODE_A'
      FROM cde_transmittal_items LIMIT 1 $$, 'row-level security');

-- The consultant (TO) reviews.
SELECT t_as('b0000000-0000-0000-0000-000000000003');
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code)
    SELECT transmittal_id, revision_id, project_id, 'a0000000-0000-0000-0000-000000000002', 'CODE_C'
      FROM cde_transmittal_items LIMIT 1 $$, 'check constraint');   -- C needs comments

INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code, comments)
SELECT i.transmittal_id, i.revision_id, i.project_id, 'a0000000-0000-0000-0000-000000000002',
       CASE WHEN r.document_id = 'd0000000-0000-0000-0000-000000000001' THEN 'CODE_B'::review_code
            ELSE 'CODE_C' END,
       'See marked-up comments on duct sizing'
  FROM cde_transmittal_items i JOIN cde_document_revisions r ON r.id = i.revision_id;

SELECT t_assert((SELECT status FROM cde_transmittals) = 'UNDER_REVIEW', 'first response moves to UNDER_REVIEW');
SELECT t_expect_error($$ UPDATE cde_transmittal_responses SET review_code = 'CODE_A' $$, 'permission denied');
SELECT t_expect_error($$
    INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id, review_code)
    SELECT transmittal_id, revision_id, project_id, 'a0000000-0000-0000-0000-000000000002', 'CODE_A'
      FROM cde_transmittal_items LIMIT 1 $$, 'duplicate key');

-- The sender closes it; after that no more responses.
SELECT t_as('b0000000-0000-0000-0000-000000000001');
UPDATE cde_transmittals SET status = 'CLOSED' WHERE id = 'e0000000-0000-0000-0000-000000000001';

-- Transmittal numbers are unique per project, not globally.
SELECT t_as('b0000000-0000-0000-0000-000000000004');
INSERT INTO cde_transmittals (project_id, transmittal_number, sender_org_id, subject, reason_for_issue)
VALUES ('c0000000-0000-0000-0000-000000000002', 'TR-CONT-CONS-MEP-00001',
        'a0000000-0000-0000-0000-000000000003', 'Same number, other project', 'FOR_INFORMATION');
-- Drafts can be deleted, together with their items.
DELETE FROM cde_transmittals WHERE project_id = 'c0000000-0000-0000-0000-000000000002';

-- ------------------------------------------------------- site inspections
\echo site inspections
SELECT t_as('b0000000-0000-0000-0000-000000000001');

-- A 36-character UUID is not an IFC GlobalId.
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, ifc_global_id,
                                  model_revision_id, assigned_to)
    SELECT 'c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0001',
           'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', id, 'b0000000-0000-0000-0000-000000000003'
      FROM cde_document_revisions WHERE revision_label = 'P01' LIMIT 1 $$, 'value too long');
-- Coordinates outside the sheet.
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, sheet_revision_id,
                                  sheet_page, sheet_x_norm, sheet_y_norm, assigned_to)
    SELECT 'c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0001', id, 1, 1.2, 0.5,
           'b0000000-0000-0000-0000-000000000003'
      FROM cde_document_revisions WHERE document_id = 'd0000000-0000-0000-0000-000000000001' AND cde_state <> 'WIP' LIMIT 1 $$,
    'check constraint');
-- Half a pin (sheet without coordinates).
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, sheet_revision_id, assigned_to)
    SELECT 'c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0001', id, 'b0000000-0000-0000-0000-000000000003'
      FROM cde_document_revisions WHERE document_id = 'd0000000-0000-0000-0000-000000000001' AND cde_state <> 'WIP' LIMIT 1 $$,
    'check constraint');
-- Assigned to someone who is not on the project.
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, assigned_to)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0001', 'b0000000-0000-0000-0000-000000000004') $$,
    'foreign key');

INSERT INTO site_inspections (project_id, inspection_type, inspection_number, location_description,
                              ifc_global_id, model_revision_id, sheet_revision_id, sheet_page,
                              sheet_x_norm, sheet_y_norm, assigned_to)
SELECT 'c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0001', 'L01 riser',
       '2O2Fr$t4X7Zf8NOew3FLOH', m.id, s.id, 1, 0.42, 0.61, 'b0000000-0000-0000-0000-000000000003'
  FROM cde_document_revisions m, cde_document_revisions s
 WHERE m.document_id = 'd0000000-0000-0000-0000-000000000002' AND m.revision_label = 'P01'
   AND s.document_id = 'd0000000-0000-0000-0000-000000000001' AND s.revision_label = 'P01';

-- The requester cannot record the result of their own inspection (RLS: zero rows).
UPDATE site_inspections SET status = 'INSPECTED_PASS' WHERE inspection_number = 'WIR-0001';
SELECT t_assert((SELECT status FROM site_inspections WHERE inspection_number = 'WIR-0001') = 'REQUESTED',
                'requester cannot pass their own inspection');
-- Pins must point at revisions everyone can see.
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, sheet_revision_id,
                                  sheet_page, sheet_x_norm, sheet_y_norm, assigned_to)
    SELECT 'c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0002', id, 1, 0.5, 0.5,
           'b0000000-0000-0000-0000-000000000003'
      FROM cde_document_revisions WHERE cde_state = 'WIP' LIMIT 1 $$, 'shared or published');
SELECT t_expect_error($$
    INSERT INTO site_inspections (project_id, inspection_type, inspection_number, status, assigned_to)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'WIR', 'WIR-0003', 'INSPECTED_PASS',
            'b0000000-0000-0000-0000-000000000003') $$, 'starts as REQUESTED');

SELECT t_as('b0000000-0000-0000-0000-000000000003');   -- assignee records the result
SELECT t_expect_error($$ UPDATE site_inspections SET location_description = 'moved'
                          WHERE inspection_number = 'WIR-0001' $$, 'only the result');
UPDATE site_inspections SET status = 'INSPECTED_PASS' WHERE inspection_number = 'WIR-0001';
-- Results are final.
SELECT t_expect_error($$ UPDATE site_inspections SET status = 'INSPECTED_FAIL'
                          WHERE inspection_number = 'WIR-0001' $$, 'already has a result');

-- ------------------------------------------------------------ upload binding
\echo upload binding
-- The consultant knows the hash of a contractor WIP file (e.g. from the audit
-- trail) and tries to attach that file to a document of their own.
RESET ROLE;
INSERT INTO cde_documents (id, project_id, project_code, originator_org_id, originator_code,
                           volume_code, level_code, type_code, role_code, number_code, title, created_by)
VALUES ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001', 'PRJ1',
        'a0000000-0000-0000-0000-000000000002', 'CONS', 'ZZ', '01', 'DR', 'M', '0001', 'Consultant doc',
        'b0000000-0000-0000-0000-000000000003');
CREATE TEMP TABLE t_wip_key AS
SELECT object_key FROM cde_document_revisions WHERE cde_state = 'WIP' LIMIT 1;
GRANT SELECT ON t_wip_key TO cde_app;
SET ROLE cde_app;
SELECT t_as('b0000000-0000-0000-0000-000000000003');
SELECT t_expect_error($$
    INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
        revision_major, suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename)
    SELECT 'd0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
           'a0000000-0000-0000-0000-000000000002', 'P', 1, 'S2', 'SHARED', object_key, decode(object_key, 'hex'),
           1, 'application/pdf', 'x.pdf'
      FROM t_wip_key $$, 'upload the file again');
-- Their own upload works, but only once.
SELECT t_upload('c0000000-0000-0000-0000-000000000001', 'consultant file');
INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
    revision_major, suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename)
VALUES ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002', 'P', 1, 'S2', 'SHARED',
        encode(sha256('consultant file'::bytea), 'hex'), sha256('consultant file'::bytea), 999, 'text/html', 'x.pdf');
SELECT t_assert((SELECT size_bytes = 15 AND mime_type = 'application/pdf' FROM cde_document_revisions
                  WHERE document_id = 'd0000000-0000-0000-0000-000000000009'),
                'size and type come from the upload, not the client');
SELECT t_expect_error($$
    INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
        revision_major, suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename)
    VALUES ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000002', 'P', 2, 'S2', 'SHARED',
            encode(sha256('consultant file'::bytea), 'hex'), sha256('consultant file'::bytea), 15,
            'application/pdf', 'x.pdf') $$, 'upload the file again');
-- Key and hash must agree.
SELECT t_upload('c0000000-0000-0000-0000-000000000001', 'another file');
SELECT t_expect_error($$
    INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
        revision_major, suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename)
    VALUES ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000002', 'P', 2, 'S2', 'SHARED',
            encode(sha256('another file'::bytea), 'hex'), sha256('x'::bytea), 12,
            'application/pdf', 'x.pdf') $$, 'check constraint');
-- Nobody else can see your uploads.
SELECT t_as('b0000000-0000-0000-0000-000000000001');
SELECT t_assert(NOT EXISTS (SELECT 1 FROM cde_uploads WHERE uploaded_by <> 'b0000000-0000-0000-0000-000000000001'),
                'uploads are private to the uploader');

-- ------------------------------------------------------------ audit trail
\echo audit trail
SELECT t_as('b0000000-0000-0000-0000-000000000003');
SELECT audit_append('c0000000-0000-0000-0000-000000000001', 'DOCUMENT_DOWNLOADED', 'REVISION',
                    (SELECT id FROM cde_document_revisions WHERE revision_label = 'P01' LIMIT 1));
-- A MEMBER-role user cannot read the audit trail. The client ADMIN can.
SELECT t_assert((SELECT count(*) FROM audit_trail) = 0, 'members cannot read the audit trail');
SELECT t_as('b0000000-0000-0000-0000-000000000005');
SELECT t_assert((SELECT count(*) FROM audit_trail WHERE action = 'CODE_STAMPED') = 2, 'code stamps audited');
SELECT t_assert(NOT EXISTS (SELECT 1 FROM audit_trail a
                             WHERE a.resource_type = 'REVISION'
                               AND a.actor_id = 'b0000000-0000-0000-0000-000000000001'
                               AND a.details->>'suitability' = 'S0'),
                'other organisations cannot see audit entries about your WIP');
SELECT t_assert((SELECT count(*) FROM audit_trail WHERE action = 'TRANSMITTAL_ISSUED') = 1, 'issue audited');
SELECT t_assert((SELECT actor_ip FROM audit_trail WHERE action = 'DOCUMENT_DOWNLOADED') = '203.0.113.10',
                'actor IP comes from the request context');

-- The app role cannot write the table directly or change it.
SELECT t_expect_error($$ INSERT INTO audit_trail (project_id, action, resource_type, resource_id, event_timestamp, current_hash)
                          VALUES ('c0000000-0000-0000-0000-000000000001', 'FAKE', 'X', gen_random_uuid(), now(), sha256('x'::bytea)) $$,
                      'permission denied');
SELECT t_expect_error($$ UPDATE audit_trail SET action = 'FAKE' $$, 'permission denied');
SELECT t_expect_error($$ DELETE FROM audit_trail $$, 'permission denied');

RESET ROLE;
-- Even the owner is blocked by the append-only triggers.
SELECT t_expect_error($$ UPDATE audit_trail SET action = 'FAKE' WHERE chain_seq = 1 $$, 'append-only');
SELECT t_expect_error($$ DELETE FROM audit_trail WHERE chain_seq = 1 $$, 'append-only');
SELECT t_expect_error($$ TRUNCATE audit_trail $$, 'append-only');
SELECT t_expect_error($$ UPDATE cde_transmittal_responses SET review_code = 'CODE_A' $$, 'append-only');

SELECT t_assert(audit_verify_chain('c0000000-0000-0000-0000-000000000001') IS NULL, 'chain verifies');
SELECT t_assert((SELECT max(chain_seq) FROM audit_trail
                  WHERE project_id = 'c0000000-0000-0000-0000-000000000001')
                = (SELECT count(*) FROM audit_trail
                    WHERE project_id = 'c0000000-0000-0000-0000-000000000001'), 'chain has no gaps');

-- A superuser who disables the triggers and edits a row is caught by verification.
ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_update_delete;
UPDATE audit_trail SET details = '{"code": "CODE_A"}'
 WHERE project_id = 'c0000000-0000-0000-0000-000000000001' AND chain_seq = 5;
ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_update_delete;
SELECT t_assert(audit_verify_chain('c0000000-0000-0000-0000-000000000001') = 5, 'tampered row detected');

-- ------------------------------------------------------ system audit entries
\echo system audit entries
-- A system job (the owner role, no request user) can load a revision; its
-- audit entry has no actor. The app role without a user still cannot write.
SELECT set_config('app.user_id', '', false);
INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix, revision_major,
    suitability_code, cde_state, object_key, sha256, size_bytes, mime_type, original_filename, uploaded_by)
VALUES ('d0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002', 'P', 5, 'S2', 'SHARED',
        encode(sha256('imported'::bytea), 'hex'), sha256('imported'::bytea), 8, 'application/pdf', 'imported.pdf',
        'b0000000-0000-0000-0000-000000000003');
SELECT t_assert((SELECT actor_id IS NULL FROM audit_trail WHERE action = 'REVISION_UPLOADED'
                  ORDER BY id DESC LIMIT 1), 'system entry has no actor');
SET ROLE cde_app;
SELECT t_expect_error($$ SELECT audit_append('c0000000-0000-0000-0000-000000000001', 'FAKE', 'X', gen_random_uuid()) $$,
                      'no user in the request context');
RESET ROLE;

\echo all schema tests passed
