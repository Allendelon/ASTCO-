-- ADR-006: code lists and suitability codes are project data, entered by the
-- project's information manager, so their Arabic text lives beside the
-- English in the database rather than in the UI catalog. NULL means "not
-- translated"; the UI then shows the English description.

ALTER TABLE project_code_values
    ADD COLUMN description_ar text CHECK (length(description_ar) BETWEEN 1 AND 200);
ALTER TABLE project_suitability_codes
    ADD COLUMN description_ar text CHECK (length(description_ar) BETWEEN 1 AND 200);

-- Arabic for the UK National Annex starting set. First translation: have a
-- native-speaking information manager confirm it (docs/I18N.md).
CREATE TEMP TABLE uk_na_ar (code text PRIMARY KEY, en text NOT NULL, ar text NOT NULL) ON COMMIT DROP;
INSERT INTO uk_na_ar VALUES
    ('S0', 'Initial status (work in progress)',        'الحالة الأولية (قيد العمل)'),
    ('S1', 'Suitable for coordination',                'مناسب للتنسيق'),
    ('S2', 'Suitable for information',                 'مناسب للعلم'),
    ('S3', 'Suitable for review and comment',          'مناسب للمراجعة والتعليق'),
    ('S4', 'Suitable for stage approval',              'مناسب لاعتماد المرحلة'),
    ('A1', 'Authorised and accepted (stage 1)',        'معتمد ومقبول (المرحلة 1)'),
    ('A2', 'Authorised and accepted (stage 2)',        'معتمد ومقبول (المرحلة 2)'),
    ('A3', 'Authorised and accepted (stage 3)',        'معتمد ومقبول (المرحلة 3)'),
    ('B1', 'Partial sign-off with comments (stage 1)', 'اعتماد جزئي مع ملاحظات (المرحلة 1)'),
    ('B2', 'Partial sign-off with comments (stage 2)', 'اعتماد جزئي مع ملاحظات (المرحلة 2)'),
    ('CR', 'As-constructed record',                    'سجل حسب التنفيذ');

-- Backfill only rows still carrying the default English text: a project that
-- reworded a code has its own meaning, which a stock translation would contradict.
UPDATE project_suitability_codes s
   SET description_ar = t.ar
  FROM uk_na_ar t
 WHERE s.code = t.code AND s.description = t.en AND s.description_ar IS NULL;

CREATE OR REPLACE FUNCTION seed_uk_na_suitability_codes(p_project_id uuid) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO project_suitability_codes (project_id, code, cde_state, revision_prefix, description, description_ar)
    VALUES
        (p_project_id, 'S0', 'WIP',       'P', 'Initial status (work in progress)',        'الحالة الأولية (قيد العمل)'),
        (p_project_id, 'S1', 'SHARED',    'P', 'Suitable for coordination',                'مناسب للتنسيق'),
        (p_project_id, 'S2', 'SHARED',    'P', 'Suitable for information',                 'مناسب للعلم'),
        (p_project_id, 'S3', 'SHARED',    'P', 'Suitable for review and comment',          'مناسب للمراجعة والتعليق'),
        (p_project_id, 'S4', 'SHARED',    'P', 'Suitable for stage approval',              'مناسب لاعتماد المرحلة'),
        (p_project_id, 'A1', 'PUBLISHED', 'C', 'Authorised and accepted (stage 1)',        'معتمد ومقبول (المرحلة 1)'),
        (p_project_id, 'A2', 'PUBLISHED', 'C', 'Authorised and accepted (stage 2)',        'معتمد ومقبول (المرحلة 2)'),
        (p_project_id, 'A3', 'PUBLISHED', 'C', 'Authorised and accepted (stage 3)',        'معتمد ومقبول (المرحلة 3)'),
        (p_project_id, 'B1', 'PUBLISHED', 'P', 'Partial sign-off with comments (stage 1)', 'اعتماد جزئي مع ملاحظات (المرحلة 1)'),
        (p_project_id, 'B2', 'PUBLISHED', 'P', 'Partial sign-off with comments (stage 2)', 'اعتماد جزئي مع ملاحظات (المرحلة 2)'),
        (p_project_id, 'CR', 'PUBLISHED', 'C', 'As-constructed record',                    'سجل حسب التنفيذ')
$$;
