#!/usr/bin/env node
// 生成用户 INSERT 语句：node scripts/create-user.mjs <username> [password] [role]
// 密码缺省时随机生成。哈希格式与 src/auth.ts 一致。
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 100_000;
let [username, passwordArg, roleArg] = process.argv.slice(2);
if (!username) {
  console.error('用法: node scripts/create-user.mjs <username> [password] [admin|user]');
  process.exit(1);
}
if (!roleArg && ['admin', 'user'].includes(passwordArg ?? '')) {
  roleArg = passwordArg;
  passwordArg = undefined;
}
const role = roleArg ?? 'admin';
if (!['admin', 'user'].includes(role)) {
  console.error('角色必须是 admin 或 user');
  process.exit(1);
}
const generated = !passwordArg;
const password = passwordArg ?? randomBytes(9).toString('base64url');
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('hex');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${hash}`;

console.error(`用户: ${username}`);
console.error(`角色: ${role}`);
console.error(generated ? `随机密码: ${password}` : '使用命令行传入的密码');
console.error('请立即保存密码；SQL 输出中不会包含明文密码。');
console.log(`INSERT INTO users (username, password_hash, role, enabled) VALUES ('${username.replace(/'/g, "''")}', '${stored}', '${role}', 1);`);
