-- School directory: documents on student and staff profiles (certificates,
-- transfer certificates, ID proofs, medical records), and co-curricular
-- activities — sports, PT, clubs, arts — with a teacher in charge and members.
-- Directory settings (who may view or upload documents) live in tenants.settings.
-- Every table is tenant-owned and isolated with the same FORCEd RLS policy as 004.

CREATE TABLE profile_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_type  text NOT NULL CHECK (owner_type IN ('student','staff')),
  student_id  uuid REFERENCES student_profiles(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT 'other',
  file_name   text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  int  NOT NULL CHECK (size_bytes > 0),
  content     bytea NOT NULL,
  visibility  text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('admin','staff')),  -- admin = principal and admins only
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'student') = (student_id IS NOT NULL)),
  CHECK ((owner_type = 'staff') = (staff_id IS NOT NULL))
);
CREATE INDEX profile_documents_student_idx ON profile_documents (tenant_id, student_id);
CREATE INDEX profile_documents_staff_idx ON profile_documents (tenant_id, staff_id);

CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT 'sport' CHECK (category IN ('sport','pt','club','arts','music','other')),
  teacher_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  schedule    text NOT NULL DEFAULT '',
  venue       text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX activities_name_idx ON activities (tenant_id, lower(name));
CREATE INDEX activities_teacher_idx ON activities (tenant_id, teacher_id);

CREATE TABLE activity_members (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',   -- member, captain, vice-captain ...
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, student_id)
);
CREATE INDEX activity_members_student_idx ON activity_members (tenant_id, student_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profile_documents','activities','activity_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON profile_documents, activities, activity_members TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
