-- Messaging and parent-teacher meetings, leave and the school calendar,
-- admissions (with student details for ID cards) and staff HR / payroll.
-- Every table is tenant-owned and isolated with the same FORCEd RLS policy as 004.

-- ---------------------------------------------------------------------------
-- Messaging: one-to-one conversations, optionally about a particular child.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject         text NOT NULL DEFAULT '',
  student_id      uuid REFERENCES student_profiles(id) ON DELETE SET NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_tenant_idx ON conversations (tenant_id, last_message_at DESC);

CREATE TABLE conversation_members (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    timestamptz NOT NULL DEFAULT 'epoch',
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (tenant_id, user_id);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- Parent-teacher meeting slots published by a teacher and booked by a parent.
CREATE TABLE ptm_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL,
  duration_minutes int  NOT NULL DEFAULT 15 CHECK (duration_minutes BETWEEN 5 AND 120),
  location         text NOT NULL DEFAULT 'Classroom',
  booked_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  student_id       uuid REFERENCES student_profiles(id) ON DELETE SET NULL,
  note             text,
  booked_at        timestamptz,
  UNIQUE (teacher_id, starts_at)
);
CREATE INDEX ptm_slots_teacher_idx ON ptm_slots (tenant_id, teacher_id, starts_at);

-- ---------------------------------------------------------------------------
-- Leave (students, staff, hostel out-passes) and the school calendar.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('student','staff','outpass')),
  requester_id uuid NOT NULL REFERENCES users(id),
  student_id   uuid REFERENCES student_profiles(id) ON DELETE CASCADE,   -- student leave and out-passes
  staff_id     uuid REFERENCES users(id) ON DELETE CASCADE,              -- staff leave
  leave_type   text NOT NULL DEFAULT 'casual' CHECK (leave_type IN ('casual','sick','earned','unpaid','other')),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  out_time     time,
  return_time  time,
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK ((kind = 'staff') = (staff_id IS NOT NULL)),
  CHECK ((kind <> 'staff') = (student_id IS NOT NULL))
);
CREATE INDEX leave_requests_tenant_idx ON leave_requests (tenant_id, status, start_date);

CREATE TABLE school_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'event' CHECK (kind IN ('holiday','exam','event','meeting','sports','cultural')),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  audience    text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','students','parents')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX school_events_tenant_idx ON school_events (tenant_id, start_date);

-- ---------------------------------------------------------------------------
-- Admissions, and the student details printed on ID cards and certificates.
-- ---------------------------------------------------------------------------
ALTER TABLE student_profiles
  ADD COLUMN admission_no   text,
  ADD COLUMN date_of_birth  date,
  ADD COLUMN blood_group    text,
  ADD COLUMN guardian_name  text,
  ADD COLUMN guardian_phone text,
  ADD COLUMN address        text,
  ADD COLUMN admitted_on    date;
CREATE UNIQUE INDEX student_profiles_admission_no_idx ON student_profiles (tenant_id, admission_no) WHERE admission_no IS NOT NULL;

CREATE TABLE admission_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_name    text NOT NULL,
  date_of_birth   date,
  grade_applying  text NOT NULL,
  parent_name     text NOT NULL,
  parent_email    text NOT NULL,
  parent_phone    text NOT NULL,
  address         text,
  previous_school text,
  message         text,
  status          text NOT NULL DEFAULT 'enquiry' CHECK (status IN ('enquiry','applied','interview','offered','admitted','rejected')),
  notes           text,
  source          text NOT NULL DEFAULT 'office' CHECK (source IN ('website','office')),
  student_id      uuid REFERENCES student_profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admission_applications_tenant_idx ON admission_applications (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Staff HR and payroll. Money is integer paise.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_profiles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_code      text NOT NULL,
  designation        text NOT NULL DEFAULT '',
  department         text NOT NULL DEFAULT '',
  date_joined        date,
  phone              text,
  blood_group        text,
  bank_account_last4 text,
  basic_paise        bigint NOT NULL DEFAULT 0 CHECK (basic_paise >= 0),
  hra_paise          bigint NOT NULL DEFAULT 0 CHECK (hra_paise >= 0),
  da_paise           bigint NOT NULL DEFAULT 0 CHECK (da_paise >= 0),
  other_paise        bigint NOT NULL DEFAULT 0 CHECK (other_paise >= 0),
  pf_percent         numeric NOT NULL DEFAULT 12 CHECK (pf_percent BETWEEN 0 AND 100),
  professional_tax_paise bigint NOT NULL DEFAULT 20000 CHECK (professional_tax_paise >= 0),
  tds_paise          bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','left')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, employee_code)
);

CREATE TABLE staff_attendance (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      date NOT NULL,
  status    text NOT NULL CHECK (status IN ('present','absent','half_day','leave')),
  marked_by uuid NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, date)
);

CREATE TABLE payslips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month         text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  working_days  int  NOT NULL,
  unpaid_days   numeric NOT NULL DEFAULT 0,
  earnings      jsonb NOT NULL,      -- {"Basic": paise, ...} after proration
  deductions    jsonb NOT NULL,
  gross_paise   bigint NOT NULL,
  deductions_paise bigint NOT NULL,
  net_paise     bigint NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','paid')),
  generated_by  uuid NOT NULL REFERENCES users(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  UNIQUE (tenant_id, user_id, month)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations','conversation_members','messages','ptm_slots','leave_requests','school_events',
    'admission_applications','staff_profiles','staff_attendance','payslips'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON conversations, conversation_members, messages, ptm_slots, leave_requests, school_events,
      admission_applications, staff_profiles, staff_attendance, payslips TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
