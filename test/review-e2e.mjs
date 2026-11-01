'use strict';

// 晒评价端到端测试：用 mock 页面在 ego 里跑通「待收货 / 评价 / 追评」三条链路。
// 用法：node test/review-e2e.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve('.');
const port = 4324;
const base = `http://127.0.0.1:${port}`;
const imagePath = path.join(root, 'docs', 'quick-ui.png');

const server = spawn(process.execPath, ['quick-server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), REVIEW_MOCK_BASE: base, REVIEW_FAST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function req(pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} -> ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitHealth() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const health = await req('/api/health', { method: 'GET' });
      if (health.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('服务没有启动');
}

async function findTask(orderId) {
  const state = await req('/api/review/state', { method: 'GET' });
  return (state.tasks || []).find((task) => task.orderId === orderId);
}

async function main() {
  await waitHealth();
  console.log('health ok');
  await req('/api/mock/reset', { method: 'POST' });

  const results = [];
  const created = [];

  try {
    // 一键同步：只同步已确认收货的订单（mock 里 200201 待收货，应跳过）
    const imported = await req('/api/review/import-orders', { method: 'POST' });
    console.log('import', JSON.stringify(imported));
    results.push({ name: '同步已收货订单', got: `${imported.imported}/${imported.skipped}`, expect: '2/0' });

    // 抓取主图 / SKU 图
    const fetched = await req('/api/review/fetch-images', {
      method: 'POST',
      body: JSON.stringify({ url: `${base}/__mock-product-2level.html`, sku1: '白色', sku2: 'M' }),
    });
    console.log('fetched images', fetched.images.length);
    results.push({ name: '抓取主图/SKU图', got: fetched.images.length >= 2, expect: true });
    // 场景一：待收货
    const t1 = (await req('/api/review/tasks', {
      method: 'POST',
      body: JSON.stringify({ orderId: '200201', content: '测试评价' }),
    })).task;
    created.push(t1.id);

    // 场景二：待评价 → 追评（followupDays=0，评价完立刻到期）
    const t2 = (await req('/api/review/tasks', {
      method: 'POST',
      body: JSON.stringify({
        orderId: '200202',
        content: '测试评价内容',
        followupContent: '测试追评内容',
        followupDays: 0,
        images: [imagePath],
        followupImages: [imagePath],
      }),
    })).task;
    created.push(t2.id);

    // 场景三：已评价、可追评
    const t3 = (await req('/api/review/tasks', {
      method: 'POST',
      body: JSON.stringify({ orderId: '200203', followupContent: '直接追评内容', followupDays: 0 }),
    })).task;
    created.push(t3.id);

    console.log('created', created.length, 'tasks');

    // 立即追评：还没评价时应被拒绝
    const early = await fetch(`${base}/api/review/tasks/${t3.id}/followup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    console.log('followup-before-review status', early.status);
    results.push({ name: '未评价不能立即追评', got: early.status, expect: 400 });

    // 第一轮巡检：200201 待收货、200202 评价、200203 追评（都在一轮里串行跑）
    let outcome = await req('/api/review/check-now?wait=1', { method: 'POST' });
    console.log('tick1', JSON.stringify(outcome));
    const afterTick = await findTask('200202');
    results.push({ name: '一次触发完成评价+追评', got: afterTick.state, expect: 'done' });

    const first1 = await findTask('200201');
    results.push({ name: '待收货', got: first1.state, expect: 'waiting_confirm' });

    // 第二、三轮：把评价后到期的追评跑掉
    for (let i = 0; i < 3; i += 1) {
      const t = await findTask('200202');
      const u = await findTask('200203');
      if ((t.state === 'done' || t.state === 'error' || t.state === 'needs_attention')
        && (u.state === 'done' || u.state === 'error' || u.state === 'needs_attention')) break;
      const tick = await req('/api/review/check-now?wait=1', { method: 'POST' });
      console.log(`tick${i + 2}`, JSON.stringify(tick));
    }

    const final2 = await findTask('200202');
    const final3 = await findTask('200203');
    results.push({ name: '评价后追评', got: final2.state, expect: 'done' });
    results.push({ name: '直接追评', got: final3.state, expect: 'done' });

    console.log('\n--- 任务最终状态 ---');
    console.log('200201:', JSON.stringify({ state: first1.state, logs: (first1.logs || []).slice(-3) }, null, 0));
    console.log('200202:', JSON.stringify({ state: final2.state, reviewedAt: final2.reviewedAt, followupDueAt: final2.followupDueAt, logs: (final2.logs || []).slice(-5) }, null, 0));
    console.log('200203:', JSON.stringify({ state: final3.state, logs: (final3.logs || []).slice(-4) }, null, 0));

    let failed = false;
    for (const item of results) {
      const ok = item.got === item.expect;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${item.name}: got=${item.got} expect=${item.expect}`);
      if (!ok) failed = true;
    }
    if (failed) process.exitCode = 1;
  } finally {
    for (const id of created) {
      await req(`/api/review/tasks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    server.kill();
  }
}

try {
  await main();
} catch (error) {
  console.error('E2E_ERROR', error.message);
  server.kill();
  process.exitCode = 1;
}
