-- Chat: reply to a message, and attach a photo, a file or a voice note.
-- A message may now have an empty body when it carries an attachment.

ALTER TABLE messages ADD COLUMN reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE message_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image','audio','file')),
  file_name   text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  int  NOT NULL CHECK (size_bytes > 0),
  duration_ms int  CHECK (duration_ms >= 0),            -- voice notes
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_attachments_message_idx ON message_attachments (message_id);

ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_attachments USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id());
ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON message_attachments TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
