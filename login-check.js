'use strict';

// 用 ego 打开淘宝首页，读当前登录的账号名。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUN_ROOT = path.join(__dirname, 'data', 'ego-runs');
const EGO_BIN = process.env.EGO_BROWSER || 'ego-browser';
const MARKER = 'PAIDAN_LOGIN_RESULT ';

function fileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

function checkScript(space) {
  return `'use strict';

const SPACE = ${JSON.stringify(space)};
const task = await taskSpace(SPACE);
const page = task.page('p1');
await page.goto('https://www.taobao.com').catch(() => {});
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const text = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ');
  const nickEl = document.querySelector('.site-nav-login-info-nick, .site-nav-user-nick, #J_SiteNavLogin .site-nav-user');
  return {
    url: location.href,
    title: document.title,
    loggedIn: /已买到的宝贝|我的淘宝|我的订单/.test(text) && !/login\\.taobao\\.com/.test(location.href),
    nick: nickEl ? (nickEl.innerText || '').replace(/[\\s\\u00a0\\u1680\\u2000-\\u200f\\u2028-\\u202f\\u205f\\u3000\\ue000-\\uf8ff\\ufeff]+/g, ' ').trim().slice(0, 40) : null,
  };
});

console.log(${JSON.stringify(MARKER)} + JSON.stringify(info));
await page.close().catch(() => {});
await task.finish({ keep: 'all' }).catch(() => {});
`;
}

function detectLogin({ timeoutMs = 60000 } = {}) {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const space = `paidan-login-check-${Date.now()}`;
  const scriptPath = path.join(RUN_ROOT, `${space}.mjs`);
  fs.writeFileSync(scriptPath, checkScript(space));

  return new Promise((resolve, reject) => {
    const child = spawn(
      EGO_BIN,
      ['nodejs', '-e', `await import(${JSON.stringify(fileUrl(scriptPath))})`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already stopped.
      }
      reject(new Error('检测登录态超时'));
    }, timeoutMs);

    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-20000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = output.split('\n').find((item) => item.includes(MARKER));
      if (!line) {
        reject(new Error(`ego 检测失败（退出码 ${code}）：${output.trim().split('\n').slice(-3).join(' ')}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = { detectLogin };
