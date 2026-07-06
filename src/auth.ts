// 密码哈希与会话管理
// 哈希格式: pbkdf2$<iterations>$<salt_hex>$<hash_hex>
// Cloudflare Workers 的 WebCrypto 限制 PBKDF2 迭代上限为 100,000

const PBKDF2_ITERATIONS = 100_000;
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt.buffer)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const computed = await pbkdf2(password, fromHex(parts[2]), iterations);
  // 恒定时间比较
  const a = enc.encode(computed);
  const b = enc.encode(parts[3]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function newSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input) as BufferSource));
}

// 恒定时间字符串比较
function timingEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- TOTP（RFC 6238，HMAC-SHA1 / 30s / 6 位） ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Uint8Array {
  const s = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; value &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg as BufferSource));
}

async function totpAt(secretBase32: string, counter: number): Promise<string> {
  const key = base32Decode(secretBase32);
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
  const mac = await hmacSha1(key, buf);
  const off = mac[19] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return (bin % 1_000_000).toString().padStart(6, '0');
}

// 校验 6 位验证码，容许前后 window 个 30 秒窗口。返回匹配的时间步（用于防重放），失败返回 -1
export async function verifyTotp(secretBase32: string, code: string, window = 1): Promise<number> {
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (timingEqual(await totpAt(secretBase32, counter + w), clean)) return counter + w;
  }
  return -1;
}

// ---------- 备用恢复码 ----------

export function generateBackupCodes(n = 10): string[] {
  const alpha = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去除易混字符 i l o 0 1
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let s = '';
    for (const b of bytes) s += alpha[b % alpha.length];
    codes.push(s.slice(0, 4) + '-' + s.slice(4, 8));
  }
  return codes;
}

function normalizeBackupCode(code: string): string {
  return String(code).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function hashBackupCode(code: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const data = new Uint8Array([...salt, ...enc.encode(normalizeBackupCode(code))]);
  const dig = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return `sha256$${toHex(salt.buffer)}$${toHex(dig)}`;
}

export async function verifyBackupCode(code: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'sha256') return false;
  const data = new Uint8Array([...fromHex(parts[1]), ...enc.encode(normalizeBackupCode(code))]);
  const dig = toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return timingEqual(dig, parts[2]);
}
