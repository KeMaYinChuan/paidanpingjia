'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { orderScript, loginScript, uiScript } = require('./ego-driver');
const { detectLogin } = require('./login-check');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'quick');
const PROFILE_ROOT = path.join(ROOT, 'quick-profile');
const RUN_ROOT = path.join(ROOT, 'data', 'ego-runs');
const LOGIN_STATE_FILE = path.join(ROOT, 'data', 'login-state.json');
const PORT = Number(process.env.PORT || 4321);
const TEST_MODE = process.env.TEST_MODE === '1';
const EGO_BIN = process.env.EGO_BROWSER || 'ego-browser';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let session = null;

function loadLoginState() {
  try {
    const saved = JSON.parse(fs.readFileSync(LOGIN_STATE_FILE, 'utf8'));
    if (saved && saved.status === 'saved' && saved.savedAt) {
      return {
        ...saved,
        message: '登录状态已保存在 ego 浏览器中，下次直接拍单即可。',
        error: null,
        space: null,
      };
    }
  } catch {
    // First run.
  }
  return null;
}

const savedLogin = loadLoginState();
let login = savedLogin || {
  status: 'idle',
  account: null,
  message: '首次使用时先打开登录窗口，登录状态会保存在 ego 浏览器里。',
  error: null,
  savedAt: null,
  space: null,
};

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function log(message, level = 'info') {
  if (!session) return;
  session.logs.push({ time: now(), message, level });
  session.logs = session.logs.slice(-120);
}

function publicSession() {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    stage: session.stage,
    logs: session.logs,
    error: session.error,
    browserOpen: session.browserOpen,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    url: session.url,
    sku: session.sku,
    quantity: session.quantity,
    account: session.account,
    autoSubmit: session.autoSubmit,
    currentUrl: session.currentUrl,
  };
}

function publicLogin() {
  return {
    status: login.status,
    account: login.account,
    message: login.message,
    error: login.error,
    savedAt: login.savedAt,
    browserOpen: login.status === 'waiting' || isOrderRunning(),
  };
}

function publicState() {
  return { session: publicSession(), login: publicLogin() };
}

function isOrderRunning() {
  return Boolean(session && ['starting', 'running', 'login_required'].includes(session.status));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new HttpError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON 格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  sendJson(res, status, { error: error.message || '服务器错误' });
}

function extractUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[，。；、)\]}]+$/, '') : null;
}

function allowedHost(hostname) {
  const host = hostname.toLowerCase();
  if (TEST_MODE && (host === '127.0.0.1' || host === 'localhost')) return true;
  return (
    host === 'taobao.com' ||
    host.endsWith('.taobao.com') ||
    host === 'tmall.com' ||
    host.endsWith('.tmall.com') ||
    host === 'tmall.hk' ||
    host.endsWith('.tmall.hk') ||
    host === 'tb.cn' ||
    host.endsWith('.tb.cn')
  );
}

function normalizeInput(body) {
  const urlText = extractUrl(body.url);
  if (!urlText) throw new HttpError(400, '请粘贴淘宝或天猫商品链接');
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new HttpError(400, '商品链接格式不正确');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHost(parsed.hostname)) {
    throw new HttpError(400, '只支持淘宝、天猫商品链接');
  }

  const levels = [body.sku1, body.sku2]
    .map((value) => String(value || '').trim().slice(0, 80))
    .filter(Boolean);
  const sku = levels.length
    ? [...new Set(levels)].join(' / ')
    : String(body.sku || '').trim().slice(0, 160);
  if (!sku) throw new HttpError(400, '请填写规格值，例如：白色');

  const account =
    String(body.account || '').trim().slice(0, 80) || login.account || '我的淘宝';
  const quantity = Math.min(99, Math.max(1, Number(body.quantity) || 1));
  return {
    url: parsed.toString(),
    sku,
    levels: [...new Set(levels)],
    account,
    quantity,
    autoSubmit: Boolean(body.autoSubmit),
  };
}

function profileDirFor(account) {
  const key = crypto.createHash('sha256').update(account).digest('hex').slice(0, 16);
  return path.join(PROFILE_ROOT, key);
}

function fileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

function readProgress(target) {
  if (!target?.progressFile) return;
  let text = '';
  try {
    text = fs.readFileSync(target.progressFile, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter((line) => line.trim());
  for (let index = target.progressLines || 0; index < lines.length; index += 1) {
    try {
      const entry = JSON.parse(lines[index]);
      target.logs.push({
        time: entry.time || now(),
        message: entry.message || '',
        level: entry.level || 'info',
      });
      if (entry.status) target.status = entry.status;
      if (entry.stage) target.stage = entry.stage;
      if (entry.currentUrl) target.currentUrl = entry.currentUrl;
    } catch {
      // Ignore a partially written line.
    }
  }
  target.progressLines = lines.length;
  target.logs = target.logs.slice(-120);
}

function readResult(target) {
  if (!target?.resultFile) return false;
  try {
    const result = JSON.parse(fs.readFileSync(target.resultFile, 'utf8'));
    if (result.status) target.status = result.status;
    if (result.stage) target.stage = result.stage;
    if (result.currentUrl) target.currentUrl = result.currentUrl;
    target.error = result.error || null;
    if (['submitted', 'awaiting_confirmation', 'error', 'cancelled'].includes(target.status)) {
      target.finishedAt = target.finishedAt || now();
    }
    return true;
  } catch {
    return false;
  }
}

function refreshSession() {
  if (!session) return;
  readProgress(session);
  readResult(session);
}

function runEgo(scriptPath, onError) {
  const child = spawn(
    EGO_BIN,
    ['nodejs', '-e', `await import(${JSON.stringify(fileUrl(scriptPath))})`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdout.on('data', () => {});
  child.on('error', (error) => onError?.(error, stderr));
  return { child, getStderr: () => stderr };
}

function openInEgo(address) {
  try {
    fs.mkdirSync(RUN_ROOT, { recursive: true });
    const space = `paidan-ui-${Date.now()}`;
    const scriptPath = path.join(RUN_ROOT, `${space}.mjs`);
    fs.writeFileSync(scriptPath, uiScript({ space, url: address }));
    const child = spawn(
      EGO_BIN,
      ['nodejs', '-e', `await import(${JSON.stringify(fileUrl(scriptPath))})`],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch {
    // The user can still open the address manually.
  }
}

function closeBrowser(reason = '任务已取消', loginOutcome = 'idle') {
  const wasRunning = isOrderRunning();
  if (session?.child) {
    try {
      session.child.kill();
    } catch {
      // Already stopped.
    }
    session.child = null;
  }
  if (session) {
    session.browserOpen = false;
    if (wasRunning) {
      session.status = 'cancelled';
      session.stage = 'cancelled';
      session.finishedAt = now();
      log(reason, 'warn');
    }
  }
  if (['opening', 'waiting'].includes(login.status)) {
    login.status = loginOutcome;
    login.message =
      loginOutcome === 'saved'
        ? '登录状态已保存，下次不用再登录。'
        : '登录窗口已关闭，可以重新打开。';
  }
}

async function openLogin(account) {
  login = {
    status: 'waiting',
    account,
    message: '登录窗口已在 ego 中打开，登录完成后点「我已完成登录」。',
    error: null,
    savedAt: login.savedAt,
    space: `paidan-login-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
  };
  try {
    fs.mkdirSync(RUN_ROOT, { recursive: true });
    const scriptPath = path.join(RUN_ROOT, `${login.space}.mjs`);
    fs.writeFileSync(scriptPath, loginScript({
      space: login.space,
      url: 'https://login.taobao.com/member/login.jhtml',
    }));
    const { child } = runEgo(scriptPath, (error, stderr) => {
      login.status = 'error';
      login.error = error.message || stderr || 'ego 启动失败';
      login.message = `登录窗口打开失败：${login.error}`;
    });
    child.on('exit', (code) => {
      if (code !== 0 && login.status === 'waiting') {
        login.status = 'error';
        login.error = `ego 登录进程退出（${code}）`;
        login.message = login.error;
      }
    });
  } catch (error) {
    login.status = 'error';
    login.error = error.message;
    login.message = `登录窗口打开失败：${error.message}`;
  }
}

async function finishLogin() {
  login.status = 'saved';
  login.account = login.account || '我的淘宝';
  login.error = null;
  login.savedAt = now();
  login.message = '登录状态已保存在 ego 浏览器中，下次直接拍单即可。';
  try {
    fs.mkdirSync(path.dirname(LOGIN_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      LOGIN_STATE_FILE,
      JSON.stringify({ status: 'saved', account: login.account, savedAt: login.savedAt }, null, 2),
    );
  } catch {
    // The browser still keeps the real login state.
  }
  setImmediate(() => refreshLoginAccount());
  return publicLogin();
}

// 登录/切换账号后，用 ego 读一次真实账号名，避免页面里显示的账号名过期。
async function refreshLoginAccount() {
  if (login.status !== 'saved' || isOrderRunning()) return;
  try {
    const info = await detectLogin({ timeoutMs: 45000 });
    if (!info.loggedIn) return;
    const account = String(info.nick || '').trim().slice(0, 40) || login.account;
    if (!account) return;
    login.account = account;
    login.message = '登录状态已保存在 ego 浏览器中，下次直接拍单即可。';
    fs.mkdirSync(path.dirname(LOGIN_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      LOGIN_STATE_FILE,
      JSON.stringify({ status: 'saved', account, savedAt: login.savedAt || now() }, null, 2),
    );
  } catch {
    // 检测失败时保留原来的账号名。
  }
}

function splitSku(sku) {
  return [...new Set(
    String(sku || '')
      .split(/[\/,，、|>]+/)
      .map((part) => part.trim())
      .filter(Boolean),
  )];
}

function failSession(message) {
  if (!session) return;
  session.status = 'error';
  session.stage = 'error';
  session.error = message;
  session.finishedAt = now();
  log(`执行失败：${message}`, 'error');
}

async function runTask() {
  try {
    session.status = 'running';
    session.stage = 'launching';

    const runDir = path.join(RUN_ROOT, session.id);
    fs.mkdirSync(runDir, { recursive: true });
    const progressFile = path.join(runDir, 'progress.ndjson');
    const resultFile = path.join(runDir, 'result.json');
    const scriptPath = path.join(runDir, 'order.mjs');
    fs.writeFileSync(
      scriptPath,
      orderScript({
        space: `paidan-order-${session.id}`,
        url: session.url,
        sku: session.sku,
        quantity: session.quantity,
        autoSubmit: session.autoSubmit,
        progressPath: progressFile,
        resultPath: resultFile,
      }),
    );
    session.progressFile = progressFile;
    session.progressLines = 0;
    session.resultFile = resultFile;
    session.browserOpen = true;

    const { child, getStderr } = runEgo(scriptPath, (error, stderr) => {
      failSession(error.message || stderr || 'ego 启动失败');
    });
    session.child = child;

    session.timer = setTimeout(() => {
      if (!isOrderRunning()) return;
      log('执行超时，已停止等待', 'error');
      try {
        child.kill();
      } catch {
        // Already stopped.
      }
      failSession('执行超时，请重新开始');
    }, 15 * 60 * 1000);

    child.on('exit', (code) => {
      session.child = null;
      if (session.timer) clearTimeout(session.timer);
      refreshSession();
      if (readResult(session)) return;
      if (isOrderRunning()) {
        const detail = getStderr().trim().split('\n').slice(-3).join(' ');
        failSession(`ego 进程退出（${code}）${detail ? `：${detail}` : ''}`);
      }
    });
  } catch (error) {
    failSession(error.message);
  }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(500);
      return res.end('Server error');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, engine: 'ego' });
      }

      if (pathname === '/api/status' && method === 'GET') {
        refreshSession();
        return sendJson(res, 200, publicState());
      }

      if (pathname === '/api/login' && method === 'POST') {
        if (isOrderRunning()) {
          throw new HttpError(409, '请先等当前拍单任务结束再登录');
        }
        const body = await parseBody(req);
        const account = String(body.account || '').trim().slice(0, 80) || login.account || '我的淘宝';
        login = {
          status: 'opening',
          account,
          message: '正在打开淘宝登录窗口…',
          error: null,
          savedAt: login.savedAt,
        };
        setImmediate(() => openLogin(account));
        return sendJson(res, 202, publicState());
      }

      if (pathname === '/api/login/finish' && method === 'POST') {
        const state = await finishLogin();
        return sendJson(res, 200, { login: state, session: publicSession() });
      }

      if (pathname === '/api/start' && method === 'POST') {
        if (isOrderRunning()) {
          throw new HttpError(409, '当前已有拍单任务在运行');
        }
        const input = normalizeInput(await parseBody(req));
        session = {
          id: uid(),
          ...input,
          status: 'starting',
          stage: 'starting',
          logs: [],
          error: null,
          browserOpen: false,
          startedAt: now(),
          finishedAt: null,
          currentUrl: null,
          progressFile: null,
          progressLines: 0,
          resultFile: null,
          child: null,
          timer: null,
        };
        log('任务已创建');
        setImmediate(() => runTask());
        return sendJson(res, 202, { session: publicSession(), login: publicLogin() });
      }

      if (pathname === '/api/close' && method === 'POST') {
        closeBrowser('任务已由用户取消');
        return sendJson(res, 200, publicState());
      }

      if (pathname.startsWith('/api/')) {
        throw new HttpError(404, '接口不存在');
      }

      return serveStatic(req, res, pathname);
    } catch (error) {
      return sendError(res, error);
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${PORT}`;
    console.log(`一键拍单已启动：${address}`);
    if (process.env.AUTO_OPEN === '1') {
      openInEgo(address);
    }
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。若页面已启动，直接打开 http://127.0.0.1:${PORT}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
}

module.exports = {
  createServer,
  normalizeInput,
  extractUrl,
  allowedHost,
  profileDirFor,
  splitSku,
};
