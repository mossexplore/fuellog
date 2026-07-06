ALTER TABLE attachments ADD COLUMN draft_id TEXT;
ALTER TABLE attachments ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_attachments_draft ON attachments (vehicle_id, draft_id);
