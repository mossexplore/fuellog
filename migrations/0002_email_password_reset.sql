ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    purpose    TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    email      TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user_purpose
    ON email_tokens (user_id, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_email_tokens_ip
    ON email_tokens (ip, purpose, created_at);
