'use strict';

// 晒评价调度器：定时巡检到期任务，串行执行（同一时刻只跑一个 ego 任务）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { taskScript } = require('./review-driver');
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
      images: task.images,
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

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: Boolean(this.timer),
      busy: this.running,
      lastTickAt: this.lastTickAt,
      lastTickResult: this.lastTickResult,
      nextTickAt: this.timer ? new Date(Date.now() + this.intervalMs).toISOString() : null,
    };
  }

  async tick({ manual = false, limit = null } = {}) {
    if (this.running) return { busy: true, processed: [] };
    const settings = this.store.settings;
    if (!manual) {
      if (!settings.enabled) return { disabled: true, processed: [] };
      if (inQuietHours(settings, Date.now())) return { quiet: true, processed: [] };
    }
    if (this.runner.lock.isBusy()) return { busy: true, processed: [] };

    const due = this.store.dueTasks(Date.now());
    for (const item of due) {
      if (item.action === 'expire') {
        this.store.applyResult(item.id, { state: 'expired', error: '已超出可追评窗口' });
      }
    }
    const workable = due.filter((item) => item.action !== 'expire');
    const max = limit || settings.maxTasksPerTick;
    const picked = workable.slice(0, max);
    if (!picked.length) {
      this.lastTickAt = new Date().toISOString();
      this.lastTickResult = { processed: [] };
      return { processed: [] };
    }

    this.running = true;
    const processed = [];
    try {
      for (const item of picked) {
        if (this.runner.lock.isBusy()) break;
        try {
          const outcome = await this.runner.runTask(item.id);
          processed.push({ id: item.id, action: item.action, state: outcome && outcome.task ? outcome.task.state : 'unknown' });
        } catch (error) {
          this.store.applyResult(item.id, { state: 'error', error: error.message });
          processed.push({ id: item.id, action: item.action, state: 'error' });
        }
      }
    } finally {
      this.running = false;
    }
    this.lastTickAt = new Date().toISOString();
    this.lastTickResult = { processed };
    return { processed };
  }
}

module.exports = { ReviewScheduler, ReviewRunner };
