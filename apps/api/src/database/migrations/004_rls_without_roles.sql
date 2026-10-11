-- Enforce row-level security without needing a dedicated database role.
--
-- * FORCE ROW LEVEL SECURITY makes policies apply to the table owner too, so
--   an app that connects as the owner (the usual managed-hosting setup, where
--   CREATE ROLE is not allowed) is still isolated per tenant.
-- * Trusted system code (migrations' seed, auth, webhooks, workers) opts out
--   explicitly for one transaction with set_config('app.system', 'on', true).
-- * Superusers always bypass RLS in PostgreSQL; for them the API switches to
--   the gurukul_app role (created in 001 when permitted).

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.system', true), '') = 'on'
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'student_profiles','parent_student_links','lesson_progress','syllabus_coverage',
    'tutor_sessions','tutor_messages','avatar_jobs','assessment_attempts','student_answers',
    'topic_mastery_history','school_calendars','exam_schedules','student_marks',
    'student_disruptions','study_plans','study_plan_tasks','plan_adjustments',
    'subscriptions','payments','usage_events','tenant_invitations','tenant_domains',
    'classes','class_enrollments','live_sessions','live_session_events','live_questions','live_attendance'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['lessons','content_assets','document_chunks','assessments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_or_platform ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_or_platform ON %I USING (app_is_system() OR tenant_id IS NULL OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
