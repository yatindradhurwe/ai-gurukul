-- Promotion from final exam results. A final (annual) exam decides promotion:
-- pass → next class, a few failed subjects → supplementary re-exam, more → stays.
-- Rules (auto-promote on, supplementary subject limit, minimum attendance / %)
-- live in tenants.settings.promotion.

ALTER TABLE exams
  ADD COLUMN is_final         boolean NOT NULL DEFAULT false,
  ADD COLUMN promotion_run_at timestamptz;

-- Which exam decided a year record (so a promotion run never handles a student twice).
ALTER TABLE student_year_records ADD COLUMN exam_id uuid REFERENCES exams(id) ON DELETE SET NULL;

CREATE TABLE supplementary_exams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  exam_id         uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id        uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  paper_id        uuid NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  subject         text NOT NULL,
  max_marks       numeric NOT NULL,
  pass_marks      numeric,
  original_marks  numeric,
  exam_date       date,
  marks           numeric CHECK (marks >= 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','absent')),
  target_class_id uuid REFERENCES classes(id) ON DELETE SET NULL,   -- where the student goes if they clear it
  resolved        boolean NOT NULL DEFAULT false,                   -- promoted or detained after all re-exams
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, paper_id)
);
CREATE INDEX supplementary_exams_open_idx ON supplementary_exams (tenant_id, resolved, exam_id);

ALTER TABLE supplementary_exams ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplementary_exams USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id());
ALTER TABLE supplementary_exams FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON supplementary_exams TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
