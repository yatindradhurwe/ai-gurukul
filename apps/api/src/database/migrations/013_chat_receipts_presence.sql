-- Real-time chat: delivery receipts per member (✓✓ grey) alongside last_read_at
-- (✓✓ blue), and when each user was last seen online.

ALTER TABLE conversation_members ADD COLUMN last_delivered_at timestamptz NOT NULL DEFAULT 'epoch';
UPDATE conversation_members SET last_delivered_at = last_read_at;

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
