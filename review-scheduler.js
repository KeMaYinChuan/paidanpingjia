'use strict';

// 晒评价调度器：定时巡检到期任务，串行执行（同一时刻只跑一个 ego 任务）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { taskScript, fetchImagesScript, importOrdersScript, DEFAULT_URLS } = require('./review-driver');
const { inQuietHours } = require('./review-store');

const EGO_BIN = process.env.EGO_BROWSER || 'ego-browser';
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

function fileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

function uid() {
  return crypto.randomUUID();
}

class ReviewRunner {
  constructor({ root, store, lock, mockBase = '' }) {
    this.root = root;
    this.store = store;
    this.lock = lock;
    this.mockBase = mockBase;
    this.child = null;
  }

  urlsFor() {
    if (!this.mockBase) return undefined;
    return { orders: `${this.mockBase}/__mock-orders.html` };
  }

  async runTask(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (!this.lock.acquire('review')) {
      return { skipped: true, reason: '当前有其它 ego 任务在执行' };
    }
    const runId = uid();
    const runDir = this.store.runDirFor(task.id, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const progressPath = path.join(runDir, 'progress.ndjson');
    const resultPath = path.join(runDir, 'result.json');
    const scriptPath = path.join(runDir, 'run.mjs');
    const space = `paidan-review-${task.orderId}-${Date.now()}`;

    fs.writeFileSync(scriptPath, taskScript({
      space,
      orderId: task.orderId,
      reviewImages: task.reviewImages,
      followupImages: task.followupImages,
      content: task.content,
      followupContent: task.followupContent,
      rating: task.rating,
      urls: this.urlsFor(),
      progressPath,
      resultPath,
    }));

    this.store.markRunning(task.id, task.state === 'waiting_followup' || task.state === 'reviewed' ? 'following_up' : 'probing');

    try {
      await this.#spawnEgo(scriptPath);
    } finally {
      this.lock.release('review');
    }

    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch {
      result = { state: 'error', error: 'ego 任务没有产出结果' };
    }
    result.runId = runId;
    const saved = this.store.applyResult(task.id, result);
    return { result, task: saved };
  }

  // 输入商品链接，抓取主图 / SKU 图（返回图片 URL 列表，由调用方下载）。
  async fetchImages({ url, sku1 = '', sku2 = '' }) {
    if (!this.lock.acquire('review-fetch')) {
      const error = new Error('当前有其它 ego 任务在执行，请稍后再试');
      error.status = 409;
      throw error;
    }
    const runDir = path.join(this.store.runRoot, '_fetch', String(Date.now()));
    fs.mkdirSync(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const scriptPath = path.join(runDir, 'fetch.mjs');
    const space = `paidan-fetch-${Date.now()}`;
    fs.writeFileSync(scriptPath, fetchImagesScript({ space, url, sku1, sku2, resultPath }));
    try {
      await this.#spawnEgo(scriptPath);
    } finally {
      this.lock.release('review-fetch');
    }
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch {
      throw new Error('抓图任务没有产出结果');
    }
    if (result.state !== 'ok') {
      throw new Error(result.reason || result.error || '抓图失败');
    }
    return result;
  }

  // 扫描已买到的宝贝，返回已确认收货的订单。
  async importOrders() {
    if (!this.lock.acquire('review-import')) {
      const error = new Error('当前有其它 ego 任务在执行，请稍后再试');
      error.status = 409;
      throw error;
    }
    const runDir = path.join(this.store.runRoot, '_import', String(Date.now()));
    fs.mkdirSync(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const scriptPath = path.join(runDir, 'import.mjs');
    const space = `paidan-import-${Date.now()}`;
    const ordersUrl = (this.mockBase ? `${this.mockBase}/__mock-orders.html` : DEFAULT_URLS.orders);
    fs.writeFileSync(scriptPath, importOrdersScript({ space, ordersUrl, resultPath }));
    try {
      await this.#spawnEgo(scriptPath);
    } finally {
      this.lock.release('review-import');
    }
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch {
      throw new Error('同步订单没有产出结果');
    }
    if (result.state !== 'ok') {
      throw new Error(result.reason || result.error || '同步订单失败');
    }
    return result;
  }

  #spawnEgo(scriptPath) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        EGO_BIN,
        ['nodejs', '-e', `await import(${JSON.stringify(fileUrl(scriptPath))})`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8000); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('晒评价任务超时'));
      }, RUN_TIMEOUT_MS);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        this.child = null;
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`ego 进程退出（${code}）：${(stderr || stdout).trim().split('\n').slice(-3).join(' ')}`));
      });
    });
  }
}

class ReviewScheduler {
  constructor({ root, store, lock, intervalMs = 60000, mockBase = '' }) {
    this.store = store;
    this.runner = new ReviewRunner({ root, store, lock, mockBase });
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
    this.lastTickResult = null;
  }

  // 不做定时巡检：只在打开晒评价页面时触发一次检查（见 /api/review/check-now）。
  start() {
    this.stop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: false,
      busy: this.running,
      lastTickAt: this.lastTickAt,
      lastTickResult: this.lastTickResult,
      nextTickAt: null,
    };
  }

  // 一次触发会把所有到期任务排队跑完（同一时刻只跑一个 ego 任务）。
  async tick({ manual = false, limit = null } = {}) {
    if (this.running) return { busy: true, processed: [] };
    const settings = this.store.settings;
    if (!manual) {
      if (!settings.enabled) return { disabled: true, processed: [] };
      if (inQuietHours(settings, Date.now())) return { quiet: true, processed: [] };
    }
    if (this.runner.lock.isBusy()) return { busy: true, processed: [] };

    this.running = true;
    const processed = [];
    const max = limit || 200;
    try {
      for (let index = 0; index < max; index += 1) {
        if (this.runner.lock.isBusy()) break; // 拍单正在跑，剩下的任务下次再处理
        const due = this.store.dueTasks(Date.now());
        for (const item of due) {
          if (item.action === 'expire') {
            this.store.applyResult(item.id, { state: 'expired', error: '已超出可追评窗口' });
          }
        }
        const next = due.find((item) => item.action !== 'expire');
        if (!next) break;
        try {
          const outcome = await this.runner.runTask(next.id);
          processed.push({ id: next.id, action: next.action, state: outcome && outcome.task ? outcome.task.state : 'unknown' });
        } catch (error) {
          this.store.applyResult(next.id, { state: 'error', error: error.message });
          processed.push({ id: next.id, action: next.action, state: 'error' });
        }
      }
    } finally {
      this.running = false;
      this.lastTickAt = new Date().toISOString();
      this.lastTickResult = { processed };
    }
    return { processed };
  }

  // 手动执行单个任务（立即评价 / 立即追评）。
  async runOne(taskId) {
    if (this.runner.lock.isBusy()) {
      const error = new Error('当前有其它 ego 任务在执行，请稍后再试');
      error.status = 409;
      throw error;
    }
    try {
      return await this.runner.runTask(taskId);
    } catch (error) {
      this.store.applyResult(taskId, { state: 'error', error: error.message });
      throw error;
    }
  }
}

module.exports = { ReviewScheduler, ReviewRunner };
