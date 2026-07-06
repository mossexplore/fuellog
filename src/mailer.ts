import { connect } from 'cloudflare:sockets';

export interface MailEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
}

interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(input: string): string {
  const bytes = encoder.encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function encodeHeader(value: string): string {
  return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

function formatAddress(email: string, name?: string): string {
  return name ? `${encodeHeader(name)} <${email}>` : email;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function dotStuff(value: string): string {
  return normalizeNewlines(value).replace(/^\./gm, '..');
}

function buildMime(from: string, fromName: string | undefined, msg: MailMessage): string {
  const boundary = `fuellog-${crypto.randomUUID()}`;
  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
  ];
  if (!msg.html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.text,
    ].join('\r\n');
  }
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

class SmtpClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private pending = '';

  constructor(private socket: any) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  reset(socket: any): void {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.pending = '';
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch (_) { /* ignore */ }
    try { await this.socket.close(); } catch (_) { /* ignore */ }
  }

  async write(line: string): Promise<void> {
    await this.writer.write(encoder.encode(line));
  }

  async command(line: string, expected: number | number[]): Promise<string> {
    await this.write(`${line}\r\n`);
    return this.expect(expected);
  }

  async expect(expected: number | number[]): Promise<string> {
    const accepted = Array.isArray(expected) ? expected : [expected];
    const lines: string[] = [];
    let code = 0;
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      code = parseInt(line.slice(0, 3), 10);
      if (line[3] !== '-') break;
    }
    if (!accepted.includes(code)) throw new Error(`SMTP ${code}: ${lines.join('\n')}`);
    return lines.join('\n');
  }

  private async readLine(): Promise<string> {
    while (!this.pending.includes('\n')) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error('SMTP connection closed');
      this.pending += decoder.decode(chunk.value, { stream: true });
    }
    const idx = this.pending.indexOf('\n');
    const line = this.pending.slice(0, idx).replace(/\r$/, '');
    this.pending = this.pending.slice(idx + 1);
    return line;
  }
}

export async function sendMail(env: MailEnv, msg: MailMessage): Promise<void> {
  const host = env.SMTP_HOST || 'smtp.qq.com';
  const port = Number(env.SMTP_PORT || 465);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.MAIL_FROM || user;
  if (!user || !pass || !from) throw new Error('邮件服务未配置');

  const socket = connect(
    { hostname: host, port },
    { secureTransport: port === 465 ? 'on' : 'starttls', allowHalfOpen: false }
  );
  const client = new SmtpClient(socket);
  try {
    await client.expect(220);
    await client.command(`EHLO ${host}`, 250);
    if (port !== 465) {
      await client.command('STARTTLS', 220);
      client.reset(socket.startTls());
      await client.command(`EHLO ${host}`, 250);
    }
    await client.command('AUTH LOGIN', 334);
    await client.command(b64(user), 334);
    await client.command(b64(pass), 235);
    await client.command(`MAIL FROM:<${from}>`, 250);
    await client.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await client.command('DATA', 354);
    await client.write(`${dotStuff(buildMime(from, env.MAIL_FROM_NAME, msg))}\r\n.\r\n`);
    await client.expect(250);
    await client.command('QUIT', 221).catch(() => '');
  } finally {
    await client.close();
  }
}
