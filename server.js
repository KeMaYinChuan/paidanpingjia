'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_DATA_FILE = path.join(DATA_DIR, 'db.json');
const DEFAULT_PORT = Number(process.env.PORT || 4321);

const STATUSES = ['待派单', '待拍摄', '待回传', '待验收', '已完成', '异常'];
const PRIORITIES = ['普通', '加急'];
const ACTIVE_STATUSES = new Set(['待拍摄', '待回传', '待验收', '异常']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function defaultData() {
  const createdAt = nowIso();
  return {
    version: 1,
    operators: [
      { id: uid(), name: '运营一号', active: true, createdAt },
      { id: uid(), name: '视觉一号', active: true, createdAt },
      { id: uid(), name: '客服一号', active: true, createdAt },
    ],
    orders: [],
    activities: [],
  };
}

function ensureDataDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function loadData(file) {
  ensureDataDir(file);
  if (!fs.existsSync(file)) {
    const data = defaultData();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: 1,
      operators: Array.isArray(parsed.operators) ? parsed.operators : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      activities: Array.isArray(parsed.activities) ? parsed.activities : [],
    };
  } catch (error) {
    throw new Error(`数据文件读取失败：${file} (${error.message})`);
  }
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = loadData(file);
  }

  save() {
    ensureDataDir(this.file);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  log(action, detail) {
    this.data.activities.unshift({
      id: uid(),
      action,
      detail,
      at: nowIso(),
    });
    this.data.activities = this.data.activities.slice(0, 200);
  }

  operator(id) {
    return this.data.operators.find((item) => item.id === id) || null;
  }

  order(id) {
    return this.data.orders.find((item) => item.id === id) || null;
  }

  operatorLoad(operatorId) {
    return this.data.orders.filter(
      (order) => order.operatorId === operatorId && order.status !== '已完成',
    ).length;
  }

  stats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const total = this.data.orders.length;
    const pending = this.data.orders.filter((o) => o.status === '待派单').length;
    const processing = this.data.orders.filter((o) =>
      ['待拍摄', '待回传', '待验收'].includes(o.status),
    ).length;
    const done = this.data.orders.filter((o) => o.status === '已完成').length;
    const overdue = this.data.orders.filter((o) => {
      if (!o.dueDate || o.status === '已完成') return false;
      const due = new Date(`${o.dueDate}T23:59:59`);
      return due.getTime() < today.getTime();
    }).length;
    return { total, pending, processing, done, overdue };
  }

  publicState() {
    const operators = this.data.operators.map((operator) => ({
      ...operator,
      load: this.operatorLoad(operator.id),
      done: this.data.orders.filter(
        (order) => order.operatorId === operator.id && order.status === '已完成',
      ).length,
    }));

    return {
      orders: this.data.orders,
      operators,
      activities: this.data.activities.slice(0, 30),
      stats: this.stats(),
    };
  }
}

function normalizeOrder(input, existing = {}) {
  const amountRaw = input.amount ?? existing.amount ?? 0;
  const amount = Number(String(amountRaw).replace(/[¥￥,\s]/g, '')) || 0;
  const dueDate = cleanText(input.dueDate ?? existing.dueDate, 10);
  const status = STATUSES.includes(input.status) ? input.status : existing.status || '待派单';
  const priority = PRIORITIES.includes(input.priority)
    ? input.priority
    : existing.priority || '普通';

  return {
    taobaoOrderNo: cleanText(input.taobaoOrderNo ?? existing.taobaoOrderNo, 80),
    shop: cleanText(input.shop ?? existing.shop, 120),
    product: cleanText(input.product ?? existing.product, 240),
    sku: cleanText(input.sku ?? existing.sku, 160),
    buyerNick: cleanText(input.buyerNick ?? existing.buyerNick, 120),
    amount,
    receiver: cleanText(input.receiver ?? existing.receiver, 120),
    region: cleanText(input.region ?? existing.region, 160),
    operatorId: cleanText(input.operatorId ?? existing.operatorId, 80) || null,
    status,
    priority,
    dueDate,
    note: cleanText(input.note ?? existing.note, 1000),
  };
}

function orderFromBody(body, existing) {
  const normalized = normalizeOrder(body, existing);
  if (!normalized.product && !normalized.taobaoOrderNo) {
    throw new HttpError(400, '请至少填写商品名称或淘宝订单号');
  }
  if (normalized.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.dueDate)) {
    throw new HttpError(400, '截止日期格式应为 YYYY-MM-DD');
  }
  if (normalized.operatorId && !existing?.operatorId && !body.status) {
    normalized.status = '待拍摄';
  }
  return normalized;
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
      if (size > 2 * 1024 * 1024) {
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
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  sendJson(res, status, { error: error.message || '服务器错误' });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function buildCsv(store) {
  const header = [
    '淘宝订单号',
    '店铺',
    '商品名称',
    'SKU',
    '买家昵称',
    '实付金额',
    '收货人',
    '地区',
    '执行人',
    '状态',
    '优先级',
    '截止日期',
    '备注',
    '创建时间',
    '更新时间',
  ];
  const rows = store.data.orders.map((order) => {
    const operator = store.operator(order.operatorId);
    return csvRow([
      order.taobaoOrderNo,
      order.shop,
      order.product,
      order.sku,
      order.buyerNick,
      Number(order.amount || 0).toFixed(2),
      order.receiver,
      order.region,
      operator?.name || '',
      order.status,
      order.priority,
      order.dueDate,
      order.note,
      order.createdAt,
      order.updatedAt,
    ]);
  });
  return `\ufeff${header.map(csvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

function sortOrders(orders) {
  const statusRank = {
    异常: 0,
    待派单: 1,
    待拍摄: 2,
    待回传: 3,
    待验收: 4,
    已完成: 9,
  };
  return [...orders].sort((a, b) => {
    const rank = (statusRank[a.status] ?? 5) - (statusRank[b.status] ?? 5);
    if (rank) return rank;
    if (a.priority !== b.priority) return a.priority === '加急' ? -1 : 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
  });
}

function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  const store = new Store(dataFile);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, time: nowIso() });
      }

      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, store.publicState());
      }

      if (pathname === '/api/export.csv' && method === 'GET') {
        const csv = buildCsv(store);
        const fileName = `派单数据_${new Date().toISOString().slice(0, 10)}.csv`;
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'no-store',
        });
        return res.end(csv);
      }

      if (pathname === '/api/operators' && method === 'POST') {
        const body = await parseBody(req);
        const name = cleanText(body.name, 40);
        if (!name) throw new HttpError(400, '请填写执行人名称');
        if (
          store.data.operators.some(
            (operator) => operator.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          throw new HttpError(409, '执行人名称已存在');
        }
        const operator = { id: uid(), name, active: true, createdAt: nowIso() };
        store.data.operators.push(operator);
        store.log('新增执行人', name);
        store.save();
        return sendJson(res, 201, { operator, state: store.publicState() });
      }

      const operatorMatch = pathname.match(/^\/api\/operators\/([^/]+)$/);
      if (operatorMatch) {
        const operator = store.operator(decodeURIComponent(operatorMatch[1]));
        if (!operator) throw new HttpError(404, '执行人不存在');

        if (method === 'PATCH') {
          const body = await parseBody(req);
          if (body.name !== undefined) {
            const name = cleanText(body.name, 40);
            if (!name) throw new HttpError(400, '执行人名称不能为空');
            const duplicate = store.data.operators.some(
              (item) =>
                item.id !== operator.id && item.name.toLowerCase() === name.toLowerCase(),
            );
            if (duplicate) throw new HttpError(409, '执行人名称已存在');
            operator.name = name;
          }
          if (body.active !== undefined) operator.active = Boolean(body.active);
          store.log('更新执行人', operator.name);
          store.save();
          return sendJson(res, 200, { operator, state: store.publicState() });
        }

        if (method === 'DELETE') {
          const assigned = store.data.orders.filter(
            (order) => order.operatorId === operator.id && order.status !== '已完成',
          );
          if (assigned.length > 0) {
            throw new HttpError(409, `该执行人还有 ${assigned.length} 个未完成任务，请先转派`);
          }
          store.data.operators = store.data.operators.filter(
            (item) => item.id !== operator.id,
          );
          store.data.orders.forEach((order) => {
            if (order.operatorId === operator.id) order.operatorId = null;
          });
          store.log('删除执行人', operator.name);
          store.save();
          return sendJson(res, 200, { state: store.publicState() });
        }
      }

      if (pathname === '/api/orders' && method === 'POST') {
        const body = await parseBody(req);
        const normalized = orderFromBody(body);
        if (normalized.taobaoOrderNo) {
          const duplicate = store.data.orders.find(
            (order) => order.taobaoOrderNo === normalized.taobaoOrderNo,
          );
          if (duplicate) throw new HttpError(409, '该淘宝订单号已存在');
        }
        const timestamp = nowIso();
        const order = {
          id: uid(),
          ...normalized,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.data.orders.push(order);
        store.log('新增订单', order.product || order.taobaoOrderNo);
        store.save();
        return sendJson(res, 201, { order, state: store.publicState() });
      }

      if (pathname === '/api/orders/import' && method === 'POST') {
        const body = await parseBody(req);
        const list = Array.isArray(body.orders) ? body.orders : [];
        if (!list.length) throw new HttpError(400, '没有可导入的订单');
        if (list.length > 2000) throw new HttpError(400, '单次最多导入 2000 条');

        const existingNos = new Set(
          store.data.orders.map((order) => order.taobaoOrderNo).filter(Boolean),
        );
        const timestamp = nowIso();
        let imported = 0;
        let skipped = 0;
        for (const raw of list) {
          let normalized;
          try {
            normalized = orderFromBody(raw);
          } catch {
            skipped += 1;
            continue;
          }
          if (normalized.taobaoOrderNo && existingNos.has(normalized.taobaoOrderNo)) {
            skipped += 1;
            continue;
          }
          if (normalized.taobaoOrderNo) existingNos.add(normalized.taobaoOrderNo);
          store.data.orders.push({
            id: uid(),
            ...normalized,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          imported += 1;
        }
        store.log('导入订单', `成功 ${imported} 条，跳过 ${skipped} 条`);
        store.save();
        return sendJson(res, 201, {
          imported,
          skipped,
          state: store.publicState(),
        });
      }

      if (pathname === '/api/orders/auto-assign' && method === 'POST') {
        const body = await parseBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : null;
        const operators = store.data.operators.filter((operator) => operator.active);
        if (!operators.length) throw new HttpError(400, '请先添加并启用至少一个执行人');

        const candidates = sortOrders(
          store.data.orders.filter((order) => {
            if (ids && !ids.includes(order.id)) return false;
            if (order.status === '已完成') return false;
            return order.status === '待派单' || !order.operatorId;
          }),
        );
        if (!candidates.length) {
          return sendJson(res, 200, {
            assigned: 0,
            message: '没有待派单的订单',
            state: store.publicState(),
          });
        }

        const loads = new Map(
          operators.map((operator) => [operator.id, store.operatorLoad(operator.id)]),
        );
        const assignments = [];
        for (const order of candidates) {
          const target = [...operators].sort((a, b) => {
            const diff = (loads.get(a.id) || 0) - (loads.get(b.id) || 0);
            return diff || a.name.localeCompare(b.name, 'zh-CN');
          })[0];
          order.operatorId = target.id;
          if (order.status === '待派单') order.status = '待拍摄';
          order.updatedAt = nowIso();
          loads.set(target.id, (loads.get(target.id) || 0) + 1);
          assignments.push({ orderId: order.id, operatorId: target.id });
        }
        store.log('自动派单', `分配 ${assignments.length} 个订单`);
        store.save();
        return sendJson(res, 200, {
          assigned: assignments.length,
          assignments,
          state: store.publicState(),
        });
      }

      const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (orderMatch) {
        const order = store.order(decodeURIComponent(orderMatch[1]));
        if (!order) throw new HttpError(404, '订单不存在');

        if (method === 'PATCH') {
          const body = await parseBody(req);
          if (body.operatorId !== undefined && body.operatorId) {
            if (!store.operator(body.operatorId)) throw new HttpError(400, '执行人不存在');
          }
          if (body.status !== undefined && !STATUSES.includes(body.status)) {
            throw new HttpError(400, '状态不正确');
          }
          if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
            throw new HttpError(400, '优先级不正确');
          }
          const updated = orderFromBody(body, order);
          if (
            updated.taobaoOrderNo &&
            store.data.orders.some(
              (item) =>
                item.id !== order.id && item.taobaoOrderNo === updated.taobaoOrderNo,
            )
          ) {
            throw new HttpError(409, '该淘宝订单号已存在');
          }
          const changes = [];
          if (body.status && body.status !== order.status) {
            changes.push(`${order.status} → ${body.status}`);
          }
          if (body.operatorId !== undefined && body.operatorId !== order.operatorId) {
            changes.push(`转派给 ${store.operator(body.operatorId)?.name || '未分配'}`);
          }
          Object.assign(order, updated, { updatedAt: nowIso() });
          if (order.operatorId && order.status === '待派单') order.status = '待拍摄';
          store.log('更新订单', `${order.product || order.taobaoOrderNo}${changes.length ? `（${changes.join('，')}）` : ''}`);
          store.save();
          return sendJson(res, 200, { order, state: store.publicState() });
        }

        if (method === 'DELETE') {
          store.data.orders = store.data.orders.filter((item) => item.id !== order.id);
          store.log('删除订单', order.product || order.taobaoOrderNo);
          store.save();
          return sendJson(res, 200, { state: store.publicState() });
        }
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

function openBrowser(url) {
  if (process.env.AUTO_OPEN !== '1') return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opening the browser is optional; the server should keep running.
  }
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${DEFAULT_PORT}`;
    console.log(`派单台已启动：${url}`);
    console.log(`数据文件：${process.env.DATA_FILE || DEFAULT_DATA_FILE}`);
    openBrowser(url);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${DEFAULT_PORT} 已被占用。若服务已经启动，直接打开 http://127.0.0.1:${DEFAULT_PORT}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
}

module.exports = {
  createServer,
  Store,
  buildCsv,
  normalizeOrder,
  STATUSES,
  PRIORITIES,
};
