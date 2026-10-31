'use strict';

const path = require('node:path');

function json(value) {
  return JSON.stringify(value);
}

function orderScript({ space, url, sku, quantity, autoSubmit, progressPath, resultPath }) {
  return `'use strict';

const SPACE = ${json(space)};
const PRODUCT_URL = ${json(url)};
const SKU = ${json(sku)};
const QUANTITY = ${json(quantity)};
const AUTO_SUBMIT = ${json(Boolean(autoSubmit))};
const PROGRESS = ${json(progressPath)};
const RESULT = ${json(resultPath)};
const BUY_LABELS = ['立即购买', '马上抢', '领券购买', '立即抢购', '立即订购'];
const SUBMIT_LABELS = ['提交订单', '确认下单'];

const fs = await import('node:fs/promises');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function log(message, level = 'info', extra = {}) {
  await fs.appendFile(PROGRESS, JSON.stringify({ time: new Date().toISOString(), message, level, ...extra }) + '\\n');
}

async function saveResult(data) {
  await fs.writeFile(RESULT, JSON.stringify(data));
}

function normalizeParts(value) {
  return [...new Set(
    String(value || '')
      .split(/[\\/,，、|>]+/)
      .map((part) => part.trim())
      .filter(Boolean),
  )];
}

async function main() {
  let task = null;
  let page = null;
  try {
    await log('正在启动 ego 浏览器…', 'info', { stage: 'launching' });
    task = await taskSpace(SPACE);
    page = task.page('p1');
    await log('浏览器已打开', 'info', { stage: 'opening' });

    await page.goto(PRODUCT_URL);
    await log('商品页已打开', 'info', { stage: 'opening', currentUrl: await page.url() });

    const hasLabel = async (labels) =>
      page.evaluate((wanted) => {
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const box = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
        };
        return [...document.querySelectorAll('button,a,[role="button"],div,span')].some((el) => {
          const text = (el.innerText || '').trim();
          return wanted.includes(text) && visible(el) && el.getBoundingClientRect().width <= 420;
        });
      }, labels);

    const clickLabel = async (labels) =>
      page.evaluate((wanted) => {
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const box = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
        };
        const hits = [...document.querySelectorAll('button,a,[role="button"],div,span')].filter((el) => {
          const text = (el.innerText || '').trim();
          return wanted.includes(text) && visible(el) && el.getBoundingClientRect().width <= 420;
        });
        hits.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
        const hit = hits[0];
        if (!hit) return null;
        const target = hit.closest('button,a,[role="button"]') || hit;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return (hit.innerText || '').trim();
      }, labels);

    let ready = false;
    const readyDeadline = Date.now() + 10000;
    while (Date.now() < readyDeadline) {
      if (await hasLabel(BUY_LABELS)) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (!ready) {
      await log('需要登录或完成页面验证，请在 ego 浏览器里操作；完成后会自动继续', 'warn', {
        status: 'login_required',
        stage: 'login',
      });
      const loginDeadline = Date.now() + 240000;
      while (Date.now() < loginDeadline) {
        if (await hasLabel(BUY_LABELS)) {
          ready = true;
          break;
        }
        await sleep(1500);
      }
    }
    if (!ready) throw new Error('等待登录超时，请重新开始');

    await log('正在选择 SKU…', 'info', { stage: 'selecting_sku', status: 'running' });
    const parts = normalizeParts(SKU);
    let picked = 0;
    for (const part of parts) {
      const result = await page.evaluate((needle) => {
        const plain = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const norm = (value) => plain(value).replace(/\\s+/g, '').toLowerCase();
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const box = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
        };
        const inSku = (el) => Boolean(el.closest('[class*="sku" i],[id*="sku" i],[class*="spec" i],[class*="prop" i],[data-property],[data-sku]'));
        const clickableOf = (el) => el.closest('button,a,li,label,[role="option"],[role="radio"],[data-value],[data-property],[class*="item" i],[class*="option" i],[class*="value" i]') || el;
        const nodes = [...document.querySelectorAll('body *')].filter((el) => {
          if (!visible(el)) return false;
          const value = plain(el.textContent);
          if (!value || value.length > 40) return false;
          if (el.children.length === 0) return true;
          return ['BUTTON', 'A', 'LI', 'LABEL'].includes(el.tagName) || el.getAttribute('role') === 'option' || el.getAttribute('role') === 'radio';
        });
        const needleNorm = norm(needle);
        const rank = (el) => (inSku(el) ? 0 : 4) + (el.tagName === 'SPAN' ? 1 : 0);
        let target = nodes.filter((el) => norm(el.textContent) === needleNorm).sort((a, b) => rank(a) - rank(b))[0];
        if (!target) {
          target = nodes.filter((el) => {
            const value = norm(el.textContent);
            return value.length <= needleNorm.length + 6 && value.includes(needleNorm);
          }).sort((a, b) => rank(a) - rank(b))[0];
        }
        if (!target) return null;
        const option = clickableOf(target);
        option.scrollIntoView({ block: 'center' });
        option.click();
        option.setAttribute('data-dsh-picked', '1');
        return plain(target.textContent);
      }, part).catch(() => null);
      if (result) {
        picked += 1;
        await log('已选择规格：' + result);
        await sleep(300);
      }
    }
    if (picked === 0) {
      await log('没有自动找到 SKU 选项，请在 ego 浏览器里手动选择规格', 'warn');
    }

    await sleep(350);
    const defaults = await page.evaluate(() => {
      const plain = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const box = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
      };
      const disabled = (el) => el.matches('[disabled],[aria-disabled="true"]') || /(^|\\s)(disabled|is-disabled)(\\s|$)/.test(el.className || '') || window.getComputedStyle(el).pointerEvents === 'none';
      const selected = (el) => el.matches('[aria-checked="true"],[aria-selected="true"],[data-selected="true"]') || /(^|\\s)(selected|active|checked|is-selected|is-active)(\\s|$)/.test(el.className || '') || Boolean(el.querySelector('input:checked'));
      const inSku = (el) => Boolean(el.closest('[class*="sku" i],[id*="sku" i],[class*="spec" i],[class*="prop" i],[data-property],[data-sku]'));
      const nodes = [...document.querySelectorAll('button,li,[role="option"],[role="radio"],[data-value],[class*="item" i],[class*="option" i],[class*="value" i]')].filter((el) => {
        if (!visible(el) || !inSku(el)) return false;
        const value = plain(el.textContent);
        return value.length > 0 && value.length <= 24;
      });
      const byParent = new Map();
      for (const el of nodes) {
        const parent = el.parentElement;
        if (!parent) continue;
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(el);
      }
      const groups = [];
      const signatures = new Set();
      for (const items of byParent.values()) {
        const unique = [];
        const texts = new Set();
        for (const el of items) {
          const value = plain(el.textContent);
          if (texts.has(value)) continue;
          texts.add(value);
          unique.push({ el, text: value });
        }
        if (unique.length < 2 || unique.length > 30) continue;
        const signature = unique.map((item) => item.text).join('|');
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        groups.push(unique);
      }
      if (groups.length < 2) return [];
      const clicked = [];
      for (const group of groups) {
        if (group.some((item) => item.el.matches('[data-dsh-picked]'))) continue;
        if (group.some((item) => selected(item.el))) continue;
        const first = group.find((item) => !disabled(item.el));
        if (!first) continue;
        first.el.scrollIntoView({ block: 'center' });
        first.el.click();
        first.el.setAttribute('data-dsh-picked', '1');
        clicked.push(first.text);
      }
      return clicked;
    }).catch(() => []);
    if (defaults.length > 0) {
      await log('其余规格已按默认选择：' + defaults.join(' / '));
    }

    await page.waitForTimeout(800);
    await log('点击「立即购买」', 'info', { stage: 'buying' });
    const buyLabel = await clickLabel(BUY_LABELS);
    if (!buyLabel) throw new Error('没有找到「立即购买」按钮，请确认链接是商品详情页并已完成登录');

    await sleep(2000);
    try {
      const tabs = await task.tabs();
      const active = tabs.find((item) => item.active);
      if (active && active.page) {
        let next = active.page;
        if (!active.label) next = await task.adopt(next);
        page = next;
      }
    } catch {
      // Keep the original page.
    }

    const checkoutDeadline = Date.now() + 30000;
    let onCheckout = false;
    while (Date.now() < checkoutDeadline) {
      const url = await page.url().catch(() => '');
      const hasSubmit = await page.evaluate(() => /提交订单|确认下单|订单确认/.test(document.body.innerText)).catch(() => false);
      if (hasSubmit || /buy\\.|confirm|order/i.test(url)) {
        onCheckout = true;
        break;
      }
      await sleep(1000);
    }
    if (!onCheckout) {
      await log('没有自动进入订单确认页，请在 ego 浏览器里手动继续', 'warn', { status: 'awaiting_confirmation', stage: 'confirm', currentUrl: await page.url().catch(() => null) });
    } else {
      await log('已进入订单确认页', 'info', { stage: 'confirming', currentUrl: await page.url().catch(() => null) });
    }

    if (QUANTITY > 1) {
      const changed = await page.evaluate((value) => {
        const inputs = [...document.querySelectorAll('input')].filter((input) => {
          const haystack = [input.name, input.id, input.className, input.getAttribute('aria-label') || '', input.getAttribute('placeholder') || ''].join(' ').toLowerCase();
          return /quantity|num|数量/.test(haystack) && input.offsetParent !== null;
        });
        const input = inputs[0];
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, QUANTITY).catch(() => false);
      await log(changed ? '数量已填写为 ' + QUANTITY : '没有找到数量输入框，请在浏览器里确认数量为 ' + QUANTITY, changed ? 'info' : 'warn');
    }

    if (AUTO_SUBMIT) {
      await log('正在提交订单…', 'info', { stage: 'confirming' });
      const submitted = await clickLabel(SUBMIT_LABELS);
      if (submitted) {
        await sleep(2500);
        await log('已点击「' + submitted + '」，订单已提交但未付款，请在 ego 浏览器中完成付款', 'success', {
          status: 'submitted',
          stage: 'submitted',
          currentUrl: await page.url().catch(() => null),
        });
        await saveResult({ status: 'submitted', stage: 'submitted', error: null, currentUrl: await page.url().catch(() => null) });
      } else {
        await log('没有找到「提交订单」按钮，请在 ego 浏览器里手动确认', 'warn', {
          status: 'awaiting_confirmation',
          stage: 'confirm',
          currentUrl: await page.url().catch(() => null),
        });
        await saveResult({ status: 'awaiting_confirmation', stage: 'confirm', error: null, currentUrl: await page.url().catch(() => null) });
      }
    } else {
      await log('已到提交订单页，请核对地址和金额后手动点击「提交订单」', 'success', {
        status: 'awaiting_confirmation',
        stage: 'confirm',
        currentUrl: await page.url().catch(() => null),
      });
      await saveResult({ status: 'awaiting_confirmation', stage: 'confirm', error: null, currentUrl: await page.url().catch(() => null) });
    }

    if (task) {
      const keep = page && page.label ? [page.label] : [];
      await task.finish({ keep }).catch(() => {});
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      await log('执行失败：' + message, 'error', { status: 'error', stage: 'error' });
      await saveResult({ status: 'error', stage: 'error', error: message, currentUrl: page ? await page.url().catch(() => null) : null });
    } catch {
      // Ignore secondary failures.
    }
    if (task) {
      const keep = page && page.label ? [page.label] : [];
      await task.finish({ keep }).catch(() => {});
    }
  }
}

await main();
`;
}

function loginScript({ space, url }) {
  return `'use strict';

const SPACE = ${json(space)};
const LOGIN_URL = ${json(url)};

const task = await taskSpace(SPACE);
const page = task.page('p1');
await page.goto(LOGIN_URL).catch(() => {});
await page.waitForTimeout(1200);
await task.handOff();
`;
}

function uiScript({ space, url }) {
  return `'use strict';

const SPACE = ${json(space)};
const URL = ${json(url)};

const task = await taskSpace(SPACE);
const page = task.page('p1');
await page.goto(URL);
await task.handOff();
`;
}

function loginDir(root) {
  return path.join(root, 'data', 'ego-runs');
}

module.exports = { orderScript, loginScript, uiScript, loginDir };
