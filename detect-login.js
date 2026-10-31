'use strict';

// 检测 ego 浏览器里是否已有淘宝登录态，并把结果写入 data/login-state.json。
// 用法：npm run detect-login

const fs = require('node:fs');
const path = require('node:path');
const { detectLogin } = require('./login-check');

const STATE_FILE = path.join(__dirname, 'data', 'login-state.json');

detectLogin()
  .then((info) => {
    if (!info.loggedIn) {
      fs.rmSync(STATE_FILE, { force: true });
      console.log('未检测到淘宝登录态：请在 ego 里登录一次，再执行 npm run detect-login。');
      return;
    }
    const account = (info.nick || '').trim() || '我的淘宝';
    const savedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ status: 'saved', account, savedAt }, null, 2));
    console.log(`已检测到淘宝登录态：${account}（${savedAt}）`);
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
