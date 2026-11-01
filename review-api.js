'use strict';

// 晒评价的 HTTP 接口。/api/review/*

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function createReviewApi({ root, store, scheduler, sendJson, HttpError }) {
  const imageRoot = path.join(root, 'data', 'review-images');

  function safeName(name) {
    const base = path.basename(String(name || 'image.jpg'));
    return base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80) || 'image.jpg';
  }

  function readRawBody(req, limit = IMAGE_LIMIT) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new HttpError(413, '文件太大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  let lastAutoCheckAt = 0;

  return async function handleReviewApi(req, res, pathname, method, url) {
    if (!pathname.startsWith('/api/review')) return false;

    if (pathname === '/api/review/state' && method === 'GET') {
      sendJson(res, 200, {
        settings: store.settings,
        tasks: store.listTasks(),
        stats: store.stats(),
        rate: store.rateStatus(),
        runner: scheduler.status(),
      });
      return true;
    }

    if (pathname === '/api/review/settings' && method === 'PATCH') {
      const patch = await parseJson(req, HttpError);
      sendJson(res, 200, { settings: store.updateSettings(patch) });
      return true;
    }

    if (pathname === '/api/review/check-now' && method === 'POST') {
      const wait = url.searchParams.get('wait') === '1';
      const auto = url.searchParams.get('auto') === '1';
      if (auto) {
        if (!store.settings.enabled) {
          sendJson(res, 200, { skipped: 'disabled' });
          return true;
        }
        // 打开页面触发的检查：一分钟内只跑一次，避免刷新造成重复执行。
        if (Date.now() - lastAutoCheckAt < 60 * 1000) {
          sendJson(res, 200, { skipped: 'throttled' });
          return true;
        }
        lastAutoCheckAt = Date.now();
      }
      const run = scheduler.tick({ manual: true });
      if (wait) {
        const outcome = await run;
        sendJson(res, 200, { ok: true, ...outcome });
        return true;
      }
      run.catch(() => {});
      sendJson(res, 202, { accepted: true });
      return true;
    }

    if (pathname === '/api/review/fetch-images' && method === 'POST') {
      const body = await parseJson(req, HttpError);
      const url = String(body.url || '').trim();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, '商品链接格式不正确');
      }
      const host = parsed.hostname.toLowerCase();
      const isTaobao = /(^|\.)taobao\.com$|(^|\.)tmall\.com$|(^|\.)tmall\.hk$|(^|\.)tb\.cn$/.test(host);
      const isMock = process.env.REVIEW_MOCK_BASE && (host === '127.0.0.1' || host === 'localhost');
      if (!isTaobao && !isMock) throw new HttpError(400, '只支持淘宝、天猫商品链接');

      const result = await scheduler.runner.fetchImages({
        url,
        sku1: String(body.sku1 || '').trim().slice(0, 40),
        sku2: String(body.sku2 || '').trim().slice(0, 40),
      });

      const images = [];
      for (let index = 0; index < result.images.length && images.length < 8; index += 1) {
        const imageUrl = result.images[index];
        try {
          const response = await fetch(imageUrl, { headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' } });
          if (!response.ok) continue;
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 5 * 1024 * 1024) continue;
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          images.push({
            name: `image-${index + 1}.jpg`,
            dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
          });
        } catch {
          // 单张下载失败就跳过。
        }
      }
      sendJson(res, 200, { images });
      return true;
    }

    if (pathname === '/api/review/import-orders' && method === 'POST') {
      const result = await scheduler.runner.importOrders();
      let imported = 0;
      let skipped = 0;
      for (const order of result.orders || []) {
        if (!order.orderId) continue;
        if (store.getByOrderId(order.orderId)) {
          skipped += 1;
          continue;
        }
        try {
          store.upsertTask({ orderId: order.orderId, orderTitle: order.title || '' });
          imported += 1;
        } catch {
          // 订单号格式不对就跳过。
        }
      }
      sendJson(res, 200, { imported, skipped, scanned: (result.orders || []).length });
      return true;
    }

    if (pathname === '/api/review/tasks' && method === 'POST') {
      const body = await parseJson(req, HttpError);
      const task = store.upsertTask(body);
      sendJson(res, 200, { task });
      return true;
    }

    const taskMatch = pathname.match(/^\/api\/review\/tasks\/([\w-]+)$/);
    if (taskMatch && method === 'PATCH') {
      const body = await parseJson(req, HttpError);
      const task = store.updateTask(taskMatch[1], body);
      if (!task) throw new HttpError(404, '任务不存在');
      sendJson(res, 200, { task });
      return true;
    }
    if (taskMatch && method === 'DELETE') {
      const ok = store.deleteTask(taskMatch[1]);
      if (!ok) throw new HttpError(404, '任务不存在');
      sendJson(res, 200, { ok: true });
      return true;
    }

    const runMatch = pathname.match(/^\/api\/review\/tasks\/([\w-]+)\/run$/);
    if (runMatch && method === 'POST') {
      const task = store.getTask(runMatch[1]);
      if (!task) throw new HttpError(404, '任务不存在');
      const job = scheduler.runOne(task.id).catch(() => {
        // 失败已在 runOne 里写入任务状态。
      });
      const wait = url.searchParams.get('wait') === '1';
      if (wait) {
        const outcome = await job;
        sendJson(res, 200, { ok: true, task: outcome && outcome.task ? outcome.task : store.listTasks().find((item) => item.id === task.id) });
        return true;
      }
      sendJson(res, 202, { accepted: true });
      return true;
    }

    // 立即追评：不等到期，直接把追评时间设为现在并执行。
    const followupMatch = pathname.match(/^\/api\/review\/tasks\/([\w-]+)\/followup$/);
    if (followupMatch && method === 'POST') {
      const task = store.getTask(followupMatch[1]);
      if (!task) throw new HttpError(404, '任务不存在');
      if (!task.reviewedAt) throw new HttpError(400, '这笔订单还没有评价，不能追评');
      if (task.state === 'done') throw new HttpError(400, '这笔订单已经完成追评');
      store.updateTask(task.id, {});
      task.state = 'waiting_followup';
      task.followupDueAt = new Date().toISOString();
      task.lastError = null;
      store.save();
      const job = scheduler.runOne(task.id).catch(() => {});
      const wait = url.searchParams.get('wait') === '1';
      if (wait) {
        const outcome = await job;
        sendJson(res, 200, { ok: true, task: outcome && outcome.task ? outcome.task : store.listTasks().find((item) => item.id === task.id) });
        return true;
      }
      sendJson(res, 202, { accepted: true });
      return true;
    }

    if (pathname === '/api/review/upload' && method === 'POST') {
      const taskId = url.searchParams.get('taskId') || '';
      if (!store.getTask(taskId)) throw new HttpError(404, '任务不存在');
      const name = safeName(url.searchParams.get('name'));
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_TYPES[ext]) throw new HttpError(400, '只支持 jpg / png / webp / gif 图片');
      const buffer = await readRawBody(req);
      if (!buffer.length) throw new HttpError(400, '没有收到文件内容');
      const dir = path.join(imageRoot, taskId);
      fs.mkdirSync(dir, { recursive: true });
      const stored = `${Date.now()}-${name}`;
      const filePath = path.join(dir, stored);
      fs.writeFileSync(filePath, buffer);
      sendJson(res, 200, { path: path.relative(root, filePath).replace(/\\/g, '/'), name: stored });
      return true;
    }

    const imageMatch = pathname.match(/^\/api\/review\/images\/([\w-]+)\/(.+)$/);
    if (imageMatch && method === 'GET') {
      const taskId = imageMatch[1];
      const name = safeName(decodeURIComponent(imageMatch[2]));
      const filePath = path.join(imageRoot, taskId, name);
      if (!filePath.startsWith(path.join(imageRoot, taskId))) throw new HttpError(403, '禁止访问');
      fs.readFile(filePath, (error, buffer) => {
        if (error) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': IMAGE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buffer);
      });
      return true;
    }

    throw new HttpError(404, '接口不存在');
  };
}

function parseJson(req, HttpError) {
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

module.exports = { createReviewApi };
