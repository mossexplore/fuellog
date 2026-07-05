#!/usr/bin/env node
// 一次性构建脚本：用 opentype.js 从 DejaVu Sans Bold 提取验证码字符的矢量轮廓，
// 归一化后写入 src/glyphs.ts。运行时 Worker 只用这张路径表，不打包字体/opentype.js。
// 用法: node scripts/gen-glyphs.mjs
import opentype from 'opentype.js';
import { writeFileSync } from 'node:fs';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';
// 去除易混字符：I O 0 1
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIZE = 72;

const buf = await (await fetch(FONT_URL)).arrayBuffer();
const font = opentype.parse(buf);

const r1 = (n) => +n.toFixed(1);
const glyphs = {};
for (const ch of ALPHABET) {
  const p = font.getPath(ch, 0, 0, SIZE);
  const bb = p.getBoundingBox();
  const dx = -bb.x1, dy = -bb.y1;
  // 归一化到 (0,0) 起点，输出结构化命令（供运行时逐点非线性扭曲）
  const cmds = p.commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return [c.type, r1(c.x + dx), r1(c.y + dy)];
    if (c.type === 'Q') return [c.type, r1(c.x1 + dx), r1(c.y1 + dy), r1(c.x + dx), r1(c.y + dy)];
    if (c.type === 'C') return [c.type, r1(c.x1 + dx), r1(c.y1 + dy), r1(c.x2 + dx), r1(c.y2 + dy), r1(c.x + dx), r1(c.y + dy)];
    return ['Z'];
  });
  glyphs[ch] = { c: cmds, w: r1(bb.x2 - bb.x1), h: r1(bb.y2 - bb.y1) };
}

const ts = `// 自动生成，请勿手改。由 scripts/gen-glyphs.mjs 从 DejaVu Sans Bold（开源字体）提取字形轮廓。
// c: 路径命令数组（M/L/Q/C/Z），坐标已归一化到字形左上角原点，运行时会逐点扭曲。
export type Cmd = [string, ...number[]];
export interface Glyph { c: Cmd[]; w: number; h: number; }
export const ALPHABET = ${JSON.stringify(ALPHABET)};
export const GLYPHS: Record<string, Glyph> = ${JSON.stringify(glyphs)};
`;
writeFileSync(new URL('../src/glyphs.ts', import.meta.url), ts);
console.log(`已生成 src/glyphs.ts，共 ${ALPHABET.length} 个字形。`);
