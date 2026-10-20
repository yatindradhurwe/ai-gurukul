-- Core LMS records: announcements, assignments and submissions, daily class
-- attendance, the weekly timetable, and a gradebook that feeds report cards.
-- Every table is tenant-owned and isolated with the same FORCEd RLS policy as 004.

CREATE TABLE announcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id   uuid REFERENCES classes(id) ON DELETE CASCADE,   -- NULL = whole organization
  title      text NOT NULL,
  body       text NOT NULL,
  audience   text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff','students','parents')),
  pinned     boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_tenant_idx ON announcements (tenant_id, created_at DESC);

CREATE TABLE announcement_reads (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  due_at      timestamptz,
  max_points  numeric NOT NULL DEFAULT 100 CHECK (max_points > 0),
  status      text NOT NULL DEFAULT 'published' CHECK (status IN ('published','closed')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_class_idx ON assignments (tenant_id, class_id, due_at);

CREATE TABLE assignment_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  content       text NOT NULL,
  link_url      text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  points        numeric CHECK (points >= 0),
  feedback      text,
  graded_by     uuid REFERENCES users(id),
  graded_at     timestamptz,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE attendance_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  date       date NOT NULL,
  status     text NOT NULL CHECK (status IN ('present','absent','late','excused')),
  note       text,
  marked_by  uuid NOT NULL REFERENCES users(id),
  marked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, student_id, date)
);
CREATE INDEX attendance_student_idx ON attendance_records (tenant_id, student_id, date);

CREATE TABLE timetable_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1 = Monday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  subject     text NOT NULL,
  room        text,
  teacher_id  uuid REFERENCES users(id),
  CHECK (end_time > start_time)
);
CREATE INDEX timetable_class_idx ON timetable_slots (tenant_id, class_id, day_of_week, start_time);

-- Gradebook: a column (test, project, term exam) per class, and a score per student.
CREATE TABLE grade_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title      text NOT NULL,
  term       text NOT NULL DEFAULT 'Term 1',
  category   text NOT NULL DEFAULT 'test' CHECK (category IN ('test','exam','project','homework','practical')),
  max_marks  numeric NOT NULL CHECK (max_marks > 0),
  date       date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grade_items_class_idx ON grade_items (tenant_id, class_id, term);

CREATE TABLE grade_scores (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id    uuid NOT NULL REFERENCES grade_items(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  marks      numeric CHECK (marks >= 0),
  remarks    text,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, student_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'announcements','announcement_reads','assignments','assignment_submissions',
    'attendance_records','timetable_slots','grade_items','grade_scores'
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON announcements, announcement_reads, assignments, assignment_submissions,
      attendance_records, timetable_slots, grade_items, grade_scores TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
