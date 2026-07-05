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
  await api('/api/logout', { method: 'POST' });
  location.href = '/login.html';
}

// 登录态页面：管理员显示「管理」导航（元素 id=navAdmin，默认隐藏）
async function revealAdminNav() {
  try {
    const me = await api('/api/me');
    const a = document.getElementById('navAdmin');
    if (a && me.role === 'admin') a.style.display = '';
  } catch (_) { /* 未登录等，忽略 */ }
}
if (!/\/(login|register)(\.html)?$/.test(location.pathname)) {
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', revealAdminNav)
    : revealAdminNav();
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
