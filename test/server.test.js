'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paidan-test-'));
  const server = createServer({ dataFile: path.join(dir, 'db.json') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, data, headers: response.headers };
  }

  async function requestBuffer(url) {
    const response = await fetch(`${base}${url}`);
    return {
      status: response.status,
      buffer: Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
    };
  }

  return {
    dir,
    base,
    request,
    requestBuffer,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('派单台核心流程', async (t) => {
  const app = await setup();
  t.after(app.close);

  const health = await app.request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const initial = await app.request('GET', '/api/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.operators.length, 3);
  assert.equal(initial.data.stats.total, 0);

  const created = await app.request('POST', '/api/orders', {
    taobaoOrderNo: 'TB-10001',
    shop: '测试店铺',
    product: '测试商品 A',
    sku: '白色 / M',
    buyerNick: 'buyer_a',
    amount: '88.50',
    receiver: '张三',
    region: '浙江 杭州',
    priority: '加急',
    dueDate: '2026-11-03',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.order.amount, 88.5);
  assert.equal(created.data.order.status, '待派单');

  const duplicate = await app.request('POST', '/api/orders', {
    taobaoOrderNo: 'TB-10001',
    product: '重复订单',
  });
  assert.equal(duplicate.status, 409);

  const imported = await app.request('POST', '/api/orders/import', {
    orders: [
      { taobaoOrderNo: 'TB-10001', product: '重复订单' },
      {
        taobaoOrderNo: 'TB-10002',
        product: '测试商品 B',
        buyerNick: 'buyer_b',
        amount: '120',
        dueDate: '2026-11-02',
      },
      {
        taobaoOrderNo: 'TB-10003',
        product: '测试商品 C',
        buyerNick: 'buyer_c',
        amount: '45.9',
        priority: '加急',
      },
    ],
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.imported, 2);
  assert.equal(imported.data.skipped, 1);
  assert.equal(imported.data.state.stats.total, 3);

  const assigned = await app.request('POST', '/api/orders/auto-assign', {});
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.assigned, 3);
  const assignedOrders = assigned.data.state.orders;
  assert.ok(assignedOrders.every((order) => order.operatorId));
  assert.ok(assignedOrders.every((order) => order.status === '待拍摄'));
  const loads = assigned.data.state.operators.map((operator) => operator.load).sort();
  assert.deepEqual(loads, [1, 1, 1]);

  const first = assignedOrders.find((order) => order.taobaoOrderNo === 'TB-10001');
  const patched = await app.request('PATCH', `/api/orders/${first.id}`, {
    status: '已完成',
    note: '已验收',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.order.status, '已完成');
  assert.equal(patched.data.state.stats.done, 1);

  const exported = await app.requestBuffer('/api/export.csv');
  assert.equal(exported.status, 200);
  assert.deepEqual([...exported.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const exportedText = exported.buffer.toString('utf8');
  assert.match(exportedText, /测试商品 A/);
  assert.match(exportedText, /TB-10002/);

  const operator = await app.request('POST', '/api/operators', { name: '测试执行人' });
  assert.equal(operator.status, 201);
  const newOperatorId = operator.data.operator.id;
  const renamed = await app.request('PATCH', `/api/operators/${newOperatorId}`, {
    name: '测试执行人-改',
    active: false,
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.operator.name, '测试执行人-改');
  assert.equal(renamed.data.operator.active, false);

  const removed = await app.request('DELETE', `/api/operators/${newOperatorId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.state.operators.length, 3);
});
