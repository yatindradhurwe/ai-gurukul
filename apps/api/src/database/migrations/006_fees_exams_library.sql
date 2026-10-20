-- School fees, examinations and the library. Money is integer paise.
-- Every table is tenant-owned and isolated with the same FORCEd RLS policy as 004.

-- ---------------------------------------------------------------------------
-- Fees: a structure (e.g. "Term 1 tuition") is billed to students as invoices;
-- payments against an invoice produce numbered receipts.
-- ---------------------------------------------------------------------------
CREATE TABLE fee_structures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  category     text NOT NULL DEFAULT 'tuition' CHECK (category IN ('tuition','admission','transport','exam','library','activity','hostel','other')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  due_date     date NOT NULL,
  class_id     uuid REFERENCES classes(id) ON DELETE SET NULL,   -- NULL = every student
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fee_structures_tenant_idx ON fee_structures (tenant_id, due_date);

CREATE TABLE fee_invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  structure_id   uuid REFERENCES fee_structures(id) ON DELETE CASCADE,
  title          text NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  discount_note  text,
  due_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (structure_id, student_id),
  CHECK (discount_paise <= amount_paise)
);
CREATE INDEX fee_invoices_student_idx ON fee_invoices (tenant_id, student_id, due_date);

CREATE TABLE fee_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES fee_invoices(id) ON DELETE CASCADE,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  method       text NOT NULL CHECK (method IN ('cash','upi','card','cheque','bank_transfer','online')),
  reference    text,
  receipt_no   text NOT NULL,
  paid_at      timestamptz NOT NULL DEFAULT now(),
  received_by  uuid NOT NULL REFERENCES users(id),
  UNIQUE (tenant_id, receipt_no)
);
CREATE INDEX fee_payments_invoice_idx ON fee_payments (invoice_id);
CREATE INDEX fee_payments_paid_idx ON fee_payments (tenant_id, paid_at);

-- ---------------------------------------------------------------------------
-- Exams: an exam (e.g. "Half-yearly") has papers per class and subject. Each
-- paper owns a gradebook column, so marks flow into report cards.
-- ---------------------------------------------------------------------------
CREATE TABLE exams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  term        text NOT NULL DEFAULT 'Term 1',
  start_date  date,
  end_date    date,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','completed')),
  instructions text NOT NULL DEFAULT '',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX exams_tenant_idx ON exams (tenant_id, start_date);

CREATE TABLE exam_papers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exam_id          uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject          text NOT NULL,
  date             date NOT NULL,
  start_time       time NOT NULL DEFAULT '09:00',
  duration_minutes int  NOT NULL DEFAULT 180 CHECK (duration_minutes BETWEEN 15 AND 600),
  max_marks        numeric NOT NULL CHECK (max_marks > 0),
  pass_marks       numeric CHECK (pass_marks >= 0),
  room             text,
  grade_item_id    uuid REFERENCES grade_items(id) ON DELETE SET NULL,
  UNIQUE (exam_id, class_id, subject)
);
CREATE INDEX exam_papers_class_idx ON exam_papers (tenant_id, class_id, date);

-- ---------------------------------------------------------------------------
-- Library: a catalogue of titles with copy counts, and loans to any member.
-- ---------------------------------------------------------------------------
CREATE TABLE library_books (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        text NOT NULL,
  author       text NOT NULL DEFAULT '',
  isbn         text,
  category     text NOT NULL DEFAULT 'General',
  publisher    text,
  shelf        text,
  total_copies int  NOT NULL DEFAULT 1 CHECK (total_copies >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX library_books_tenant_idx ON library_books (tenant_id, title);

CREATE TABLE library_loans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  due_date    date NOT NULL,
  returned_at timestamptz,
  fine_paise  bigint NOT NULL DEFAULT 0 CHECK (fine_paise >= 0),
  fine_paid   boolean NOT NULL DEFAULT false,
  issued_by   uuid NOT NULL REFERENCES users(id),
  returned_to uuid REFERENCES users(id)
);
CREATE INDEX library_loans_active_idx ON library_loans (tenant_id, book_id) WHERE returned_at IS NULL;
CREATE INDEX library_loans_user_idx ON library_loans (tenant_id, user_id, issued_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fee_structures','fee_invoices','fee_payments','exams','exam_papers','library_books','library_loans'
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON fee_structures, fee_invoices, fee_payments, exams, exam_papers, library_books, library_loans TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
