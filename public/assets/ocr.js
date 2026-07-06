// 截图识别：本地运行 PaddleOCR（ppu-paddle-ocr，PP-OCRv6 + onnxruntime-web），
// 全部在浏览器端完成，图片不上传到识别服务器。识别出文字后按规则解析加油信息。

// 必须用 /web 子入口：默认入口依赖 onnxruntime-node（仅 Node），浏览器端要用 onnxruntime-web
const OCR_CDN = 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr@6/web/+esm';
const OCR_MODEL_RAW_BASE = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/';
const OCR_MODEL_PROXY_BASE = '/ocr-model/';

let _service = null;
let _loading = null;
let _fetchPatched = false;

function modelProxyUrl(path) {
  const base = location.protocol === 'file:' ? 'https://car.weyun.top' : location.origin;
  return `${base}${OCR_MODEL_PROXY_BASE}${path}`;
}

function rewriteFetchInput(input, url) {
  if (input instanceof Request) return new Request(url, input);
  return url;
}

function patchOcrModelFetch() {
  if (_fetchPatched || typeof fetch !== 'function') return;
  const originalFetch = fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input?.url;
    if (url && url.startsWith(OCR_MODEL_RAW_BASE)) {
      const modelPath = url.slice(OCR_MODEL_RAW_BASE.length);
      return originalFetch(rewriteFetchInput(input, modelProxyUrl(modelPath)), init);
    }
    return originalFetch(input, init);
  };
  _fetchPatched = true;
}

function friendlyOcrError(error) {
  const message = error?.message ? String(error.message) : String(error || '');
  if (/raw\.githubusercontent|ocr-model|ppocrv6_dict|Failed to fetch|Load failed/i.test(message)) {
    return new Error('识别模型加载失败，请检查网络后重试');
  }
  return error;
}

// 懒加载并初始化 OCR（模型加载完成后走浏览器缓存）
function loadOcr(onStatus) {
  if (_service) return Promise.resolve(_service);
  if (_loading) return _loading;
  _loading = (async () => {
    patchOcrModelFetch();
    onStatus && onStatus('识别模型加载中，请稍候…');
    const mod = await import(/* @vite-ignore */ OCR_CDN);
    const PaddleOcrService = mod.PaddleOcrService || mod.default?.PaddleOcrService;
    if (!PaddleOcrService) throw new Error('OCR 模块加载失败');
    const service = new PaddleOcrService();
    await service.initialize();
    _service = service;
    return service;
  })();
  _loading.catch(() => { _loading = null; }); // 失败允许重试
  return _loading;
}

// File -> 缩放后的 canvas（最长边 maxSide，加速识别）
async function fileToCanvas(file, maxSide = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return cv;
}

// 识别一张图片，返回 { text, fields }
export async function recognizeImage(file, onStatus) {
  try {
    const service = await loadOcr(onStatus);
    const canvas = await fileToCanvas(file);
    onStatus && onStatus('正在识别…');
    const result = await service.recognize(canvas, { strategy: 'per-line', noCache: true });
    const text = extractText(result);
    return { text, fields: parseFuelText(text) };
  } catch (error) {
    throw friendlyOcrError(error);
  }
}

// 兼容不同返回结构，抽出纯文本
function extractText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result)) return result.map(extractText).join('\n');
  if (Array.isArray(result.lines)) return result.lines.map((l) => l.text ?? extractText(l)).join('\n');
  if (Array.isArray(result.results)) return result.results.map((l) => l.text ?? extractText(l)).join('\n');
  return '';
}

const pad = (n) => String(n).padStart(2, '0');
const num = (s) => { const v = parseFloat(String(s).replace(/[^\d.]/g, '')); return isFinite(v) ? v : null; };

// 从识别文字中解析加油信息。针对中石化「记录详情」等常见版式，缺失字段返回 undefined。
export function parseFuelText(text) {
  const T = (text || '').replace(/：/g, ':').replace(/[，、]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = {};

  // 日期 + 可选时间：兼容「2026-07-04 18:44:56」及 OCR 粘连的「2026-07-0418:44:56」
  let m = T.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[\sT]*(\d{1,2}):(\d{2}))?/);
  if (m) {
    out.refuel_date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    if (m[4] != null) out.refuel_time = `${pad(m[4])}:${m[5]}`;
  }

  // 油价(元/升) × 加油量(升)：如「7.61元/L x 26.29L」
  m = T.match(/([\d.]+)\s*元?\s*\/\s*[Ll升]\s*[x×*]\s*([\d.]+)\s*[Ll升]/);
  if (m) {
    out.unit_price = num(m[1]);
    out.volume = num(m[2]);
  } else {
    const p = T.match(/([\d.]+)\s*元?\s*\/\s*[Ll升]/);
    if (p) out.unit_price = num(p[1]);
    const v = T.match(/(?:数量|加油量|升数|升数量)[^\d]*([\d.]+)/) || T.match(/([\d.]+)\s*[Ll升](?!\s*\/)/);
    if (v) out.volume = num(v[1]);
  }

  // 应付/实付金额
  const payable = T.match(/应付(?:金额)?\s*:?[^\d]*?([\d.]+)/);
  const paid = T.match(/实付(?:金额)?\s*:?[^\d]*?([\d.]+)/);
  if (payable) out.machine_amount = num(payable[1]);
  if (paid) out.paid_amount = num(paid[1]);
  if (out.machine_amount == null && out.unit_price != null && out.volume != null) {
    out.machine_amount = Math.round(out.unit_price * out.volume * 100) / 100;
  }
  if (out.paid_amount == null && out.machine_amount != null) out.paid_amount = out.machine_amount;

  // 油号：92#/95#/98# 或「95号车用汽油」；柴油归 0#柴油
  if (/柴油/.test(T)) {
    out.fuel_type = '0#柴油';
  } else {
    const f = T.match(/(9[258])\s*[#号]/) || T.match(/(9[258])\s*号?\s*车?用?汽油/) || T.match(/汽油\D{0,4}(9[258])/);
    if (f) out.fuel_type = f[1] + '#';
  }

  // 加油站名（同一 token 内以「加油站」结尾）
  const st = T.match(/([一-龥A-Za-z0-9（）()·]{2,30}?加油站)/);
  if (st) out.station = st[1];

  return out;
}
