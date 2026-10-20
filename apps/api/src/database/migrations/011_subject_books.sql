-- Prescribed books per grade and subject (textbooks, workbooks, reference books),
-- shared by every section of that grade. Board NULL = whatever board the class follows.
-- Optionally linked to a library title so availability can be shown.

CREATE TABLE subject_books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  board           text,
  grade           text NOT NULL,                  -- matches classes.grade, e.g. "Class 8"
  subject         text NOT NULL,                  -- matches class_subjects.subject
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'textbook' CHECK (kind IN ('textbook','workbook','reference','lab_manual','other')),
  author          text NOT NULL DEFAULT '',
  publisher       text NOT NULL DEFAULT '',
  isbn            text,
  note            text NOT NULL DEFAULT '',
  library_book_id uuid REFERENCES library_books(id) ON DELETE SET NULL,
  sequence        int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subject_books_key_idx ON subject_books (tenant_id, lower(grade), lower(subject));

ALTER TABLE subject_books ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subject_books USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id());
ALTER TABLE subject_books FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON subject_books TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
