import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  verifyPassword, newSessionToken, SESSION_DAYS,
  generateTotpSecret, otpauthUri, verifyTotp,
  generateBackupCodes, hashBackupCode, verifyBackupCode,
} from './auth';
import { computeStats, type FuelRecord } from './stats';

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  R2: R2Bucket;
};

type Vars = {
  userId: number;
  username: string;
  vehicleId: number;
};

const COOKIE = 'fuellog_session';
const CHALLENGE_COOKIE = 'fuellog_2fa';
const CHALLENGE_MINUTES = 5;
const ISSUER = '加油记';
// 未登录即可访问的认证接口（登录两步流程）
const PUBLIC_PATHS = new Set(['/api/login', '/api/login/verify', '/api/2fa/enroll']);
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- 认证中间件（登录相关接口除外） ----------

app.use('/api/*', async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  const token = getCookie(c, COOKIE);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare(
    `SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first<{ user_id: number; username: string }>();
  if (!row) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', row.user_id);
  c.set('username', row.username);
  // 首期单车：取该用户第一辆车，没有则自动创建
  let v = await c.env.DB.prepare('SELECT id FROM vehicles WHERE user_id = ? ORDER BY id LIMIT 1')
    .bind(row.user_id).first<{ id: number }>();
  if (!v) {
    const res = await c.env.DB.prepare('INSERT INTO vehicles (user_id) VALUES (?)').bind(row.user_id).run();
    v = { id: res.meta.last_row_id as number };
  }
  c.set('vehicleId', v.id);
  return next();
});

// ---------- 认证 ----------

// 限速：同一 IP 60 秒内最多 5 次失败
async function rateLimited(c: any, ip: string): Promise<boolean> {
  const db = c.env.DB as D1Database;
  const { cnt } = (await db.prepare(
    `SELECT COUNT(*) AS cnt FROM login_attempts WHERE ip = ? AND attempted_at > datetime('now', '-60 seconds')`
  ).bind(ip).first<{ cnt: number }>())!;
  return cnt >= 5;
}
async function logAttempt(c: any, ip: string): Promise<void> {
  await c.env.DB.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, datetime('now'))`).bind(ip).run();
}

// 通过全部验证后发放正式会话，并清理临时状态
async function issueSession(c: any, userId: number): Promise<void> {
  const token = newSessionToken();
  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  ).bind(token, userId).run();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
    c.env.DB.prepare(`DELETE FROM login_attempts WHERE attempted_at <= datetime('now', '-1 hour')`),
    c.env.DB.prepare(`DELETE FROM auth_challenges WHERE expires_at <= datetime('now')`),
  ]);
  c.executionCtx.waitUntil(cleanupOrphanAttachments(c.env));
  deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}

interface UserAuthRow {
  id: number;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
}

// 第一步：账号 + 密码。通过后进入绑定或验证码步骤（不直接发会话）
app.post('/api/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (await rateLimited(c, ip)) return c.json({ error: '尝试过于频繁，请 1 分钟后再试' }, 429);

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({} as any));
  const { username, password } = body;
  const fail = async () => { await logAttempt(c, ip); return c.json({ error: '用户名或密码错误' }, 401); };
  if (!username || !password) return fail();

  const user = await c.env.DB.prepare(
    'SELECT id, password_hash, totp_secret, totp_enabled, totp_last_step FROM users WHERE username = ?'
  ).bind(username).first<UserAuthRow>();
  if (!user || !(await verifyPassword(password, user.password_hash))) return fail();

  // 密码通过：发放 5 分钟一次性待验证令牌
  const purpose = user.totp_enabled ? 'totp' : 'enroll';
  const secret = purpose === 'enroll' ? generateTotpSecret() : null;
  const chToken = newSessionToken();
  await c.env.DB.prepare(`DELETE FROM auth_challenges WHERE user_id = ? OR expires_at <= datetime('now')`).bind(user.id).run();
  await c.env.DB.prepare(
    `INSERT INTO auth_challenges (token, user_id, purpose, secret, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${CHALLENGE_MINUTES} minutes'))`
  ).bind(chToken, user.id, purpose, secret).run();
  setCookie(c, CHALLENGE_COOKIE, chToken, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: CHALLENGE_MINUTES * 60,
  });

  if (purpose === 'enroll') {
    return c.json({ step: 'enroll', secret, otpauth_uri: otpauthUri(ISSUER, username, secret!) });
  }
  return c.json({ step: 'totp' });
});

// 载入并校验待验证令牌
async function loadChallenge(c: any, purpose: string) {
  const token = getCookie(c, CHALLENGE_COOKIE);
  if (!token) return null;
  const db = c.env.DB as D1Database;
  return db.prepare(
    `SELECT token, user_id, purpose, secret FROM auth_challenges
     WHERE token = ? AND purpose = ? AND expires_at > datetime('now')`
  ).bind(token, purpose).first<{ token: string; user_id: number; purpose: string; secret: string | null }>();
}

// 绑定阶段：校验绑定码 → 启用 2FA → 生成恢复码（仅此一次返回）→ 发会话
app.post('/api/2fa/enroll', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (await rateLimited(c, ip)) return c.json({ error: '尝试过于频繁，请 1 分钟后再试' }, 429);
  const ch = await loadChallenge(c, 'enroll');
  if (!ch || !ch.secret) return c.json({ error: '会话已过期，请重新登录' }, 401);

  const { code } = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  const step = await verifyTotp(ch.secret, code ?? '');
  if (step < 0) { await logAttempt(c, ip); return c.json({ error: '验证码不正确，请确认认证器时间同步后重试' }, 401); }

  const codes = generateBackupCodes(10);
  const hashes = await Promise.all(codes.map(hashBackupCode));
  await c.env.DB.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?')
    .bind(ch.secret, step, ch.user_id).run();
  await c.env.DB.prepare('DELETE FROM backup_codes WHERE user_id = ?').bind(ch.user_id).run();
  await c.env.DB.batch(
    hashes.map((h) => c.env.DB.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)').bind(ch.user_id, h))
  );
  await c.env.DB.prepare('DELETE FROM auth_challenges WHERE token = ?').bind(ch.token).run();
  await issueSession(c, ch.user_id);
  return c.json({ ok: true, backup_codes: codes });
});

// 第二步：校验 6 位验证码或备用恢复码 → 发会话
app.post('/api/login/verify', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (await rateLimited(c, ip)) return c.json({ error: '尝试过于频繁，请 1 分钟后再试' }, 429);
  const ch = await loadChallenge(c, 'totp');
  if (!ch) return c.json({ error: '会话已过期，请重新登录' }, 401);

  const { code } = await c.req.json<{ code?: string }>().catch(() => ({} as any));
  const user = await c.env.DB.prepare('SELECT totp_secret, totp_last_step FROM users WHERE id = ?')
    .bind(ch.user_id).first<{ totp_secret: string; totp_last_step: number | null }>();
  if (!user?.totp_secret) return c.json({ error: '会话已过期，请重新登录' }, 401);

  // 先试 TOTP
  const step = await verifyTotp(user.totp_secret, code ?? '');
  if (step >= 0) {
    if (user.totp_last_step != null && step <= user.totp_last_step) {
      return c.json({ error: '该验证码已使用，请等待下一个 30 秒验证码' }, 401);
    }
    await c.env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').bind(step, ch.user_id).run();
    await c.env.DB.prepare('DELETE FROM auth_challenges WHERE token = ?').bind(ch.token).run();
    await issueSession(c, ch.user_id);
    return c.json({ ok: true });
  }

  // 再试备用恢复码
  const { results: bks } = await c.env.DB.prepare(
    'SELECT id, code_hash FROM backup_codes WHERE user_id = ? AND used = 0'
  ).bind(ch.user_id).all<{ id: number; code_hash: string }>();
  for (const bk of bks) {
    if (await verifyBackupCode(code ?? '', bk.code_hash)) {
      await c.env.DB.prepare('UPDATE backup_codes SET used = 1 WHERE id = ?').bind(bk.id).run();
      await c.env.DB.prepare('DELETE FROM auth_challenges WHERE token = ?').bind(ch.token).run();
      await issueSession(c, ch.user_id);
      return c.json({ ok: true, backup_used: true, backup_remaining: bks.length - 1 });
    }
  }

  await logAttempt(c, ip);
  return c.json({ error: '验证码或恢复码不正确' }, 401);
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', (c) => c.json({ username: c.get('username') }));

// 清理超 24h 未关联记录的孤儿附件
async function cleanupOrphanAttachments(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM attachments
     WHERE record_id IS NULL AND created_at <= datetime('now', '-1 day') LIMIT 100`
  ).all<{ id: number; r2_key: string }>();
  if (!results.length) return;
  await env.R2.delete(results.map((r) => r.r2_key));
  const ph = results.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${ph})`).bind(...results.map((r) => r.id)).run();
}

// ---------- 加油记录 ----------

interface RecordInput {
  refuel_date: string;
  refuel_time: string;
  odometer: number;
  unit_price: number;
  volume: number;
  machine_amount: number;
  paid_amount: number;
  is_full: boolean | number;
  fuel_type?: string;
  station?: string;
  note?: string;
  attachment_ids?: number[];
}

interface ImportInput {
  records?: RecordInput[];
  replace?: boolean;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 单文件 10MB
const MAX_ATTACHMENTS = 9;              // 单条记录最多 9 个附件

function validateRecord(b: Partial<RecordInput>): string | null {
  if (!b.refuel_date || !/^\d{4}-\d{2}-\d{2}$/.test(b.refuel_date)) return '加油日期格式应为 YYYY-MM-DD';
  if (!b.refuel_time || !/^\d{2}:\d{2}$/.test(b.refuel_time)) return '加油时间格式应为 HH:MM';
  for (const [key, name] of [
    ['odometer', '当前里程'], ['unit_price', '油价'], ['volume', '加油量'], ['machine_amount', '机器显示金额'],
  ] as const) {
    const v = b[key];
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return `${name}必须为正数`;
  }
  if (typeof b.paid_amount !== 'number' || !isFinite(b.paid_amount) || b.paid_amount < 0) return '实付金额不能为负';
  return null;
}

function recordDateTime(b: RecordInput): string {
  return `${b.refuel_date} ${b.refuel_time}`;
}

function sortRecords(records: RecordInput[]): RecordInput[] {
  return [...records].sort((a, b) => recordDateTime(a).localeCompare(recordDateTime(b)));
}

function validateImportRecords(records: RecordInput[]): string | null {
  if (!Array.isArray(records) || !records.length) return '没有可导入的记录';
  if (records.length > 1000) return '单次最多导入 1000 条记录';
  const sorted = sortRecords(records);
  for (let i = 0; i < sorted.length; i++) {
    const err = validateRecord(sorted[i]);
    if (err) return `第 ${i + 1} 条记录无效：${err}`;
    if (i > 0 && sorted[i].odometer < sorted[i - 1].odometer) {
      return `第 ${i + 1} 条记录里程不能小于上一条记录`;
    }
  }
  return null;
}

async function deleteVehicleData(env: Env, vehicleId: number): Promise<{ records: number; attachments: number }> {
  const { results: atts } = await env.DB.prepare(
    'SELECT r2_key FROM attachments WHERE vehicle_id = ?'
  ).bind(vehicleId).all<{ r2_key: string }>();
  if (atts.length) {
    await env.R2.delete(atts.map((a) => a.r2_key));
  }
  await env.DB.prepare('DELETE FROM attachments WHERE vehicle_id = ?').bind(vehicleId).run();
  const delRecords = await env.DB.prepare('DELETE FROM fuel_records WHERE vehicle_id = ?').bind(vehicleId).run();
  return { records: delRecords.meta.changes ?? 0, attachments: atts.length };
}

function insertRecordStmt(db: D1Database, vehicleId: number, b: RecordInput) {
  return db.prepare(
    `INSERT INTO fuel_records
       (vehicle_id, refuel_date, refuel_time, odometer, unit_price, volume,
        machine_amount, paid_amount, is_full, fuel_type, station, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    vehicleId, b.refuel_date, b.refuel_time, b.odometer, b.unit_price, b.volume,
    b.machine_amount, b.paid_amount, b.is_full ? 1 : 0,
    b.fuel_type ?? '92#', b.station ?? null, b.note ?? null
  );
}

// 里程单调性：按时间排序后，本条里程必须 ≥ 前一条且 ≤ 后一条
async function checkOdometer(db: D1Database, vehicleId: number, b: RecordInput, excludeId?: number): Promise<string | null> {
  const dt = recordDateTime(b);
  const notSelf = excludeId ? 'AND id != ?' : '';
  const bindPrev: unknown[] = excludeId ? [vehicleId, dt, excludeId] : [vehicleId, dt];
  const prev = await db.prepare(
    `SELECT odometer, refuel_date FROM fuel_records
     WHERE vehicle_id = ? AND (refuel_date || ' ' || refuel_time) <= ? ${notSelf}
     ORDER BY refuel_date DESC, refuel_time DESC, id DESC LIMIT 1`
  ).bind(...bindPrev).first<{ odometer: number; refuel_date: string }>();
  if (prev && b.odometer < prev.odometer)
    return `里程不能小于上一条记录（${prev.refuel_date}，${prev.odometer} 公里）`;
  const next = await db.prepare(
    `SELECT odometer, refuel_date FROM fuel_records
     WHERE vehicle_id = ? AND (refuel_date || ' ' || refuel_time) > ? ${notSelf}
     ORDER BY refuel_date ASC, refuel_time ASC, id ASC LIMIT 1`
  ).bind(...bindPrev).first<{ odometer: number; refuel_date: string }>();
  if (next && b.odometer > next.odometer)
    return `里程不能大于下一条记录（${next.refuel_date}，${next.odometer} 公里）`;
  return null;
}

app.get('/api/records', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(c.req.query('size') ?? '20', 10) || 20));
  const vehicleId = c.get('vehicleId');
  const { total } = (await c.env.DB.prepare('SELECT COUNT(*) AS total FROM fuel_records WHERE vehicle_id = ?')
    .bind(vehicleId).first<{ total: number }>())!;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM fuel_records WHERE vehicle_id = ?
     ORDER BY refuel_date DESC, refuel_time DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(vehicleId, size, (page - 1) * size).all<FuelRecord & Record<string, unknown>>();

  // 取全表按时间排序序列，计算：与前一条的里程差 distance_delta，
  // 以及分段油耗/每公里油费（仅落在“段末加满”记录上，算法同仪表盘 computeStats）
  const { results: allRows } = await c.env.DB.prepare(
    `SELECT id, odometer, volume, paid_amount, is_full FROM fuel_records WHERE vehicle_id = ?
     ORDER BY refuel_date ASC, refuel_time ASC, id ASC`
  ).bind(vehicleId).all<{ id: number; odometer: number; volume: number; paid_amount: number; is_full: number }>();

  const prevOdo = new Map<number, number | null>();
  allRows.forEach((r, i) => prevOdo.set(r.id, i > 0 ? r.odometer - allRows[i - 1].odometer : null));

  // 分段：相邻两次加满之间，段末（后一次加满）记录上挂该段油耗与每公里油费
  const seg = new Map<number, { consumption: number; cost_per_km: number }>();
  const fullIdx = allRows.map((r, i) => (r.is_full ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k + 1 < fullIdx.length; k++) {
    const a = fullIdx[k], b = fullIdx[k + 1];
    const dist = allRows[b].odometer - allRows[a].odometer;
    if (dist <= 0) continue; // 同点重复加油，跳过
    let fuel = 0, paid = 0;
    for (let i = a + 1; i <= b; i++) { fuel += allRows[i].volume; paid += allRows[i].paid_amount; }
    seg.set(allRows[b].id, {
      consumption: Math.round((fuel / dist) * 100 * 100) / 100,
      cost_per_km: Math.round((paid / dist) * 100) / 100,
    });
  }

  const items = results.map((r) => {
    const d = prevOdo.get(r.id as number);
    const s = seg.get(r.id as number);
    return {
      ...r,
      distance_delta: d != null ? Math.round(d * 10) / 10 : null,
      segment_consumption: s ? s.consumption : null,
      segment_cost_per_km: s ? s.cost_per_km : null,
    };
  });
  return c.json({ total, page, size, items });
});

app.post('/api/records', async (c) => {
  const b = await c.req.json<RecordInput>().catch(() => null);
  if (!b) return c.json({ error: '请求体格式错误' }, 400);
  const err = validateRecord(b);
  if (err) return c.json({ error: err }, 422);
  const vehicleId = c.get('vehicleId');
  const odoErr = await checkOdometer(c.env.DB, vehicleId, b);
  if (odoErr) return c.json({ error: odoErr }, 422);

  const res = await insertRecordStmt(c.env.DB, vehicleId, b).run();
  const recordId = res.meta.last_row_id as number;
  await linkAttachments(c.env.DB, vehicleId, recordId, b.attachment_ids);
  return c.json({ ok: true, id: recordId }, 201);
});

app.post('/api/records/import', async (c) => {
  const body = await c.req.json<ImportInput>().catch(() => null);
  if (!body || !Array.isArray(body.records)) return c.json({ error: '请求体格式错误' }, 400);
  const err = validateImportRecords(body.records);
  if (err) return c.json({ error: err }, 422);

  const vehicleId = c.get('vehicleId');
  const records = sortRecords(body.records);
  const existing = await c.env.DB.prepare(
    `SELECT odometer, refuel_date, refuel_time FROM fuel_records WHERE vehicle_id = ?
     ORDER BY refuel_date ASC, refuel_time ASC, id ASC`
  ).bind(vehicleId).all<{ odometer: number; refuel_date: string; refuel_time: string }>();
  const combined = [
    ...(body.replace ? [] : existing.results.map((r) => ({ dt: `${r.refuel_date} ${r.refuel_time}`, odometer: r.odometer }))),
    ...records.map((r) => ({ dt: recordDateTime(r), odometer: r.odometer })),
  ].sort((a, b) => a.dt.localeCompare(b.dt));
  for (let i = 1; i < combined.length; i++) {
    if (combined[i].odometer < combined[i - 1].odometer) {
      return c.json({ error: '导入后里程序列不单调，请先清空或检查历史数据' }, 422);
    }
  }

  const stmts = records.map((r) => insertRecordStmt(c.env.DB, vehicleId, r));
  if (body.replace) {
    await deleteVehicleData(c.env, vehicleId);
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, imported: records.length });
});

app.delete('/api/records', async (c) => {
  const result = await deleteVehicleData(c.env, c.get('vehicleId'));
  return c.json({ ok: true, deleted: result.records, attachments: result.attachments });
});

// 将草稿附件（record_id IS NULL）绑定到指定记录；同时把该记录已有但本次未提交的附件解绑为孤儿（供后续清理）
async function linkAttachments(db: D1Database, vehicleId: number, recordId: number, ids?: number[]): Promise<void> {
  const wanted = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)).slice(0, MAX_ATTACHMENTS) : [];
  if (wanted.length) {
    const ph = wanted.map(() => '?').join(',');
    await db.prepare(
      `UPDATE attachments SET record_id = ? WHERE vehicle_id = ? AND record_id IS NULL AND id IN (${ph})`
    ).bind(recordId, vehicleId, ...wanted).run();
  }
  // 解绑：属于本记录但不在本次列表中的附件（用户在编辑时删除了）
  const keepPh = wanted.length ? `AND id NOT IN (${wanted.map(() => '?').join(',')})` : '';
  await db.prepare(
    `UPDATE attachments SET record_id = NULL WHERE record_id = ? AND vehicle_id = ? ${keepPh}`
  ).bind(recordId, vehicleId, ...wanted).run();
}

app.get('/api/records/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM fuel_records WHERE id = ? AND vehicle_id = ?')
    .bind(c.req.param('id'), c.get('vehicleId')).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  const { results: attachments } = await c.env.DB.prepare(
    `SELECT id, filename, content_type, size FROM attachments
     WHERE record_id = ? AND vehicle_id = ? ORDER BY id ASC`
  ).bind(row.id, c.get('vehicleId')).all();
  return c.json({ ...row, attachments });
});

app.put('/api/records/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const vehicleId = c.get('vehicleId');
  const exists = await c.env.DB.prepare('SELECT id FROM fuel_records WHERE id = ? AND vehicle_id = ?')
    .bind(id, vehicleId).first();
  if (!exists) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<RecordInput>().catch(() => null);
  if (!b) return c.json({ error: '请求体格式错误' }, 400);
  const err = validateRecord(b);
  if (err) return c.json({ error: err }, 422);
  const odoErr = await checkOdometer(c.env.DB, vehicleId, b, id);
  if (odoErr) return c.json({ error: odoErr }, 422);

  await c.env.DB.prepare(
    `UPDATE fuel_records SET
       refuel_date = ?, refuel_time = ?, odometer = ?, unit_price = ?, volume = ?,
       machine_amount = ?, paid_amount = ?, is_full = ?, fuel_type = ?, station = ?, note = ?,
       updated_at = datetime('now')
     WHERE id = ? AND vehicle_id = ?`
  ).bind(
    b.refuel_date, b.refuel_time, b.odometer, b.unit_price, b.volume,
    b.machine_amount, b.paid_amount, b.is_full ? 1 : 0,
    b.fuel_type ?? '92#', b.station ?? null, b.note ?? null, id, vehicleId
  ).run();
  await linkAttachments(c.env.DB, vehicleId, id, b.attachment_ids);
  return c.json({ ok: true });
});

app.delete('/api/records/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const vehicleId = c.get('vehicleId');
  // 先删该记录的附件（R2 对象 + 表行）
  const { results: atts } = await c.env.DB.prepare(
    'SELECT id, r2_key FROM attachments WHERE record_id = ? AND vehicle_id = ?'
  ).bind(id, vehicleId).all<{ id: number; r2_key: string }>();
  if (atts.length) {
    await c.env.R2.delete(atts.map((a) => a.r2_key));
    await c.env.DB.prepare('DELETE FROM attachments WHERE record_id = ? AND vehicle_id = ?')
      .bind(id, vehicleId).run();
  }
  const res = await c.env.DB.prepare('DELETE FROM fuel_records WHERE id = ? AND vehicle_id = ?')
    .bind(id, vehicleId).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ---------- 附件（R2） ----------

// 上传单个文件（FormData 字段名 file）。即选即传，返回附件 id，保存记录时再关联。
app.post('/api/attachments', async (c) => {
  const vehicleId = c.get('vehicleId');
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
  if (file.size === 0) return c.json({ error: '文件为空' }, 400);
  if (file.size > MAX_FILE_SIZE) return c.json({ error: '单个文件不能超过 10MB' }, 413);

  // 草稿附件数量护栏
  const { cnt } = (await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM attachments WHERE vehicle_id = ? AND record_id IS NULL'
  ).bind(vehicleId).first<{ cnt: number }>())!;
  if (cnt >= MAX_ATTACHMENTS * 2) return c.json({ error: '待关联附件过多，请先保存记录' }, 429);

  const key = `att/${vehicleId}/${crypto.randomUUID()}`;
  const contentType = file.type || 'application/octet-stream';
  await c.env.R2.put(key, file.stream(), { httpMetadata: { contentType } });
  const res = await c.env.DB.prepare(
    `INSERT INTO attachments (vehicle_id, record_id, r2_key, filename, content_type, size)
     VALUES (?, NULL, ?, ?, ?, ?)`
  ).bind(vehicleId, key, file.name || '未命名', contentType, file.size).run();
  return c.json({
    id: res.meta.last_row_id, filename: file.name || '未命名', content_type: contentType, size: file.size,
  }, 201);
});

// 读取附件内容（鉴权后从 R2 取流）
app.get('/api/attachments/:id', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT r2_key, filename, content_type FROM attachments WHERE id = ? AND vehicle_id = ?'
  ).bind(c.req.param('id'), c.get('vehicleId')).first<{ r2_key: string; filename: string; content_type: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const obj = await c.env.R2.get(row.r2_key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  const isImage = row.content_type.startsWith('image/');
  // 图片内联预览，其它类型作为附件下载，避免浏览器直接执行未知类型
  const disp = isImage ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`;
  return c.body(obj.body, 200, {
    'Content-Type': row.content_type,
    'Content-Disposition': disp,
    'Cache-Control': 'private, max-age=31536000',
  });
});

// 删除单个附件（R2 对象 + 表行）
app.delete('/api/attachments/:id', async (c) => {
  const vehicleId = c.get('vehicleId');
  const row = await c.env.DB.prepare(
    'SELECT r2_key FROM attachments WHERE id = ? AND vehicle_id = ?'
  ).bind(c.req.param('id'), vehicleId).first<{ r2_key: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  await c.env.R2.delete(row.r2_key);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ? AND vehicle_id = ?')
    .bind(c.req.param('id'), vehicleId).run();
  return c.json({ ok: true });
});

// ---------- 统计 ----------

app.get('/api/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM fuel_records WHERE vehicle_id = ?
     ORDER BY refuel_date ASC, refuel_time ASC, id ASC`
  ).bind(c.get('vehicleId')).all<FuelRecord>();
  return c.json(computeStats(results));
});

// ---------- CSV 导出 ----------

app.get('/api/export.csv', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM fuel_records WHERE vehicle_id = ?
     ORDER BY refuel_date ASC, refuel_time ASC, id ASC`
  ).bind(c.get('vehicleId')).all<Record<string, unknown>>();
  const headers = ['加油日期', '加油时间', '当前里程(公里)', '油价(元/升)', '加油量(升)',
    '机器显示金额(元)', '实付金额(元)', '是否加满', '油品', '加油站', '备注'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = results.map((r) => [
    r.refuel_date, r.refuel_time, r.odometer, r.unit_price, r.volume,
    r.machine_amount, r.paid_amount, r.is_full ? '是' : '否', r.fuel_type, r.station, r.note,
  ].map(esc).join(','));
  const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="fuellog.csv"',
  });
});

// ---------- 静态资源兜底 ----------

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
