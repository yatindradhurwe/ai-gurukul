-- School academic structure and syllabus planning: academic years and terms,
-- class profiles (board / grade / section), class subjects with teachers,
-- school syllabi by board / grade / subject, and an auto-generated syllabus
-- coverage plan per class subject. Holidays live in school_events (008).
-- Every table is tenant-owned and isolated with the same FORCEd RLS policy as 004.

CREATE TABLE academic_years (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,                          -- e.g. "2026-27"
  start_date date NOT NULL,
  end_date   date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX academic_years_current_idx ON academic_years (tenant_id) WHERE is_current;

CREATE TABLE academic_terms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year_id    uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sequence   int  NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  exam_start date,
  exam_end   date,
  UNIQUE (year_id, sequence),
  CHECK (end_date >= start_date),
  CHECK (exam_start IS NULL OR (exam_start >= start_date AND exam_end IS NOT NULL AND exam_end >= exam_start AND exam_end <= end_date))
);

ALTER TABLE classes
  ADD COLUMN board            text,
  ADD COLUMN grade            text,
  ADD COLUMN section          text,
  ADD COLUMN academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL;

CREATE TABLE syllabi (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  board            text NOT NULL,
  grade            text NOT NULL,
  subject          text NOT NULL,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX syllabi_key_idx ON syllabi (tenant_id, lower(board), lower(grade), lower(subject), COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE syllabus_units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  syllabus_id   uuid NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
  title         text NOT NULL,
  sequence      int  NOT NULL,
  est_periods   int  NOT NULL DEFAULT 6 CHECK (est_periods BETWEEN 1 AND 200),
  term_sequence int  CHECK (term_sequence > 0),        -- NULL = let the planner decide
  topics        text NOT NULL DEFAULT '',
  UNIQUE (syllabus_id, sequence)
);

CREATE TABLE class_subjects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject          text NOT NULL,
  teacher_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  periods_per_week int  NOT NULL DEFAULT 6 CHECK (periods_per_week BETWEEN 1 AND 48),
  syllabus_id      uuid REFERENCES syllabi(id) ON DELETE SET NULL,
  plan_generated_at timestamptz,
  plan_warning     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX class_subjects_key_idx ON class_subjects (class_id, lower(subject));
CREATE INDEX class_subjects_teacher_idx ON class_subjects (tenant_id, teacher_id);

CREATE TABLE syllabus_plan_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_subject_id uuid NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  unit_id          uuid NOT NULL REFERENCES syllabus_units(id) ON DELETE CASCADE,
  term_sequence    int,
  planned_start    date,
  planned_end      date,
  planned_periods  numeric NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed')),
  completed_on     date,
  note             text,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_subject_id, unit_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['academic_years','academic_terms','syllabi','syllabus_units','class_subjects','syllabus_plan_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON academic_years, academic_terms, syllabi, syllabus_units, class_subjects, syllabus_plan_items TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
