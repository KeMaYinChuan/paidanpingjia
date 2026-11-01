'use strict';

// 生成晒评价的 ego 脚本。一次运行 = 巡检订单状态 + 按需评价 / 追评。
// 与 ego-driver.js 保持同样的写法：脚本只允许用 ego 暴露的 API。

const path = require('node:path');

function json(value) {
  return JSON.stringify(value);
}

const DEFAULT_URLS = {
  orders: 'https://trade.taobao.com/trade/itemlist/list_bought_items.htm',
  myRate: 'https://rate.taobao.com/myRate.htm',
};

function taskScript({ space, orderId, reviewImages = [], followupImages = [], content = '', followupContent = '', rating = 5, urls = {}, progressPath, resultPath }) {
  const targetUrls = { ...DEFAULT_URLS, ...urls };
  return `'use strict';

const SPACE = ${json(space)};
const ORDER_ID = ${json(orderId)};
const IMAGES = ${json(reviewImages)};
const FOLLOWUP_IMAGES = ${json(followupImages)};
const CONTENT = ${json(content)};
const FOLLOWUP_CONTENT = ${json(followupContent)};
const RATING = ${json(Number(rating) || 5)};
const ORDERS_URL = ${json(targetUrls.orders)};
const RESULT = ${json(resultPath)};
const PROGRESS = ${json(progressPath)};

const fs = await import('node:fs/promises');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logs = [];

async function log(message, level) {
  logs.push({ time: new Date().toISOString(), message, level: level || 'info' });
  try {
    await fs.appendFile(PROGRESS, JSON.stringify({ time: new Date().toISOString(), message, level: level || 'info' }) + '\\n');
  } catch {}
}

async function saveResult(data) {
  const payload = Object.assign({ logs }, data);
  try { await fs.writeFile(RESULT, JSON.stringify(payload)); } catch {}
}

let task = null;
let page = null;

function visible(el) {
  if (!el || !el.isConnected) return false;
  const box = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

async function clickByText(labels, scopeSelector) {
  return page.evaluate((payload) => {
    const wanted = payload.labels;
    const root = payload.scope ? (document.querySelector(payload.scope) || document) : document;
    const vis = (el) => {
      if (!el || !el.isConnected) return false;
      const box = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const nodes = [...root.querySelectorAll('button,a,[role="button"],span,div')].filter((el) => {
      if (!vis(el)) return false;
      const text = (el.innerText || '').trim();
      if (!wanted.includes(text)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width <= 300 && rect.height <= 90;
    });
    nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const hit = nodes[0];
    if (!hit) return null;
    const target = hit.closest('button,a,[role="button"]') || hit;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return (hit.innerText || '').trim();
  }, { labels, scope: scopeSelector || null }).catch(() => null);
}

async function findOrder() {
  return page.evaluate((orderId) => {
    const vis = (el) => {
      if (!el || !el.isConnected) return false;
      const box = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const describe = (row, via) => {
      try { row.setAttribute('data-dsh-order', orderId); } catch {}
      const buttons = [...row.querySelectorAll('button,a,[role="button"],span')]
        .filter((el) => vis(el) && (el.innerText || '').trim().length <= 12)
        .map((el) => (el.innerText || '').trim())
        .filter(Boolean);
      const text = (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 300);
      const has = (word) => buttons.some((btn) => btn.includes(word));
      return {
        found: true,
        via,
        text,
        buttons: [...new Set(buttons)].slice(0, 20),
        hasRate: has('评价') && !has('已评价') && !has('追加'),
        hasRated: has('已评价') || has('查看评价'),
        hasFollowup: has('追加'),
        hasConfirm: has('确认收货'),
        hasFollowed: /已追评/.test(text) || has('已追评'),
      };
    };

    // 优先在「订单行」容器里找，避免把整页按钮当成一单。
    const rows = [...document.querySelectorAll('[data-order-id],[class*="order-item" i],tr,li')]
      .filter((el) => vis(el) && (el.innerText || '').includes(orderId));
    rows.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    for (const row of rows) {
      const anchors = row.querySelectorAll('button,a,[role="button"]');
      if (anchors.length === 0 || anchors.length > 8) continue;
      return describe(row, 'row');
    }

    // 兜底：从包含订单号的最小元素向上找行。
    const all = [...document.querySelectorAll('body *')].filter((el) => vis(el));
    const hits = all.filter((el) => {
      const text = el.textContent || '';
      return text.includes(orderId) && text.length <= 600;
    });
    if (!hits.length) return { found: false };
    hits.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    let row = hits[0];
    for (let i = 0; i < 6; i += 1) {
      if (!row.parentElement) break;
      row = row.parentElement;
      const buttons = row.querySelectorAll('button,a,[role="button"]');
      if (buttons.length > 0 && buttons.length <= 8) break;
      if (row.tagName === 'BODY') break;
    }
    return describe(row, 'fallback');
  }, ORDER_ID).catch(() => ({ found: false }));
}

async function adpotActiveTab() {
  try {
    const tabs = await task.tabs();
    const active = tabs.find((item) => item.active);
    if (active && active.page) {
      page = active.label ? active.page : await task.adopt(active.page);
    }
  } catch {}
}

async function fillStars() {
  const done = await page.evaluate((rating) => {
    const vis = (el) => {
      if (!el || !el.isConnected) return false;
      const box = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const stars = [...document.querySelectorAll('[class*="star" i],[class*="rate" i] i,[class*="score" i]')]
      .filter((el) => vis(el) && el.getBoundingClientRect().width <= 80);
    const groups = new Map();
    for (const el of stars) {
      const parent = el.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(el);
    }
    for (const group of groups.values()) {
      if (group.length >= 4) {
        const target = group[Math.min(rating, group.length) - 1];
        target.scrollIntoView({ block: 'center' });
        (target.closest('[role="radio"],button,li,span') || target).click();
        return true;
      }
    }
    return false;
  }, RATING).catch(() => false);
  if (!done) {
    const label = await clickByText([RATING + '分', '非常满意', '满意']);
    return Boolean(label);
  }
  return true;
}

async function fillText(value) {
  if (!value) return false;
  const ok = await page.evaluate((text) => {
    const vis = (el) => {
      if (!el || !el.isConnected) return false;
      const box = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [...document.querySelectorAll('textarea,[contenteditable="true"],input[placeholder*="评价"],input[placeholder*="说"]')]
      .filter((el) => vis(el) && !el.disabled && !el.readOnly);
    const el = candidates[0];
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') ? Object.getOwnPropertyDescriptor(proto, 'value').set : null;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
    return true;
  }, value).catch(() => false);
  return ok;
}

async function uploadImages(list) {
  const IMAGES = list || [];
  if (!IMAGES.length) return true;
  try {
    const direct = await page.evaluate(() => Boolean(document.querySelector('input[type="file"]'))).catch(() => false);
    if (direct) {
      const inputs = await page.evaluate(() => {
        const list = [...document.querySelectorAll('input[type="file"]')];
        const vis = list.findIndex((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 || el.offsetParent !== null || getComputedStyle(el).visibility !== 'hidden';
        });
        return { count: list.length, index: vis };
      }).catch(() => ({ count: 0, index: -1 }));
      const selector = inputs.count > 1 && inputs.index > 0 ? \`input[type="file"] >> nth=\${inputs.index}\` : 'input[type="file"]';
      await page.setInputFiles(selector, IMAGES);
      return true;
    }
    const chooserPromise = page.waitForFileChooser({ timeout: 8000 }).catch(() => null);
    const clicked = await clickByText(['上传图片', '添加图片', '上传照片', '上传晒图']);
    if (!clicked) return false;
    const chooser = await chooserPromise;
    if (!chooser) return false;
    await chooser.setFiles(IMAGES);
    return true;
  } catch (error) {
    await log('上传图片失败：' + (error && error.message ? error.message : error), 'warn');
    return false;
  }
}

async function submitAndVerify(submitLabels, successWords) {
  const clicked = await clickByText(submitLabels);
  if (!clicked) return { ok: false, reason: '没有找到提交按钮' };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(800);
    const state = await page.evaluate((words) => {
      const text = document.body ? document.body.innerText : '';
      const hit = words.some((word) => text.indexOf(word) >= 0);
      return { hit, url: location.href, snippet: text.replace(/\\s+/g, ' ').slice(0, 100) };
    }, successWords).catch(() => ({ hit: false, url: '', snippet: '' }));
    if (state.hit) return { ok: true, url: state.url };
  }
  const diag = await page.evaluate(() => ({
    url: location.href,
    snippet: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 120),
  })).catch(() => ({ url: '', snippet: '' }));
  return { ok: false, reason: '提交后没有看到成功提示（' + diag.url + '：' + diag.snippet + '）' };
}

async function main() {
  try {
    await log('打开已买到的宝贝');
    task = await taskSpace(SPACE);
    page = task.page('p1');
    await page.goto(ORDERS_URL);
    await page.waitForTimeout(1800 + Math.floor(Math.random() * 1500));

    const url = await page.url().catch(() => '');
    if (/login\\.taobao\\.com/.test(url)) {
      await log('登录已失效', 'warn');
      await saveResult({ state: 'needs_attention', reason: '淘宝登录已失效，请在 ego 里重新登录', currentUrl: url });
      return;
    }

    let found = await findOrder();
    if (!found.found) {
      await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
      found = await findOrder();
    }
    const currentUrl = await page.url().catch(() => null);
    if (!found.found) {
      await log('没有在列表里找到订单 ' + ORDER_ID, 'warn');
      await saveResult({ state: 'needs_attention', reason: '没有找到订单 ' + ORDER_ID + '，请确认订单号或手动处理', currentUrl });
      return;
    }

    if (found.hasFollowed) {
      await log('订单已追评完成');
      await saveResult({ state: 'done', currentUrl });
      return;
    }

    if (found.hasConfirm) {
      await log('订单还未确认收货，等下一轮再查（定位：' + (found.via || '?') + '；按钮：' + (found.buttons || []).join('/') + '；文本：' + String(found.text || '').slice(0, 80) + '）');
      await saveResult({ state: 'waiting_confirm', currentUrl });
      return;
    }

    if (found.hasRate) {
      await log('发现可评价订单，开始评价');
      const clicked = await clickByText(['评价'], '[data-dsh-order="' + ORDER_ID + '"]');
      if (!clicked) {
        await saveResult({ state: 'error', error: '没有点到评价按钮', currentUrl });
        return;
      }
      await sleep(1200 + Math.floor(Math.random() * 1500));
      await adpotActiveTab();
      await page.waitForTimeout(800 + Math.floor(Math.random() * 1000));
      await log('评价页：' + (await page.url().catch(() => '')));
      const starred = await fillStars();
      await log(starred ? '已选择评分' : '没有点到评分星', starred ? 'info' : 'warn');
      const filled = await fillText(CONTENT);
      await log(filled ? '评价文字已填写' : '没有找到评价输入框', filled ? 'info' : 'warn');
      const imagesOk = await uploadImages(IMAGES);
      await log(imagesOk ? '晒图已上传' : '晒图没有上传成功', imagesOk ? 'info' : 'warn');
      await sleep(500 + Math.floor(Math.random() * 1200));
      const submitted = await submitAndVerify(['提交评价', '发表评价', '发布评价', '提交', '确定'], ['评价成功', '发布成功', '提交成功', '已评价']);
      if (!submitted.ok) {
        await saveResult({ state: 'error', error: submitted.reason, currentUrl: await page.url().catch(() => null) });
        return;
      }
      await log('评价已提交');
      await saveResult({ state: 'reviewed', currentUrl: await page.url().catch(() => null) });
      return;
    }

    if (found.hasFollowup) {
      await log('发现可追评订单，开始追评');
      const clicked = await clickByText(['追加评价', '追加'], '[data-dsh-order="' + ORDER_ID + '"]');
      if (!clicked) {
        await saveResult({ state: 'error', error: '没有点到追加评价按钮', currentUrl });
        return;
      }
      await sleep(1200 + Math.floor(Math.random() * 1500));
      await adpotActiveTab();
      await page.waitForTimeout(800 + Math.floor(Math.random() * 1000));
      await fillStars();
      await fillText(FOLLOWUP_CONTENT || CONTENT);
      const followupImagesOk = await uploadImages(FOLLOWUP_IMAGES);
      await log(followupImagesOk ? '追评晒图已上传' : '追评晒图没有上传成功', followupImagesOk ? 'info' : 'warn');
      await sleep(500 + Math.floor(Math.random() * 1200));
      const submitted = await submitAndVerify(['提交追评', '发表追评', '提交', '确定'], ['追评成功', '发布成功', '提交成功', '已追评']);
      if (!submitted.ok) {
        await saveResult({ state: 'error', error: submitted.reason, currentUrl: await page.url().catch(() => null) });
        return;
      }
      await log('追评已提交');
      await saveResult({ state: 'done', currentUrl: await page.url().catch(() => null) });
      return;
    }

    if (found.hasRated) {
      await log('订单已经评价过');
      await saveResult({ state: 'reviewed', currentUrl });
      return;
    }

    await log('订单状态未识别：' + found.buttons.join(' / '), 'warn');
    await saveResult({ state: 'needs_attention', reason: '订单状态未识别：' + found.buttons.join(' / '), currentUrl });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await log('执行失败：' + message, 'error');
    await saveResult({ state: 'error', error: message, currentUrl: page ? await page.url().catch(() => null) : null });
  } finally {
    if (task) {
      const keep = page && page.label ? [page.label] : [];
      await task.finish({ keep }).catch(() => {});
    }
  }
}

await main();
`;
}

// 从商品链接抓取主图和 SKU 图，返回图片 URL 列表。
function fetchImagesScript({ space, url, sku1 = '', sku2 = '', resultPath }) {
  return `'use strict';

const SPACE = ${json(space)};
const URL = ${json(url)};
const SKU1 = ${json(sku1)};
const SKU2 = ${json(sku2)};
const RESULT = ${json(resultPath)};

const fs = await import('node:fs/promises');

async function save(data) {
  try { await fs.writeFile(RESULT, JSON.stringify(data)); } catch {}
}

const task = await taskSpace(SPACE);
const page = task.page('p1');
try {
  await page.goto(URL);
  await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
  const current = await page.url().catch(() => '');
  if (/login\\.taobao\\.com/.test(current)) {
    await save({ state: 'needs_attention', reason: '登录已失效' });
  } else {
    const pick = async (label) => {
      try {
        return await page.evaluate((text) => {
          const vis = (el) => {
            if (!el || !el.isConnected) return false;
            const box = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const nodes = [...document.querySelectorAll('button,li,span,div,a,label')].filter((el) => {
            if (!vis(el)) return false;
            const value = (el.innerText || '').trim();
            return value === text && el.getBoundingClientRect().width <= 200;
          });
          if (!nodes.length) return null;
          nodes[0].click();
          return true;
        }, label);
      } catch {
        return null;
      }
    };
    if (SKU1) { await pick(SKU1); await page.waitForTimeout(600); }
    if (SKU2) { await pick(SKU2); await page.waitForTimeout(800); }

    const images = await page.evaluate(() => {
      const abs = (src) => {
        try { return new URL(src, location.href).href; } catch { return ''; }
      };
      const out = [];
      const add = (src) => {
        const url = abs(src);
        if (!url) return;
        if (!/^https?:/.test(url)) return;
        if (url.startsWith('data:')) return;
        if (!out.includes(url)) out.push(url);
      };
      const main = document.querySelector('#J_ImgBooth') || document.querySelector('img[class*="main" i]') || document.querySelector('meta[property="og:image"]');
      if (main) add(main.src || main.content);
      [...document.querySelectorAll('[class*="thumb" i] img, [class*="gallery" i] img')].slice(0, 6).forEach((img) => add(img.src));
      [...document.querySelectorAll('[class*="sku" i] img, [class*="spec" i] img')].forEach((img) => {
        if (img.getBoundingClientRect().width >= 40) add(img.src);
      });
      return out.slice(0, 8);
    }).catch(() => []);

    await save({ state: 'ok', images, currentUrl: await page.url().catch(() => null) });
  }
} catch (error) {
  await save({ state: 'error', error: error && error.message ? error.message : String(error) });
} finally {
  const keep = page && page.label ? [page.label] : [];
  await task.finish({ keep }).catch(() => {});
}
`;
}

// 扫描「已买到的宝贝」，返回已确认收货的订单列表。
function importOrdersScript({ space, ordersUrl, resultPath }) {
  return `'use strict';

const SPACE = ${json(space)};
const ORDERS_URL = ${json(ordersUrl)};
const RESULT = ${json(resultPath)};

const fs = await import('node:fs/promises');
async function save(data) {
  try { await fs.writeFile(RESULT, JSON.stringify(data)); } catch {}
}

const task = await taskSpace(SPACE);
const page = task.page('p1');
try {
  await page.goto(ORDERS_URL);
  await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
  const current = await page.url().catch(() => '');
  if (/login\\.taobao\\.com/.test(current)) {
    await save({ state: 'needs_attention', reason: '登录已失效' });
  } else {
    const orders = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll('[data-order-id],[class*="order-item" i],tr,li')];
      const found = [];
      const seen = new Set();
      for (const row of rows) {
        const text = clean(row.innerText);
        if (!text) continue;
        const idMatch = text.match(/订单号\\s*[:：]?\\s*([0-9A-Za-z_-]{6,40})/) || text.match(/\\b(\\d{12,24})\\b/);
        const orderId = (row.getAttribute && row.getAttribute('data-order-id')) || (idMatch ? idMatch[1] : '');
        if (!orderId || seen.has(orderId)) continue;
        const buttons = [...row.querySelectorAll('button,a,[role="button"]')].map((el) => clean(el.innerText)).filter(Boolean);
        const hasConfirm = buttons.some((label) => label.includes('确认收货')) || /待收货/.test(text);
        const confirmed = !hasConfirm && (/交易成功|已收货|已评价|待评价|评价/.test(text) || buttons.some((label) => label.includes('评价')));
        if (!confirmed) continue;
        seen.add(orderId);
        const lines = text.split(' ').filter(Boolean);
        const title = lines.find((line) => line.length >= 4 && !line.includes(orderId) && !/订单号|交易成功|已评价|待评价|评价|确认收货/.test(line)) || '';
        found.push({ orderId, title: title.slice(0, 80) });
      }
      return found;
    }).catch(() => []);

    await save({ state: 'ok', orders, currentUrl: await page.url().catch(() => null) });
  }
} catch (error) {
  await save({ state: 'error', error: error && error.message ? error.message : String(error) });
} finally {
  const keep = page && page.label ? [page.label] : [];
  await task.finish({ keep }).catch(() => {});
}
`;
}

module.exports = { taskScript, fetchImagesScript, importOrdersScript, DEFAULT_URLS };
