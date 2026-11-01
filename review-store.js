'use strict';

// 晒评价任务的数据层：读写 data/reviews.json，提供增删改查与到期计算。
// 不依赖 HTTP、不依赖 ego，纯数据逻辑，方便单测。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATES = [
  'prepared',
  'probing',
  'waiting_confirm',
  'pending_review',
  'reviewing',
  'reviewed',
  'waiting_followup',
  'following_up',
  'done',
  'paused',
  'needs_attention',
  'error',
  'expired',
];

const DONE_STATES = ['done', 'error', 'expired'];
const IDLE_STATES = ['paused'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkIntervalMinutes: 30,
  followupDefaultDays: 3,
  quietHours: { start: '23:30', end: '08:00' },
  maxImagesPerReview: 5,
  maxImagesPerFollowup: 5,
  reviewWindowDays: 15,
  followupWindowDays: 180,
  rating: 5,
  maxTasksPerTick: 3,
  hourlyLimit: 10,
  dailyLimit: 30,
  taskGapMinSeconds: 15,
  taskGapMaxSeconds: 45,
};

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseClock(text, fallback) {
  const match = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeSettings(patch = {}, base = DEFAULT_SETTINGS) {
  const input = { ...base, ...patch };
  const quietHours = { ...base.quietHours, ...(patch.quietHours || {}) };
  return {
    enabled: input.enabled !== false,
    checkIntervalMinutes: clamp(Number(input.checkIntervalMinutes) || base.checkIntervalMinutes, 5, 1440),
    followupDefaultDays: clamp(Number(input.followupDefaultDays ?? base.followupDefaultDays) || 0, 0, 180),
    quietHours: {
      start: parseClock(quietHours.start, base.quietHours.start),
      end: parseClock(quietHours.end, base.quietHours.end),
    },
    maxImagesPerReview: clamp(Number(input.maxImagesPerReview) || base.maxImagesPerReview, 1, 5),
    maxImagesPerFollowup: clamp(Number(input.maxImagesPerFollowup) || base.maxImagesPerFollowup, 1, 5),
    reviewWindowDays: clamp(Number(input.reviewWindowDays) || base.reviewWindowDays, 1, 30),
    followupWindowDays: clamp(Number(input.followupWindowDays) || base.followupWindowDays, 1, 365),
    rating: clamp(Number(input.rating) || base.rating, 1, 5),
    maxTasksPerTick: clamp(Number(input.maxTasksPerTick) || base.maxTasksPerTick, 1, 10),
    hourlyLimit: clamp(Number(input.hourlyLimit) || base.hourlyLimit, 1, 100),
    dailyLimit: clamp(Number(input.dailyLimit) || base.dailyLimit, 1, 500),
    taskGapMinSeconds: clamp(Number(input.taskGapMinSeconds ?? base.taskGapMinSeconds), 0, 600),
    taskGapMaxSeconds: clamp(Number(input.taskGapMaxSeconds ?? base.taskGapMaxSeconds), 0, 900),
  };
}

function sanitizeOrderId(value) {
  const text = String(value || '').trim();
  if (!/^[0-9A-Za-z_-]{6,40}$/.test(text)) return null;
  return text;
}

function normalizeImageList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function inQuietHours(settings, now = Date.now()) {
  const { start, end } = settings.quietHours;
  if (!start || !end || start === end) return false;
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startAt = sh * 60 + sm;
  const endAt = eh * 60 + em;
  if (startAt < endAt) return minutes >= startAt && minutes < endAt;
  // 跨午夜，例如 23:30 - 08:00
  return minutes >= startAt || minutes < endAt;
}

function addDaysIso(baseIso, days) {
  const base = new Date(baseIso).getTime();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

function nextCheckIso(settings, from = Date.now()) {
  return new Date(from + settings.checkIntervalMinutes * 60 * 1000).toISOString();
}

// 返回该任务这一轮该做什么：probe / review / followup / null
function planFor(task, settings, now = Date.now()) {
  if (!task) return null;
  if (IDLE_STATES.includes(task.state) || DONE_STATES.includes(task.state)) return null;
  if (task.state === 'needs_attention') return null;
  if (task.state === 'prepared') return 'probe';
  if (task.state === 'probing' || task.state === 'reviewing' || task.state === 'following_up') {
    return 'probe'; // 上次异常退出，重新巡检
  }
  if (task.state === 'waiting_confirm' || task.state === 'pending_review') {
    if (!task.nextCheckAt) return 'probe';
    return new Date(task.nextCheckAt).getTime() <= now ? 'probe' : null;
  }
  if (task.state === 'reviewed' || task.state === 'waiting_followup') {
    if (!task.followupDueAt) return null;
    if (new Date(task.followupDueAt).getTime() > now) return null;
    const windowEnd = task.reviewedAt
      ? new Date(addDaysIso(task.reviewedAt, settings.followupWindowDays)).getTime()
      : Infinity;
    if (now > windowEnd) return 'expire';
    return 'followup';
  }
  return null;
}

class ReviewStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'reviews.json');
    this.imageRoot = path.join(root, 'data', 'review-images');
    this.runRoot = path.join(root, 'data', 'review-runs');
    this.state = { version: 1, settings: normalizeSettings(), tasks: [], recentRuns: [] };
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const settings = normalizeSettings(raw.settings || {});
      const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((task) => this.#normalizeTask(task)) : [];
      this.state = { version: 1, settings, tasks, recentRuns: Array.isArray(raw.recentRuns) ? raw.recentRuns.slice(-500) : [] };
    } catch {
      this.state = { version: 1, settings: normalizeSettings(), tasks: [], recentRuns: [] };
    }
    return this.state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get settings() {
    return this.state.settings;
  }

  updateSettings(patch) {
    this.state.settings = normalizeSettings(patch, this.state.settings);
    this.save();
    return this.state.settings;
  }

  listTasks() {
    return this.state.tasks.map((task) => this.#publicTask(task));
  }

  getTask(id) {
    return this.state.tasks.find((task) => task.id === id) || null;
  }

  getByOrderId(orderId) {
    return this.state.tasks.find((task) => task.orderId === orderId) || null;
  }

  upsertTask(input) {
    const orderId = sanitizeOrderId(input.orderId);
    if (!orderId) {
      const error = new Error('订单号格式不正确');
      error.status = 400;
      throw error;
    }
    const existing = this.getByOrderId(orderId);
    const settings = this.state.settings;
    const reviewImages = normalizeImageList(input.reviewImages ?? input.images);
    const followupImages = normalizeImageList(input.followupImages);
    if (reviewImages.length > settings.maxImagesPerReview) {
      const error = new Error(`首次晒图最多 ${settings.maxImagesPerReview} 张`);
      error.status = 400;
      throw error;
    }
    if (followupImages.length > settings.maxImagesPerFollowup) {
      const error = new Error(`追评晒图最多 ${settings.maxImagesPerFollowup} 张`);
      error.status = 400;
      throw error;
    }
    const patch = {
      orderId,
      orderTitle: String(input.orderTitle || '').trim().slice(0, 120),
      itemUrl: String(input.itemUrl || '').trim().slice(0, 500),
      reviewImages,
      followupImages,
      content: String(input.content || '').slice(0, 500),
      followupContent: String(input.followupContent || '').slice(0, 500),
      followupDays: clamp(Number(input.followupDays ?? settings.followupDefaultDays), 0, 180),
      rating: clamp(Number(input.rating || settings.rating), 1, 5),
      updatedAt: nowIso(),
    };

    if (existing) {
      Object.assign(existing, patch);
      if (input.reset === true) {
        Object.assign(existing, {
          state: 'prepared',
          reviewedAt: null,
          followupDueAt: null,
          nextCheckAt: null,
          lastError: null,
          attempts: 0,
        });
        this.addLog(existing, '已重置任务', 'info');
      }
      this.save();
      return this.#publicTask(existing);
    }

    const task = this.#normalizeTask({
      id: uid(),
      ...patch,
      state: 'prepared',
      createdAt: nowIso(),
      logs: [{ time: nowIso(), level: 'info', message: '任务已创建' }],
    });
    this.state.tasks.push(task);
    this.save();
    return this.#publicTask(task);
  }

  updateTask(id, patch = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    const settings = this.state.settings;

    for (const key of ['orderTitle', 'itemUrl', 'content', 'followupContent']) {
      if (patch[key] !== undefined) {
        task[key] = String(patch[key] || '').slice(0, key === 'itemUrl' ? 500 : 500).trim();
      }
    }
    if (patch.reviewImages !== undefined || patch.images !== undefined) {
      const reviewImages = normalizeImageList(patch.reviewImages ?? patch.images);
      if (reviewImages.length > settings.maxImagesPerReview) {
        const error = new Error(`首次晒图最多 ${settings.maxImagesPerReview} 张`);
        error.status = 400;
        throw error;
      }
      task.reviewImages = reviewImages;
    }
    if (patch.followupImages !== undefined) {
      const followupImages = normalizeImageList(patch.followupImages);
      if (followupImages.length > settings.maxImagesPerFollowup) {
        const error = new Error(`追评晒图最多 ${settings.maxImagesPerFollowup} 张`);
        error.status = 400;
        throw error;
      }
      task.followupImages = followupImages;
    }
    if (patch.followupDays !== undefined) {
      task.followupDays = clamp(Number(patch.followupDays) || 0, 0, 180);
    }
    if (patch.rating !== undefined) {
      task.rating = clamp(Number(patch.rating) || settings.rating, 1, 5);
    }
    if (patch.action === 'pause') {
      if (!IDLE_STATES.includes(task.state) && !DONE_STATES.includes(task.state)) {
        task.prevState = task.state;
        task.state = 'paused';
        this.addLog(task, '已暂停', 'warn');
      }
    } else if (patch.action === 'resume') {
      if (task.state === 'paused') {
        task.state = task.prevState && !IDLE_STATES.includes(task.prevState) ? task.prevState : 'prepared';
        task.prevState = null;
        task.nextCheckAt = nowIso();
        this.addLog(task, '已恢复', 'info');
      }
    } else if (patch.action === 'retry') {
      if (['error', 'needs_attention', 'expired'].includes(task.state)) {
        task.state = task.prevState && !DONE_STATES.includes(task.prevState) ? task.prevState : 'prepared';
        task.lastError = null;
        task.attempts = 0;
        task.nextCheckAt = nowIso();
        this.addLog(task, '已重试', 'info');
      }
    }
    task.updatedAt = nowIso();
    this.save();
    return this.#publicTask(task);
  }

  deleteTask(id) {
    const index = this.state.tasks.findIndex((task) => task.id === id);
    if (index === -1) return false;
    const [task] = this.state.tasks.splice(index, 1);
    try {
      fs.rmSync(path.join(this.imageRoot, task.id), { recursive: true, force: true });
    } catch {
      // 图片目录可能不存在。
    }
    this.save();
    return true;
  }

  // 应用一次运行结果，并推进状态机。
  applyResult(id, result = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    const settings = this.state.settings;
    const now = Date.now();
    const state = result.state;
    task.lastCheckAt = nowIso(now);
    task.lastRunId = result.runId || task.lastRunId;
    task.currentUrl = result.currentUrl || task.currentUrl || null;
    if (Array.isArray(result.logs)) {
      for (const entry of result.logs.slice(-60)) {
        this.addLog(task, String(entry.message || ''), entry.level || 'info');
      }
    }

    if (state === 'waiting_confirm' || state === 'pending_review') {
      task.state = state;
      task.attempts = 0;
      task.lastError = null;
      task.nextCheckAt = nextCheckIso(settings, now);
      if (result.orderTitle) task.orderTitle = String(result.orderTitle).slice(0, 120);
    } else if (state === 'reviewed') {
      task.state = 'reviewed';
      task.reviewedAt = task.reviewedAt || nowIso(now);
      task.followupDueAt = addDaysIso(task.reviewedAt, task.followupDays);
      task.attempts = 0;
      task.lastError = null;
      task.nextCheckAt = null;
      if (task.followupDays <= 0) {
        task.state = 'waiting_followup';
      } else {
        task.state = 'waiting_followup';
      }
      this.addLog(task, `已评价，追评时间：${task.followupDueAt}`, 'success');
    } else if (state === 'done') {
      task.state = 'done';
      task.followupDoneAt = nowIso(now);
      task.attempts = 0;
      task.lastError = null;
      task.nextCheckAt = null;
      this.addLog(task, '追评完成', 'success');
    } else if (state === 'needs_attention') {
      task.state = 'needs_attention';
      task.needsAttentionReason = String(result.reason || result.error || '需要人工处理').slice(0, 300);
      task.lastError = task.needsAttentionReason;
      task.attempts = 0;
      task.nextCheckAt = null;
      this.addLog(task, `需要人工处理：${task.needsAttentionReason}`, 'warn');
    } else if (state === 'expired') {
      task.state = 'expired';
      task.lastError = String(result.error || '已超出可评价/追评窗口').slice(0, 300);
      task.nextCheckAt = null;
      this.addLog(task, `已过期：${task.lastError}`, 'warn');
    } else if (state === 'error') {
      task.attempts = (task.attempts || 0) + 1;
      task.lastError = String(result.error || '执行失败').slice(0, 500);
      if (task.attempts >= 3) {
        task.state = 'error';
        task.nextCheckAt = null;
      } else {
        task.state = result.resumeState || 'waiting_confirm';
        const backoffMinutes = [5, 15, 45][task.attempts - 1] || 45;
        task.nextCheckAt = new Date(now + backoffMinutes * 60 * 1000).toISOString();
      }
      this.addLog(task, `执行失败（第 ${task.attempts} 次）：${task.lastError}`, 'error');
    } else if (state === 'paused') {
      task.state = 'paused';
    } else {
      task.lastError = String(result.error || '未知结果').slice(0, 300);
      this.addLog(task, `未识别的结果状态：${state}`, 'warn');
    }
    task.updatedAt = nowIso(now);
    this.save();
    return this.#publicTask(task);
  }

  markRunning(id, phase) {
    const task = this.getTask(id);
    if (!task) return null;
    if (phase === 'probing') task.state = 'probing';
    if (phase === 'reviewing') task.state = 'reviewing';
    if (phase === 'following_up') task.state = 'following_up';
    task.updatedAt = nowIso();
    this.save();
    return task;
  }

  addLog(task, message, level = 'info') {
    if (!message) return;
    task.logs = Array.isArray(task.logs) ? task.logs : [];
    task.logs.push({ time: nowIso(), level, message: String(message).slice(0, 300) });
    task.logs = task.logs.slice(-120);
  }

  dueTasks(now = Date.now()) {
    const settings = this.state.settings;
    const out = [];
    for (const task of this.state.tasks) {
      const action = planFor(task, settings, now);
      if (action) out.push({ id: task.id, action });
    }
    // 追评优先，其次评价，最后巡检
    const weight = { followup: 0, expire: 1, review: 2, probe: 3 };
    out.sort((a, b) => (weight[a.action] ?? 9) - (weight[b.action] ?? 9));
    return out;
  }

  rateStatus(now = Date.now()) {
    const settings = this.state.settings;
    const runs = (this.state.recentRuns || [])
      .map((time) => new Date(time).getTime())
      .filter((time) => Number.isFinite(time) && now - time < 24 * 60 * 60 * 1000);
    const hour = runs.filter((time) => now - time < 60 * 60 * 1000).length;
    const day = runs.length;
    return {
      hour,
      day,
      hourlyLimit: settings.hourlyLimit,
      dailyLimit: settings.dailyLimit,
      allowed: hour < settings.hourlyLimit && day < settings.dailyLimit,
    };
  }

  recordRun(now = Date.now()) {
    const runs = (this.state.recentRuns || [])
      .filter((time) => now - new Date(time).getTime() < 24 * 60 * 60 * 1000);
    runs.push(new Date(now).toISOString());
    this.state.recentRuns = runs.slice(-500);
    this.save();
  }

  stats() {
    const counts = {};
    for (const task of this.state.tasks) {
      counts[task.state] = (counts[task.state] || 0) + 1;
    }
    return {
      total: this.state.tasks.length,
      counts,
      waitingConfirm: (counts.waiting_confirm || 0),
      pendingReview: (counts.pending_review || 0),
      waitingFollowup: (counts.waiting_followup || 0) + (counts.reviewed || 0),
      done: counts.done || 0,
      needsAttention: (counts.needs_attention || 0) + (counts.error || 0),
    };
  }

  imageDirFor(taskId) {
    return path.join(this.imageRoot, taskId);
  }

  runDirFor(taskId, runId) {
    return path.join(this.runRoot, taskId, runId);
  }

  #publicTask(task) {
    const toUrls = (list) => (list || []).map((filePath) => {
      const name = path.basename(filePath);
      return `/api/review/images/${task.id}/${encodeURIComponent(name)}`;
    });
    return {
      ...task,
      imageUrls: toUrls(task.reviewImages),
      followupImageUrls: toUrls(task.followupImages),
    };
  }

  #normalizeTask(task) {
    const settings = this.state.settings || DEFAULT_SETTINGS;
    return {
      id: task.id || uid(),
      orderId: String(task.orderId || ''),
      orderTitle: String(task.orderTitle || ''),
      itemUrl: String(task.itemUrl || ''),
      reviewImages: normalizeImageList(task.reviewImages ?? task.images),
      followupImages: normalizeImageList(task.followupImages),
      content: String(task.content || ''),
      followupContent: String(task.followupContent || ''),
      followupDays: clamp(Number(task.followupDays ?? settings.followupDefaultDays), 0, 180),
      rating: clamp(Number(task.rating || settings.rating), 1, 5),
      state: STATES.includes(task.state) ? task.state : 'prepared',
      prevState: task.prevState || null,
      reviewedAt: task.reviewedAt || null,
      followupDueAt: task.followupDueAt || null,
      followupDoneAt: task.followupDoneAt || null,
      lastCheckAt: task.lastCheckAt || null,
      nextCheckAt: task.nextCheckAt || null,
      currentUrl: task.currentUrl || null,
      attempts: Number(task.attempts) || 0,
      lastError: task.lastError || null,
      needsAttentionReason: task.needsAttentionReason || null,
      lastRunId: task.lastRunId || null,
      logs: Array.isArray(task.logs) ? task.logs.slice(-120) : [],
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
    };
  }
}

module.exports = {
  ReviewStore,
  normalizeSettings,
  sanitizeOrderId,
  inQuietHours,
  planFor,
  nextCheckIso,
  addDaysIso,
  DEFAULT_SETTINGS,
  STATES,
};
