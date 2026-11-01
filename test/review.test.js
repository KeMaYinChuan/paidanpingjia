'use strict';

process.env.REVIEW_FAST = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ReviewStore,
  normalizeSettings,
  sanitizeOrderId,
  inQuietHours,
  planFor,
  addDaysIso,
  DEFAULT_SETTINGS,
} = require('../review-store');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paidan-review-'));
}

test('设置会被夹到合理范围', () => {
  const settings = normalizeSettings({
    checkIntervalMinutes: 1,
    followupDefaultDays: 999,
    maxImagesPerReview: 99,
    quietHours: { start: '25:00', end: '08:00' },
  });
  assert.equal(settings.checkIntervalMinutes, 5);
  assert.equal(settings.followupDefaultDays, 180);
  assert.equal(settings.maxImagesPerReview, 5);
  assert.equal(settings.quietHours.start, DEFAULT_SETTINGS.quietHours.start);
});

test('订单号校验', () => {
  assert.equal(sanitizeOrderId(' 3456789012345678901 '), '3456789012345678901');
  assert.equal(sanitizeOrderId('abc12345'), 'abc12345');
  assert.equal(sanitizeOrderId('12'), null);
  assert.equal(sanitizeOrderId('a b c'), null);
  assert.equal(sanitizeOrderId(''), null);
});

test('静音时段支持跨午夜', () => {
  const settings = normalizeSettings({ quietHours: { start: '23:30', end: '08:00' } });
  assert.equal(inQuietHours(settings, new Date('2026-10-31T23:45:00+08:00').getTime()), true);
  assert.equal(inQuietHours(settings, new Date('2026-11-01T02:00:00+08:00').getTime()), true);
  assert.equal(inQuietHours(settings, new Date('2026-11-01T09:00:00+08:00').getTime()), false);
  const day = normalizeSettings({ quietHours: { start: '12:00', end: '13:00' } });
  assert.equal(inQuietHours(day, new Date('2026-11-01T12:30:00+08:00').getTime()), true);
  assert.equal(inQuietHours(day, new Date('2026-11-01T13:30:00+08:00').getTime()), false);
});

test('到期计划：巡检、追评、过期', () => {
  const settings = normalizeSettings({ checkIntervalMinutes: 30 });
  const now = Date.parse('2026-11-01T10:00:00+08:00');

  assert.equal(planFor({ state: 'prepared' }, settings, now), 'probe');
  assert.equal(planFor({ state: 'waiting_confirm', nextCheckAt: new Date(now + 60_000).toISOString() }, settings, now), null);
  assert.equal(planFor({ state: 'waiting_confirm', nextCheckAt: new Date(now - 60_000).toISOString() }, settings, now), 'probe');
  assert.equal(planFor({ state: 'paused' }, settings, now), null);
  assert.equal(planFor({ state: 'done' }, settings, now), null);
  assert.equal(planFor({ state: 'needs_attention' }, settings, now), null);

  const reviewedAt = new Date(now - 4 * 86400_000).toISOString();
  assert.equal(planFor({ state: 'reviewed', reviewedAt, followupDueAt: new Date(now + 86400_000).toISOString() }, settings, now), null);
  assert.equal(planFor({ state: 'waiting_followup', reviewedAt, followupDueAt: new Date(now - 1000).toISOString() }, settings, now), 'followup');

  const oldReviewed = new Date(now - 200 * 86400_000).toISOString();
  assert.equal(planFor({ state: 'waiting_followup', reviewedAt: oldReviewed, followupDueAt: new Date(now - 86400_000).toISOString() }, settings, now), 'expire');
});

test('任务增删改查与状态流转', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();

  const created = store.upsertTask({
    orderId: '200200',
    orderTitle: '示例商品',
    content: '很好',
    followupContent: '补一句',
    followupDays: 3,
  });
  assert.equal(created.state, 'prepared');
  assert.equal(store.stats().total, 1);

  const same = store.upsertTask({ orderId: '200200', content: '改一下' });
  assert.equal(store.stats().total, 1);
  assert.equal(same.content, '改一下');
  assert.equal(store.listTasks()[0].content, '改一下');

  assert.throws(() => store.upsertTask({ orderId: '1' }), /订单号格式不正确/);

  const updated = store.updateTask(created.id, { action: 'pause' });
  assert.equal(updated.state, 'paused');
  const resumed = store.updateTask(created.id, { action: 'resume' });
  assert.equal(resumed.state, 'prepared');

  store.applyResult(created.id, { state: 'waiting_confirm' });
  let task = store.getTask(created.id);
  assert.equal(task.state, 'waiting_confirm');
  assert.ok(task.nextCheckAt);

  store.applyResult(created.id, { state: 'reviewed' });
  task = store.getTask(created.id);
  assert.equal(task.state, 'waiting_followup');
  assert.equal(task.followupDueAt, addDaysIso(task.reviewedAt, 3));

  store.applyResult(created.id, { state: 'done' });
  task = store.getTask(created.id);
  assert.equal(task.state, 'done');
  assert.ok(task.followupDoneAt);

  assert.equal(store.deleteTask(created.id), true);
  assert.equal(store.stats().total, 0);
});

test('失败会退避重试，三次后进入失败', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  const task = store.upsertTask({ orderId: '200300', content: 'x' });

  store.applyResult(task.id, { state: 'error', error: '第一次' });
  let current = store.getTask(task.id);
  assert.equal(current.state, 'waiting_confirm');
  assert.equal(current.attempts, 1);
  assert.ok(current.nextCheckAt);

  store.applyResult(task.id, { state: 'error', error: '第二次' });
  store.applyResult(task.id, { state: 'error', error: '第三次' });
  current = store.getTask(task.id);
  assert.equal(current.state, 'error');
  assert.equal(current.attempts, 3);
});

test('需要人工处理与过期状态', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  const task = store.upsertTask({ orderId: '200400' });

  store.applyResult(task.id, { state: 'needs_attention', reason: '验证码' });
  let current = store.getTask(task.id);
  assert.equal(current.state, 'needs_attention');
  assert.equal(current.needsAttentionReason, '验证码');

  const retried = store.updateTask(task.id, { action: 'retry' });
  assert.equal(retried.state, 'prepared');

  store.applyResult(task.id, { state: 'expired', error: '超过追评窗口' });
  assert.equal(store.getTask(task.id).state, 'expired');
});

test('首次晒图和追评晒图分开限制数量', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  store.updateSettings({ maxImagesPerReview: 2, maxImagesPerFollowup: 1 });
  assert.throws(
    () => store.upsertTask({ orderId: '200500', reviewImages: ['a.jpg', 'b.jpg', 'c.jpg'] }),
    /首次晒图最多 2 张/,
  );
  assert.throws(
    () => store.upsertTask({ orderId: '200501', followupImages: ['a.jpg', 'b.jpg'] }),
    /追评晒图最多 1 张/,
  );
  const task = store.upsertTask({
    orderId: '200600',
    reviewImages: ['a.jpg', 'b.jpg'],
    followupImages: ['c.jpg'],
  });
  assert.deepEqual(task.reviewImages, ['a.jpg', 'b.jpg']);
  assert.deepEqual(task.followupImages, ['c.jpg']);
  assert.deepEqual(task.imageUrls, [
    `/api/review/images/${task.id}/a.jpg`,
    `/api/review/images/${task.id}/b.jpg`,
  ]);
  assert.deepEqual(task.followupImageUrls, [`/api/review/images/${task.id}/c.jpg`]);
});

test('旧版 images 字段会迁移成首次晒图', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  const task = store.upsertTask({ orderId: '200601', images: ['old.jpg'] });
  assert.deepEqual(task.reviewImages, ['old.jpg']);
  assert.deepEqual(task.followupImages, []);
});

test('每小时/每天执行频率限制', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  store.updateSettings({ hourlyLimit: 2, dailyLimit: 3 });
  const now = Date.now();

  assert.equal(store.rateStatus(now).allowed, true);
  store.recordRun(now - 10 * 60 * 1000);
  store.recordRun(now - 20 * 60 * 1000);
  let rate = store.rateStatus(now);
  assert.equal(rate.hour, 2);
  assert.equal(rate.allowed, false);

  // 三小时前的记录不占每小时名额，但占每天名额
  const later = now + 3 * 60 * 60 * 1000;
  rate = store.rateStatus(later);
  assert.equal(rate.hour, 0);
  assert.equal(rate.day, 2);
  assert.equal(rate.allowed, true);

  store.recordRun(later - 1000);
  store.recordRun(later - 2000);
  rate = store.rateStatus(later);
  assert.equal(rate.day, 4);
  assert.equal(rate.allowed, false);
});

test('一次触发会处理所有到期任务，且尊重任务锁', async () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  const lock = require('../runner-lock');
  const { ReviewScheduler } = require('../review-scheduler');
  const scheduler = new ReviewScheduler({ root, store, lock });
  scheduler.runner.runTask = async (id) => {
    store.applyResult(id, { state: 'waiting_confirm' });
    return { task: store.getTask(id) };
  };

  const a = store.upsertTask({ orderId: '300001' });
  const b = store.upsertTask({ orderId: '300002' });
  const c = store.upsertTask({ orderId: '300003' });

  lock.acquire('order');
  const busy = await scheduler.tick({ manual: true });
  assert.equal(busy.busy, true);
  assert.equal(store.getTask(a.id).state, 'prepared');
  lock.release('order');

  const out = await scheduler.tick({ manual: true });
  assert.equal(out.processed.length, 3);
  for (const task of [a, b, c]) {
    assert.equal(store.getTask(task.id).state, 'waiting_confirm');
  }
});

test('数据写入后可重新加载', () => {
  const root = tempRoot();
  const store = new ReviewStore(root);
  store.load();
  const task = store.upsertTask({ orderId: '200700', content: '持久化' });
  store.updateSettings({ checkIntervalMinutes: 60 });

  const again = new ReviewStore(root);
  again.load();
  assert.equal(again.getTask(task.id).content, '持久化');
  assert.equal(again.settings.checkIntervalMinutes, 60);
});
