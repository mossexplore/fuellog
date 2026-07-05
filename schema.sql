-- 用户表（预留多用户，首期仅一条记录）
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,          -- 格式: pbkdf2$iterations$salt_hex$hash_hex
    role           TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    enabled        INTEGER NOT NULL DEFAULT 1,     -- 是否允许登录 0/1
    totp_secret    TEXT,                   -- Base32 TOTP 密钥，未绑定为 NULL
    totp_enabled   INTEGER NOT NULL DEFAULT 0,  -- 是否已启用两步验证 0/1（普通用户可选，管理员必须）
    totp_last_step INTEGER,                -- 上次成功验证的时间步，用于防重放
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 应用设置（key-value），如 registration_open=0/1
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- 成功登录事件（供管理后台查看登录信息）
CREATE TABLE IF NOT EXISTS login_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    ip         TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, id);

-- 车辆表（预留多车，首期默认一辆）
CREATE TABLE IF NOT EXISTS vehicles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    name       TEXT NOT NULL DEFAULT '我的车',
    plate      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 加油记录表（核心表）
CREATE TABLE IF NOT EXISTS fuel_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id),
    refuel_date    TEXT NOT NULL,         -- YYYY-MM-DD
    refuel_time    TEXT NOT NULL,         -- HH:MM
    odometer       REAL NOT NULL,         -- 当前里程，公里
    unit_price     REAL NOT NULL,         -- 机器显示油价，元/升
    volume         REAL NOT NULL,         -- 加油量，升
    machine_amount REAL NOT NULL,         -- 机器显示金额，元
    paid_amount    REAL NOT NULL,         -- 实付金额，元
    is_full        INTEGER NOT NULL DEFAULT 1,  -- 是否加满跳枪 0/1
    fuel_type      TEXT DEFAULT '92#',
    station        TEXT,
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_records_vehicle_datetime
    ON fuel_records (vehicle_id, refuel_date, refuel_time);

-- 附件表（加油账单截图/文件，存于 R2）
CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id),
    record_id    INTEGER REFERENCES fuel_records(id),  -- 未关联记录时为 NULL（草稿/孤儿）
    r2_key       TEXT NOT NULL UNIQUE,   -- att/{vehicleId}/{uuid}
    filename     TEXT NOT NULL,          -- 原始文件名（仅展示）
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,       -- 字节
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments (record_id);
CREATE INDEX IF NOT EXISTS idx_attachments_vehicle ON attachments (vehicle_id);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 两步验证：密码通过后的一次性待验证令牌（含绑定阶段的候选密钥），5 分钟过期
CREATE TABLE IF NOT EXISTS auth_challenges (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    purpose    TEXT NOT NULL,             -- 'enroll' | 'totp'
    secret     TEXT,                      -- 绑定阶段的候选 Base32 密钥
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 两步验证备用恢复码（一次性），仅存哈希
CREATE TABLE IF NOT EXISTS backup_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    code_hash  TEXT NOT NULL,             -- 格式: sha256$salt_hex$hash_hex
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON backup_codes (user_id);

-- 图形验证码（登录前置），2 分钟过期、一次性
CREATE TABLE IF NOT EXISTS captchas (
    id         TEXT PRIMARY KEY,
    answer     TEXT NOT NULL,             -- 小写答案
    ip         TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_captchas_ip ON captchas (ip, created_at);

-- 登录失败限速表
CREATE TABLE IF NOT EXISTS login_attempts (
    ip           TEXT NOT NULL,
    attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts (ip, attempted_at);
