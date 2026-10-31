'use strict';

const $ = (selector) => document.querySelector(selector);

const STAGE_LABELS = {
  starting: '正在创建任务',
  launching: '正在打开浏览器',
  opening: '正在打开商品页',
  login: '等待登录',
  selecting_sku: '正在选择 SKU',
  buying: '正在进入结算页',
  confirming: '正在整理订单',
  confirm: '等待你确认订单',
  submitted: '订单已提交',
  error: '执行失败',
  cancelled: '已取消',
};

const STAGE_PROGRESS = {
  starting: 6,
  launching: 16,
  opening: 30,
  login: 42,
  selecting_sku: 55,
  buying: 70,
  confirming: 82,
  confirm: 94,
  submitted: 100,
  error: 100,
  cancelled: 100,
};

let pollTimer = null;
let currentLogin = null;

const LOGIN_LABELS = {
  idle: '未登录',
  opening: '正在打开登录窗口',
  waiting: '等待登录',
  saved: '已登录',
  error: '登录失败',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function isRunning(session) {
  return session && ['starting', 'running', 'login_required'].includes(session.status);
}

function statusInfo(session) {
  if (!session) {
    return { title: '准备中', dot: '', progress: 0, hint: '', hintClass: '' };
  }
  if (session.status === 'error') {
    return {
      title: '执行失败',
      dot: 'error',
      progress: 100,
      hint: session.error || '请查看上方日志',
      hintClass: 'error',
    };
  }
  if (session.status === 'submitted') {
    return {
      title: '订单已提交',
      dot: 'success',
      progress: 100,
      hint: '订单已创建但未付款。请在 ego 浏览器里核对并完成付款；脚本不会操作支付环节。',
      hintClass: '',
    };
  }
  if (session.status === 'awaiting_confirmation') {
    return {
      title: '等待你确认订单',
      dot: 'success',
      progress: 94,
      hint: 'ego 浏览器已停在订单确认页。核对收货地址、SKU、数量和金额后，手动点击「提交订单」。',
      hintClass: '',
    };
  }
  if (session.status === 'cancelled') {
    return {
      title: '任务已取消',
      dot: 'error',
      progress: 100,
      hint: '可以修改信息后重新开始。',
      hintClass: 'warn',
    };
  }
  if (session.status === 'login_required') {
    return {
      title: '等待登录',
      dot: 'running',
      progress: 42,
      hint: '请在 ego 浏览器里登录淘宝（扫码或账号登录）。登录成功后，脚本会自动继续。',
      hintClass: 'warn',
    };
  }
  const stage = STAGE_LABELS[session.stage] || '正在执行';
  return {
    title: stage,
    dot: 'running',
    progress: STAGE_PROGRESS[session.stage] || 20,
    hint: 'ego 浏览器正在自动操作，请不要关闭对应标签页。',
    hintClass: '',
  };
}

function render(session) {
  const panel = $('#statusPanel');
  if (!session) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const info = statusInfo(session);
  $('#statusTitle').textContent = info.title;
  $('#statusDot').className = `status-dot ${info.dot}`.trim();
  $('#progressBar').style.width = `${info.progress}%`;
  $('#statusHint').textContent = info.hint;
  $('#statusHint').className = `status-hint ${info.hintClass}`.trim();
  $('#closeBrowserBtn').hidden = !isRunning(session);
  $('#startBtn').disabled = isRunning(session);
  $('#startBtnText').textContent = isRunning(session) ? '执行中…' : '开始拍单';

  const logs = $('#logs');
  logs.innerHTML = session.logs
    .map(
      (entry) =>
        `<li class="log ${entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : entry.level === 'success' ? 'success' : ''}"><time>${timeLabel(entry.time)}</time><span>${escapeHtml(entry.message)}</span></li>`,
    )
    .join('');
  logs.scrollTop = logs.scrollHeight;
}

function renderLogin(info) {
  currentLogin = info || currentLogin;
  const login = currentLogin || { status: 'idle', message: '登录状态会保存在本机，下次直接拍单。' };
  const dot = $('#loginDot');
  dot.className = 'login-dot';
  if (login.status === 'waiting' || login.status === 'opening') dot.classList.add('waiting');
  if (login.status === 'saved') dot.classList.add('success');
  if (login.status === 'error') dot.classList.add('error');

  const label = LOGIN_LABELS[login.status] || '未登录';
  const account = String(login.account || '').trim();
  $('#loginState').textContent = login.status === 'saved' && account ? `${label} · ${account}` : label;
  $('#loginHint').textContent = login.message || '登录状态会保存在本机，下次直接拍单。';
  $('#loginHint').title = login.message || '';

  const loginBtn = $('#loginBtn');
  const finishBtn = $('#finishLoginBtn');
  loginBtn.textContent = login.status === 'waiting' ? '重新打开 ego 登录' : '打开 ego 登录';
  loginBtn.disabled = login.status === 'opening';
  finishBtn.hidden = login.status !== 'waiting';
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function poll() {
  try {
    const data = await request('/api/status');
    render(data.session);
    renderLogin(data.login);
  } catch {
    // A transient network error should not erase the current status view.
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1000);
}

async function startOrder(event) {
  event.preventDefault();
  const payload = {
    url: $('#url').value,
    sku1: $('#sku1').value,
    sku2: $('#sku2').value,
    quantity: Number($('#quantity').value) || 1,
    autoSubmit: $('#autoSubmit').checked,
  };
  if (!payload.url.trim()) return;
  if (!payload.sku1.trim() && !payload.sku2.trim()) return;

  $('#startBtn').disabled = true;
  $('#startBtnText').textContent = '启动中…';
  try {
    const data = await request('/api/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    render(data.session);
    renderLogin(data.login);
    startPolling();
  } catch (error) {
    render({
      status: 'error',
      stage: 'error',
      error: error.message,
      logs: [{ time: new Date().toISOString(), message: error.message, level: 'error' }],
      browserOpen: false,
      autoSubmit: payload.autoSubmit,
    });
  }
}

async function closeBrowser() {
  try {
    const data = await request('/api/close', { method: 'POST' });
    render(data.session);
    renderLogin(data.login);
  } catch (error) {
    render({
      status: 'error',
      stage: 'error',
      error: error.message,
      logs: [{ time: new Date().toISOString(), message: error.message, level: 'error' }],
      browserOpen: false,
    });
  }
}

async function loginTaobao() {
  $('#loginBtn').disabled = true;
  try {
    const data = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    render(data.session);
    renderLogin(data.login);
    startPolling();
  } catch (error) {
    renderLogin({ status: 'error', message: error.message });
  } finally {
    $('#loginBtn').disabled = false;
  }
}

async function finishLogin() {
  $('#finishLoginBtn').disabled = true;
  try {
    const data = await request('/api/login/finish', { method: 'POST' });
    renderLogin(data.login);
    render(data.session);
  } catch (error) {
    renderLogin({ status: 'error', message: error.message });
  } finally {
    $('#finishLoginBtn').disabled = false;
  }
}

function init() {
  $('#orderForm').addEventListener('submit', startOrder);
  $('#closeBrowserBtn').addEventListener('click', closeBrowser);
  $('#loginBtn').addEventListener('click', loginTaobao);
  $('#finishLoginBtn').addEventListener('click', finishLogin);
  poll();
  startPolling();
}

init();
