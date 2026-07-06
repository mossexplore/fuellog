// 公共工具：API 封装、401 跳登录、格式化
async function api(path, options = {}) {
  // FormData 由浏览器自动设置 multipart 边界，不能手动指定 Content-Type
  const headers = options.body instanceof FormData
    ? (options.headers || {})
    : { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function fmt(n, digits = 2) {
  if (n == null) return '—';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function logout() {
  sessionStorage.removeItem('fuellog_role');
  await api('/api/logout', { method: 'POST' });
  location.href = '/login.html';
}

// 登录态页面：管理员显示「管理」导航（元素 id=navAdmin，默认隐藏）。
// 角色缓存在 sessionStorage：进页面立即按缓存显示，避免顶栏在异步请求后跳动，再异步校准。
async function revealAdminNav() {
  const a = document.getElementById('navAdmin');
  if (a && sessionStorage.getItem('fuellog_role') === 'admin') a.style.display = '';
  try {
    const me = await api('/api/me');
    sessionStorage.setItem('fuellog_role', me.role || '');
    if (a) a.style.display = me.role === 'admin' ? '' : 'none';
  } catch (_) { /* 未登录等，忽略 */ }
}
if (!/\/(login|register)(\.html)?$/.test(location.pathname)) {
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', () => { revealAdminNav(); setupAppShellNav(); })
    : (revealAdminNav(), setupAppShellNav());
}

function pageKey(pathname) {
  if (pathname === '/' || pathname.endsWith('/index.html')) return '/';
  return pathname;
}

function updateTopbarActive(pathname) {
  const current = pageKey(pathname);
  document.querySelectorAll('.topbar nav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href === '#' || href.startsWith('/api/')) return;
    const linkPath = pageKey(new URL(href, location.href).pathname);
    a.classList.toggle('active', linkPath === current);
  });
}

function ensureScript(src, attrs = {}) {
  const abs = new URL(src, location.href).href;
  if (document.querySelector(`script[src="${abs}"],script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = abs;
    for (const [k, v] of Object.entries(attrs)) if (v != null) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.body.appendChild(s);
  });
}

async function runPageScripts(doc) {
  for (const source of doc.body.querySelectorAll('script')) {
    const src = source.getAttribute('src');
    if (src && src.endsWith('/assets/app.js')) continue;
    if (src) {
      await ensureScript(src, source.type ? { type: source.type } : {});
      continue;
    }
    const code = source.textContent || '';
    if (!code.trim()) continue;
    if (source.type === 'module') {
      const s = document.createElement('script');
      s.type = 'module';
      s.textContent = code;
      document.body.appendChild(s);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      Function(code)();
    }
  }
}

function replacePageBody(doc) {
  document.querySelectorAll('#lightbox').forEach((x) => x.remove());
  [...document.body.children].forEach((el) => {
    if (el.classList.contains('topbar')) return;
    if (el.tagName === 'SCRIPT' && el.getAttribute('src')?.endsWith('/assets/app.js')) return;
    if (el.id === 'toast') return;
    el.remove();
  });

  const appScript = [...document.body.querySelectorAll('script')]
    .find((s) => s.getAttribute('src')?.endsWith('/assets/app.js'));
  const nodes = [...doc.body.children].filter((el) => el.tagName !== 'SCRIPT' && !el.classList.contains('topbar'));
  for (const node of nodes) document.body.insertBefore(document.importNode(node, true), appScript || null);
}

async function navigateWithinShell(url, { push = true } = {}) {
  const target = new URL(url, location.href);
  document.body.classList.add('app-loading');
  try {
    const res = await fetch(target.href, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`请求失败 (${res.status})`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.querySelector('.topbar')) throw new Error('页面结构不完整');

    if (push) history.pushState({ shell: true }, '', target.href);
    document.title = doc.title;
    replacePageBody(doc);
    updateTopbarActive(target.pathname);
    await revealAdminNav();
    await runPageScripts(doc);
    window.scrollTo(0, 0);
  } catch (ex) {
    location.href = target.href;
  } finally {
    document.body.classList.remove('app-loading');
  }
}

function shouldHandleShellClick(e, a) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== '_self') return false;
  if (a.hasAttribute('download')) return false;
  const href = a.getAttribute('href') || '';
  if (!href || href === '#' || href.startsWith('/api/') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return false;
  if (url.pathname === location.pathname && url.search === location.search) return false;
  return /\.(html)?$/.test(url.pathname) || url.pathname === '/';
}

function setupAppShellNav() {
  if (window.__fuellogShellNav) return;
  window.__fuellogShellNav = true;
  history.replaceState({ shell: true }, '', location.href);
  updateTopbarActive(location.pathname);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.topbar a');
    if (!a || !shouldHandleShellClick(e, a)) return;
    e.preventDefault();
    navigateWithinShell(a.href);
  });
  window.addEventListener('popstate', () => navigateWithinShell(location.href, { push: false }));
}

// 顶部醒目提示（自动消失）。type: 'success' | 'error'
function toast(message, type = 'success') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = (type === 'success' ? '✓ ' : '⚠ ') + message;
  box.className = 'toast ' + type;
  // 重启进入动画
  void box.offsetWidth;
  box.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.remove('show'), 2200);
}
