-- Fuller staff records for the principal, and each student's year-by-year
-- record. Promotion moves a student to their next class; before it does, the
-- year's report (class, attendance, marks, exams, homework, activities) is
-- frozen in student_year_records with the result, so earlier years stay
-- viewable however classes are reused afterwards.

ALTER TABLE staff_profiles
  ADD COLUMN date_of_birth           date,
  ADD COLUMN gender                  text,
  ADD COLUMN address                 text,
  ADD COLUMN qualification           text,
  ADD COLUMN specialization          text,
  ADD COLUMN experience_years        numeric CHECK (experience_years BETWEEN 0 AND 60),
  ADD COLUMN previous_school         text,
  ADD COLUMN emergency_contact_name  text,
  ADD COLUMN emergency_contact_phone text;

CREATE TABLE student_year_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,
  year_name        text NOT NULL,                       -- kept even if the year is deleted
  class_id         uuid REFERENCES classes(id) ON DELETE SET NULL,
  class_name       text NOT NULL,
  grade            text,
  result           text NOT NULL CHECK (result IN ('promoted','detained','passed_out','left')),
  promoted_to_class_id   uuid REFERENCES classes(id) ON DELETE SET NULL,
  promoted_to_class_name text,
  remarks          text NOT NULL DEFAULT '',
  report           jsonb NOT NULL,                      -- frozen attendance, marks, exams, homework, activities
  decided_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX student_year_records_student_idx ON student_year_records (tenant_id, student_id, created_at);

ALTER TABLE student_year_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_year_records USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id());
ALTER TABLE student_year_records FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON student_year_records TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
