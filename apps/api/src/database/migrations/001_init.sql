-- AI Gurukul core schema.
-- Conventions: UUID primary keys, timestamptz, money in integer paise,
-- every tenant-owned table carries tenant_id and is protected by RLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Role the API switches to (SET LOCAL ROLE) inside tenant-scoped transactions.
-- It never bypasses RLS, even when the connection itself is a superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    CREATE ROLE gurukul_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Tenancy, identity and access
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('personal','school','coaching','white_label','publisher','enterprise')),
  slug        text NOT NULL UNIQUE,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- branding, enabled features, support details
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain              text NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','failed')),
  verification_token  text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- A domain can be verified by at most one tenant.
CREATE UNIQUE INDEX tenant_domains_verified_uq ON tenant_domains (lower(domain)) WHERE verification_status = 'verified';

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL,
  phone          text,
  password_hash  text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,           -- rotation family; reuse of a rotated token revokes the family
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE roles (
  id          text PRIMARY KEY,         -- tenant_owner, tenant_admin, teacher, parent, student, content_reviewer
  name        text NOT NULL,
  permissions text[] NOT NULL
);

CREATE TABLE tenant_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    text NOT NULL REFERENCES roles(id),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role_id)
);
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships (user_id);

CREATE TABLE tenant_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role_id     text NOT NULL REFERENCES roles(id),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Curriculum (platform-owned rows have tenant_id NULL; tenants may add their own)
-- ---------------------------------------------------------------------------
CREATE TABLE boards (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL UNIQUE,
  region text
);

CREATE TABLE grades (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL UNIQUE,
  sequence int  NOT NULL
);

CREATE TABLE subjects (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE
);

CREATE TABLE curriculum_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id        uuid NOT NULL REFERENCES boards(id),
  grade_id        uuid NOT NULL REFERENCES grades(id),
  academic_year   text NOT NULL,
  version         int  NOT NULL DEFAULT 1,
  source          text NOT NULL,          -- where the syllabus came from (official circular, publisher...)
  approval_status text NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','approved','retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, grade_id, academic_year, version)
);

CREATE TABLE chapters (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_version_id uuid NOT NULL REFERENCES curriculum_versions(id) ON DELETE CASCADE,
  subject_id            uuid NOT NULL REFERENCES subjects(id),
  title                 text NOT NULL,
  sequence              int  NOT NULL,
  -- Verified exam weightage (0..1) from an official blueprint; NULL = unknown.
  exam_weightage        numeric(5,4) CHECK (exam_weightage BETWEEN 0 AND 1),
  weightage_source      text
);

CREATE TABLE topics (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id             uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title                  text NOT NULL,
  sequence               int  NOT NULL,
  difficulty             smallint NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  estimated_minutes      int NOT NULL DEFAULT 45 CHECK (estimated_minutes > 0),
  prerequisite_topic_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX topics_chapter_idx ON topics (chapter_id);

CREATE TABLE lessons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = platform content
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL,                                     -- markdown body / avatar script source
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','published','archived')),
  version    int  NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_topic_idx ON lessons (topic_id);

CREATE TABLE content_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  lesson_id        uuid REFERENCES lessons(id) ON DELETE SET NULL,
  title            text NOT NULL,
  storage_key      text,
  type             text NOT NULL CHECK (type IN ('pdf','video','image','text','avatar_video','audio')),
  license_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','processing','indexed','failed')),
  approval_status  text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  topic_id     uuid REFERENCES topics(id) ON DELETE SET NULL,
  chunk_text   text NOT NULL,
  page_number  int,
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (search_tsv);
CREATE INDEX document_chunks_topic_idx ON document_chunks (topic_id);

-- ---------------------------------------------------------------------------
-- Students, parents, enrollment
-- ---------------------------------------------------------------------------
CREATE TABLE student_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  curriculum_version_id uuid REFERENCES curriculum_versions(id),
  language              text NOT NULL DEFAULT 'en',
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',
  daily_study_minutes   int  NOT NULL DEFAULT 90 CHECK (daily_study_minutes BETWEEN 0 AND 720),
  weekday_minutes       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"0":120,"6":120} overrides by weekday (0=Sun)
  accessibility         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE parent_student_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  relationship   text NOT NULL DEFAULT 'guardian',
  consent_status text NOT NULL DEFAULT 'granted' CHECK (consent_status IN ('pending','granted','revoked')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, student_id)
);

CREATE TABLE lesson_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  lesson_id    uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (student_id, lesson_id)
);

-- Syllabus coverage taught in class (school/coaching reports it, or the student self-reports).
CREATE TABLE syllabus_coverage (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('not_started','taught','missed','self_studied')),
  source     text NOT NULL DEFAULT 'student',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, topic_id)
);

-- ---------------------------------------------------------------------------
-- AI tutor and avatar
-- ---------------------------------------------------------------------------
CREATE TABLE tutor_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  topic_id   uuid REFERENCES topics(id),
  lesson_id  uuid REFERENCES lessons(id),
  mode       text NOT NULL DEFAULT 'text' CHECK (mode IN ('text','voice','avatar')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tutor_sessions_student_idx ON tutor_sessions (tenant_id, student_id);

CREATE TABLE tutor_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('student','assistant','system')),
  content     text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_flags text[] NOT NULL DEFAULT '{}',
  feedback    smallint CHECK (feedback IN (-1, 1)),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tutor_messages_session_idx ON tutor_messages (session_id, created_at);

CREATE TABLE avatar_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lesson_id        uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  provider_job_id  text,
  avatar_id        text NOT NULL,
  language         text NOT NULL,
  script           text NOT NULL,
  captions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  media_key        text,
  error            text,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Assessments and mastery evidence
-- ---------------------------------------------------------------------------
CREATE TABLE assessments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = platform
  chapter_id uuid REFERENCES chapters(id),
  lesson_id  uuid REFERENCES lessons(id),
  title      text NOT NULL,
  kind       text NOT NULL DEFAULT 'chapter_test' CHECK (kind IN ('diagnostic','quiz','chapter_test','mock_exam')),
  max_marks  int  NOT NULL CHECK (max_marks > 0),
  status     text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','in_review','published','archived')),
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES topics(id),
  type          text NOT NULL CHECK (type IN ('mcq','numeric','short_answer','descriptive')),
  prompt        text NOT NULL,
  options       jsonb,                    -- for mcq: ["...","..."]
  answer_key    jsonb,                    -- never sent to students
  rubric        text,
  marks         int  NOT NULL CHECK (marks > 0),
  difficulty    smallint NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  sequence      int  NOT NULL
);

CREATE TABLE assessment_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  student_id    uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','graded')),
  score         numeric(8,2),
  max_score     int,
  started_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz
);
-- At most one open attempt per student per assessment.
CREATE UNIQUE INDEX assessment_attempts_open_uq ON assessment_attempts (assessment_id, student_id) WHERE status = 'in_progress';

CREATE TABLE student_answers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id    uuid NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES questions(id),
  answer        jsonb NOT NULL,
  marks_awarded numeric(6,2),
  review_status text NOT NULL DEFAULT 'auto' CHECK (review_status IN ('auto','pending_review','reviewed')),
  reviewed_by   uuid REFERENCES users(id),
  UNIQUE (attempt_id, question_id)
);

-- Measured mastery (from assessment evidence) and estimated mastery (self/teacher estimate)
-- are kept as separate kinds; the planner prefers measured evidence.
CREATE TABLE topic_mastery_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('measured','estimated')),
  score       numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence_type text NOT NULL,           -- assessment_attempt, teacher_estimate, self_report, exam_marks
  evidence_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_mastery_student_idx ON topic_mastery_history (tenant_id, student_id, topic_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Academic planner
-- ---------------------------------------------------------------------------
CREATE TABLE school_calendars (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_date date NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('holiday','exam','event','working_day')),
  details    text
);

CREATE TABLE exam_schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id uuid REFERENCES student_profiles(id) ON DELETE CASCADE,  -- NULL = applies to whole tenant
  subject_id uuid NOT NULL REFERENCES subjects(id),
  title      text NOT NULL,
  exam_date  date NOT NULL,
  max_marks  int  NOT NULL CHECK (max_marks > 0),
  chapter_ids uuid[] NOT NULL DEFAULT '{}',   -- syllabus for this exam; empty = whole subject
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exam_schedules_student_idx ON exam_schedules (tenant_id, student_id, exam_date);

CREATE TABLE student_marks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  exam_schedule_id uuid REFERENCES exam_schedules(id) ON DELETE SET NULL,
  subject_id       uuid NOT NULL REFERENCES subjects(id),
  marks            numeric(6,2) NOT NULL CHECK (marks >= 0),
  max_marks        numeric(6,2) NOT NULL CHECK (max_marks > 0),
  source           text NOT NULL DEFAULT 'self_reported' CHECK (source IN ('self_reported','teacher','school_import')),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (marks <= max_marks)
);

CREATE TABLE student_disruptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  reason_category text NOT NULL CHECK (reason_category IN ('illness','travel','family','school_absence','holiday_travel','other')),
  available_minutes_per_day int NOT NULL DEFAULT 0 CHECK (available_minutes_per_day >= 0),
  missed_school   boolean NOT NULL DEFAULT false,   -- true = class lessons in this window were missed
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE TABLE study_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  lineage_id       uuid NOT NULL,       -- all versions of one plan share a lineage
  version          int  NOT NULL,
  exam_schedule_ids uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  inputs           jsonb NOT NULL,      -- snapshot of planner input for reproducibility
  summary          jsonb NOT NULL,      -- feasibility, gap, explanations, alternatives
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lineage_id, version)
);
CREATE UNIQUE INDEX study_plans_active_uq ON study_plans (lineage_id) WHERE status = 'active';
CREATE INDEX study_plans_student_idx ON study_plans (tenant_id, student_id);

CREATE TABLE study_plan_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  topic_id         uuid REFERENCES topics(id),
  task_type        text NOT NULL CHECK (task_type IN ('learn','practice','revision','mock_test')),
  title            text NOT NULL,
  task_date        date NOT NULL,
  duration_minutes int  NOT NULL CHECK (duration_minutes > 0),
  priority_score   numeric(6,4),
  sequence         int  NOT NULL DEFAULT 0,      -- order within the plan as produced by the engine
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','skipped','missed')),
  completed_at     timestamptz
);
CREATE INDEX study_plan_tasks_student_date_idx ON study_plan_tasks (student_id, task_date);
CREATE INDEX study_plan_tasks_plan_idx ON study_plan_tasks (plan_id);

CREATE TABLE plan_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  previous_plan_id uuid REFERENCES study_plans(id),
  trigger          text NOT NULL CHECK (trigger IN ('initial','disruption','missed_tasks','new_marks','assessment','manual')),
  reason           text NOT NULL,
  actor_id         uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Commerce and metering
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  price_paise    bigint NOT NULL CHECK (price_paise >= 0),
  billing_period text NOT NULL CHECK (billing_period IN ('none','monthly','annual')),
  audience       text NOT NULL CHECK (audience IN ('student','institution','white_label')),
  entitlements   jsonb NOT NULL,
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid REFERENCES users(id),
  plan_id              uuid NOT NULL REFERENCES plans(id),
  status               text NOT NULL CHECK (status IN ('pending','trialing','active','past_due','cancelled','expired')),
  seats                int NOT NULL DEFAULT 1 CHECK (seats > 0),
  period_start         timestamptz,
  period_end           timestamptz,
  trial_end            timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_tenant_idx ON subscriptions (tenant_id, status);

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id    uuid REFERENCES subscriptions(id),
  provider           text NOT NULL,
  provider_reference text NOT NULL,
  idempotency_key    text NOT NULL,
  amount_paise       bigint NOT NULL CHECK (amount_paise >= 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL CHECK (status IN ('created','captured','failed','refunded')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference),
  UNIQUE (tenant_id, idempotency_key)
);

-- Every inbound webhook is stored once; duplicates are ignored by the unique key.
CREATE TABLE payment_webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  event_type  text NOT NULL,          -- ai_question, ai_tokens, avatar_minutes, avatar_render, tts_seconds
  quantity    numeric(14,4) NOT NULL,
  cost_micros bigint NOT NULL DEFAULT 0,   -- provider cost estimate in micro-INR
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_tenant_idx ON usage_events (tenant_id, user_id, event_type, created_at);

-- ---------------------------------------------------------------------------
-- Reliability and audit
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  topic        text NOT NULL,          -- avatar.render, document.index, plan.recalculate
  payload      jsonb NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at) WHERE processed_at IS NULL;

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid,
  actor_id    uuid,
  action      text NOT NULL,
  resource_type text,
  resource_id text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- Tenant request handlers run as gurukul_app (policies apply). Trusted system
-- code (migrations, payment webhooks, workers) runs as the owning role, which
-- is deliberately not FORCEd so it can act across tenants; it must still
-- carry and re-check tenant context explicitly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  -- Strictly tenant-owned tables.
  FOREACH t IN ARRAY ARRAY[
    'student_profiles','parent_student_links','lesson_progress','syllabus_coverage',
    'tutor_sessions','tutor_messages','avatar_jobs','assessment_attempts','student_answers',
    'topic_mastery_history','school_calendars','exam_schedules','student_marks',
    'student_disruptions','study_plans','study_plan_tasks','plan_adjustments',
    'subscriptions','payments','usage_events','tenant_invitations','tenant_domains'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;

  -- Shared content: platform rows (tenant_id NULL) are readable by all; tenants write only their own.
  FOREACH t IN ARRAY ARRAY['lessons','content_assets','document_chunks','assessments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_or_platform ON %I USING (tenant_id IS NULL OR tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- Tables without tenant_id (or global reference data) the app role can still read/write.
GRANT USAGE ON SCHEMA public TO gurukul_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gurukul_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gurukul_app;
