-- 0001_core.sql
-- Organisations, users, projects, membership and project code lists.
--
-- Requires PostgreSQL 15+ (gen_random_uuid(), sha256(), security_invoker views).
--
-- Request context: the API sets these per transaction, e.g.
--   SELECT set_config('app.user_id',   '<uuid>',     true);
--   SELECT set_config('app.client_ip', '203.0.113.7', true);
-- Row-level security (0006) and the audit chain (0002) read them.

CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_client_ip() RETURNS inet
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.client_ip', true), '')::inet
$$;

-- Organisations are independent companies (contractor, consultant, client).
-- A project brings several of them together, which is the Aconex model: a
-- project is shared space, but each organisation's work stays private until
-- it is shared or transmitted.
CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name  text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 255),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    email           text NOT NULL CHECK (email LIKE '%_@_%'),
    display_name    text NOT NULL,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE projects (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_org_id uuid NOT NULL REFERENCES organizations(id),
    -- ISO 19650 "Project" field of the container name.
    code         varchar(6) NOT NULL CHECK (code ~ '^[A-Z0-9]{2,6}$'),
    name         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_org_id, code),
    UNIQUE (id, code)
);

-- Organisations taking part in a project. The ISO 19650 originator code is
-- assigned per project by the information protocol, not globally.
CREATE TABLE project_organizations (
    project_id       uuid NOT NULL REFERENCES projects(id),
    organization_id  uuid NOT NULL REFERENCES organizations(id),
    originator_code  varchar(6) NOT NULL CHECK (originator_code ~ '^[A-Z0-9]{3,6}$'),
    PRIMARY KEY (project_id, organization_id),
    UNIQUE (project_id, originator_code),
    UNIQUE (project_id, organization_id, originator_code)
);

CREATE TABLE project_members (
    project_id      uuid NOT NULL,
    user_id         uuid NOT NULL,
    organization_id uuid NOT NULL,
    role            text NOT NULL CHECK (role IN ('ADMIN', 'DOC_CONTROLLER', 'MEMBER', 'VIEWER')),
    is_active       boolean NOT NULL DEFAULT true,
    PRIMARY KEY (project_id, user_id),
    UNIQUE (project_id, user_id, organization_id),
    FOREIGN KEY (project_id, organization_id) REFERENCES project_organizations (project_id, organization_id),
    -- A member always acts for the organisation that employs them.
    FOREIGN KEY (user_id, organization_id) REFERENCES users (id, organization_id)
);

-- Project-configurable code lists for the remaining naming fields
-- (the information protocol's "picklists").
CREATE TABLE project_code_values (
    project_id  uuid NOT NULL REFERENCES projects(id),
    field       text NOT NULL CHECK (field IN ('VOLUME', 'LEVEL', 'TYPE', 'ROLE')),
    code        varchar(6) NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
    description text NOT NULL,
    PRIMARY KEY (project_id, field, code)
);

-- Organisation of the current user on a project, or NULL when the user is
-- not an active member. SECURITY DEFINER so RLS policies can call it without
-- recursing into project_members' own policy.
CREATE FUNCTION app_member_org(p_project_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT organization_id
      FROM project_members
     WHERE project_id = p_project_id
       AND user_id = app_current_user_id()
       AND is_active
$$;

CREATE FUNCTION app_member_role(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT role
      FROM project_members
     WHERE project_id = p_project_id
       AND user_id = app_current_user_id()
       AND is_active
$$;
