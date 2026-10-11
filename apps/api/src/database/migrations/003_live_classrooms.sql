-- Live AI classrooms: classes (batches), enrolments, live sessions taught by
-- the AI avatar, a durable event log that drives real-time updates, the doubt
-- queue, and attendance.

CREATE TABLE classes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  subject_id            uuid REFERENCES subjects(id),
  curriculum_version_id uuid REFERENCES curriculum_versions(id),
  teacher_id            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classes_tenant_idx ON classes (tenant_id);

CREATE TABLE class_enrollments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, student_id)
);

CREATE TABLE live_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id           uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id          uuid NOT NULL REFERENCES lessons(id),
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  -- teaching: avatar presents segments; paused: teacher paused; qa: lesson finished, doubts only
  mode               text NOT NULL DEFAULT 'teaching' CHECK (mode IN ('teaching','paused','qa')),
  scheduled_at       timestamptz,
  started_at         timestamptz,
  ended_at           timestamptz,
  avatar_id          text NOT NULL DEFAULT 'guru-default',
  language           text NOT NULL DEFAULT 'en',
  script             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{title, text}] built from approved lesson content
  current_segment    int  NOT NULL DEFAULT 0,
  segment_started_at timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_sessions_class_idx ON live_sessions (tenant_id, class_id, status);

-- Append-only event log. Clients replay from their last seen id (SSE or polling).
CREATE TABLE live_session_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  type         text NOT NULL,
  audience     text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','user')),
  recipient_id uuid REFERENCES users(id),           -- for audience = 'user'
  actor_id     uuid REFERENCES users(id),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (audience <> 'user' OR recipient_id IS NOT NULL)
);
CREATE INDEX live_session_events_session_idx ON live_session_events (session_id, id);

CREATE TABLE live_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  content      text NOT NULL,
  input_mode   text NOT NULL DEFAULT 'text' CHECK (input_mode IN ('text','voice')),
  status       text NOT NULL CHECK (status IN ('answered','escalated','resolved','private')),
  answer       text,
  source_refs  jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_flags text[] NOT NULL DEFAULT '{}',
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_questions_session_idx ON live_questions (session_id, created_at);

CREATE TABLE live_attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classes','class_enrollments','live_sessions','live_session_events','live_questions','live_attendance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON classes, class_enrollments, live_sessions, live_session_events, live_questions, live_attendance TO gurukul_app;
    GRANT USAGE, SELECT ON SEQUENCE live_session_events_id_seq TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
