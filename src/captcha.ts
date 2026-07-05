// 图形验证码：把随机字符渲染成扭曲的矢量 <path>（而非可读 <text>）。
// 关键：每个字形的每个坐标点都经过「仿射（缩放/旋转/斜切）+ 非线性正弦扭曲 + 抖动」，
// 因此每次生成的路径几何都不同，脚本既无法从源码读出答案，也无法用固定字形表做路径指纹匹配，
// 只能靠 OCR。字形轮廓来自 src/glyphs.ts（构建期由 opentype.js 从 DejaVu Sans Bold 提取）。
import { ALPHABET, GLYPHS, type Cmd } from './glyphs';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const r1 = (n: number) => Math.round(n * 10) / 10;

const DARK = ['#1f2937', '#3730a3', '#7f1d1d', '#065f46', '#374151', '#4c1d95', '#831843', '#134e4a'];
const MID = ['#94a3b8', '#a5b4fc', '#fca5a5', '#6ee7b7', '#cbd5e1'];
const BG = ['#f8fafc', '#f1f5f9', '#fef2f2', '#f0fdf4', '#faf5ff', '#fefce8'];

export interface Captcha { answer: string; svg: string; }

// 生成一张验证码。返回大写答案与 SVG 字符串。
export function newCaptcha(len = 4): Captcha {
  const W = 150, H = 50;
  const chars = Array.from({ length: len }, () => pick(ALPHABET.split('')));
  const answer = chars.join('');

  // 全局非线性扭曲参数（整张图共享，保证扭曲连贯）
  const ampX = rnd(1.2, 2.6), ampY = rnd(1.2, 2.6);
  const fX = rnd(0.09, 0.16), fY = rnd(0.09, 0.16);
  const phX = rnd(0, 6.28), phY = rnd(0, 6.28);

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${pick(BG)}"/>`);

  // 干扰曲线
  for (let k = 0; k < 3; k++) {
    const pts = Array.from({ length: 4 }, (_, i) =>
      `${r1((i / 3) * W + rnd(-6, 6))},${r1(rnd(4, H - 4))}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${pick(MID)}" stroke-width="1.4" opacity="0.6"/>`);
  }
  // 噪点
  for (let k = 0; k < 24; k++) {
    parts.push(`<circle cx="${r1(rnd(0, W))}" cy="${r1(rnd(0, H))}" r="${r1(rnd(0.6, 1.5))}" fill="${pick(MID)}" opacity="0.5"/>`);
  }

  const cellW = (W - 16) / len;
  chars.forEach((ch, i) => {
    const g = GLYPHS[ch];
    const targetH = rnd(26, 34);
    const s = targetH / g.h;
    const cx = 8 + cellW * (i + 0.5) + rnd(-4, 4);
    const cy = H / 2 + rnd(-4, 4);
    const rot = rnd(-0.45, 0.45);         // 弧度，约 ±26°
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const skew = rnd(-0.22, 0.22);

    // 单点变换：字形局部坐标 → 仿射 → 全局扭曲 → 画布坐标
    const tf = (lx: number, ly: number): [number, number] => {
      let px = lx - g.w / 2, py = ly - g.h / 2;
      px += skew * py;                     // 斜切
      px *= s; py *= s;                    // 缩放
      const rx = px * cos - py * sin, ry = px * sin + py * cos; // 旋转
      let X = rx + cx, Y = ry + cy;        // 平移到格位
      X += ampX * Math.sin(fY * Y + phX) + rnd(-0.5, 0.5);     // 非线性扭曲 + 抖动
      Y += ampY * Math.sin(fX * X + phY) + rnd(-0.5, 0.5);
      return [r1(X), r1(Y)];
    };

    let d = '';
    for (const cmd of g.c as Cmd[]) {
      const t = cmd[0];
      if (t === 'M' || t === 'L') { const [x, y] = tf(cmd[1] as number, cmd[2] as number); d += `${t}${x} ${y}`; }
      else if (t === 'Q') { const [x1, y1] = tf(cmd[1] as number, cmd[2] as number); const [x, y] = tf(cmd[3] as number, cmd[4] as number); d += `Q${x1} ${y1} ${x} ${y}`; }
      else if (t === 'C') { const [x1, y1] = tf(cmd[1] as number, cmd[2] as number); const [x2, y2] = tf(cmd[3] as number, cmd[4] as number); const [x, y] = tf(cmd[5] as number, cmd[6] as number); d += `C${x1} ${y1} ${x2} ${y2} ${x} ${y}`; }
      else { d += 'Z'; }
    }
    parts.push(`<path d="${d}" fill="${pick(DARK)}"/>`);
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="图形验证码">${parts.join('')}</svg>`;
  return { answer, svg };
}
