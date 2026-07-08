// 公共工具：API 封装、401 跳登录、格式化
// 顶栏无刷新切页时，旧页面未完成的异步任务可能在 DOM 被替换后继续写入旧节点。
// 这类空节点写入属于过期页面任务，直接吞掉，避免导航时报错打断体验。
function isStaleDomWriteError(message) {
  return /Cannot (set|read) properties of null/.test(String(message || ''))
    && /(textContent|innerHTML|style|disabled|value|className|focus)/.test(String(message || ''));
}
window.addEventListener('error', (event) => {
  if (isStaleDomWriteError(event.message)) event.preventDefault();
}, true);
window.addEventListener('unhandledrejection', (event) => {
  if (isStaleDomWriteError(event.reason?.message || event.reason)) event.preventDefault();
});

let currentPageController = null;
let currentPageCleanups = [];
function addPageCleanup(fn) {
  if (typeof fn === 'function') currentPageCleanups.push(fn);
}
function startPageLifecycle() {
  currentPageController = new AbortController();
  window.__fuellogPageSignal = currentPageController.signal;
  window.fuellogOnPageDispose = addPageCleanup;
}
function disposePageLifecycle() {
  if (currentPageController && !currentPageController.signal.aborted) currentPageController.abort();
  const cleanups = currentPageCleanups;
  currentPageCleanups = [];
  for (let i = cleanups.length - 1; i >= 0; i -= 1) {
    try { cleanups[i](); } catch (_) { /* 页面清理失败不影响导航 */ }
  }
}
let persistentListenerSetup = false;
function withPersistentListeners(fn) {
  persistentListenerSetup = true;
  try { return fn(); }
  finally { persistentListenerSetup = false; }
}
function installScopedPageListeners() {
  if (window.__fuellogScopedPageListeners) return;
  window.__fuellogScopedPageListeners = true;
  const nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    const signal = window.__fuellogPageSignal;
    if (!persistentListenerSetup && signal && !signal.aborted && listener && !options?.signal) {
      if (options == null) options = { signal };
      else if (typeof options === 'boolean') options = { capture: options, signal };
      else options = { ...options, signal };
    }
    return nativeAdd.call(this, type, listener, options);
  };
}
startPageLifecycle();
installScopedPageListeners();

async function api(path, options = {}) {
  // FormData 由浏览器自动设置 multipart 边界，不能手动指定 Content-Type
  const headers = options.body instanceof FormData
    ? (options.headers || {})
    : { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login';
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
  location.href = '/login';
}

// 登录态页面：管理员显示「管理」导航（元素 id=navAdmin，默认隐藏）。
// 角色缓存在 sessionStorage：进页面立即按缓存显示，避免顶栏在异步请求后跳动，再异步校准。
let meRequest = null;
function applyAdminNavRole(role) {
  const a = document.getElementById('navAdmin');
  if (a) a.style.display = role === 'admin' ? '' : 'none';
}
async function revealAdminNav() {
  const cachedRole = sessionStorage.getItem('fuellog_role') || '';
  const checkedAt = Number(sessionStorage.getItem('fuellog_role_checked') || 0);
  if (cachedRole) applyAdminNavRole(cachedRole);
  if (cachedRole && Date.now() - checkedAt < 30000) return { role: cachedRole, cached: true };
  try {
    if (!meRequest) {
      meRequest = api('/api/me').finally(() => { meRequest = null; });
    }
    const me = await meRequest;
    sessionStorage.setItem('fuellog_role', me.role || '');
    sessionStorage.setItem('fuellog_role_checked', String(Date.now()));
    applyAdminNavRole(me.role || '');
    return me;
  } catch (_) { /* 未登录等，忽略 */ }
  return null;
}
if (!/\/(login|register|forgot-password|reset-password)(\.html)?$/.test(location.pathname)) {
  document.readyState === 'loading'
    ? withPersistentListeners(() => document.addEventListener('DOMContentLoaded', () => {
        withPersistentListeners(setupAppShellNav);
        revealAdminNav();
      }))
    : (withPersistentListeners(setupAppShellNav), revealAdminNav());
}

function pageKey(pathname) {
  if (pathname === '/' || pathname.endsWith('/index.html')) return '/';
  return pathname.replace(/\.html$/, '');
}

function scriptPathname(src) {
  try { return new URL(src, location.href).pathname; } catch { return src || ''; }
}

function isAppScript(src) {
  return scriptPathname(src).endsWith('/assets/app.js');
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
    if (src && isAppScript(src)) continue;
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
    if (el.tagName === 'SCRIPT' && isAppScript(el.getAttribute('src'))) return;
    if (el.id === 'toast') return;
    el.remove();
  });

  const appScript = [...document.body.querySelectorAll('script')]
    .find((s) => isAppScript(s.getAttribute('src')));
  const nodes = [...doc.body.children].filter((el) => el.tagName !== 'SCRIPT' && !el.classList.contains('topbar'));
  for (const node of nodes) document.body.insertBefore(document.importNode(node, true), appScript || null);
}

let navSeq = 0;
let navController = null;
const htmlCache = new Map();
const htmlRequests = new Map();
async function fetchShellHtml(url, signal) {
  const key = url.href;
  const cached = htmlCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return cached.html;
  if (htmlRequests.has(key)) return htmlRequests.get(key);
  const request = fetch(key, { headers: { Accept: 'text/html' }, signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      const html = await res.text();
      htmlCache.set(key, { html, at: Date.now() });
      return html;
    })
    .finally(() => htmlRequests.delete(key));
  htmlRequests.set(key, request);
  return request;
}
function prefetchShellPage(url) {
  const target = new URL(url, location.href);
  if (htmlCache.has(target.href)) return;
  fetchShellHtml(target, undefined).catch(() => {});
}

async function navigateWithinShell(url, { push = true } = {}) {
  const target = new URL(url, location.href);
  const seq = ++navSeq;
  if (navController) navController.abort();
  navController = new AbortController();
  document.body.classList.add('app-loading');
  try {
    const html = await fetchShellHtml(target, navController.signal);
    if (seq !== navSeq) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.querySelector('.topbar')) throw new Error('页面结构不完整');

    if (push) history.pushState({ shell: true }, '', target.href);
    document.title = doc.title;
    disposePageLifecycle();
    startPageLifecycle();
    replacePageBody(doc);
    updateTopbarActive(target.pathname);
    revealAdminNav();
    await runPageScripts(doc);
    window.scrollTo(0, 0);
  } catch (ex) {
    if (ex.name === 'AbortError' || seq !== navSeq) return;
    location.href = target.href;
  } finally {
    if (seq === navSeq) document.body.classList.remove('app-loading');
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
  return ['/', '/records', '/record', '/account', '/admin'].includes(pageKey(url.pathname));
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
  document.addEventListener('pointerdown', (e) => {
    const a = e.target.closest('.topbar a');
    if (!a || !shouldHandleShellClick(e, a)) return;
    prefetchShellPage(a.href);
  }, { passive: true });
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
