'use strict';

const $ = (selector) => document.querySelector(selector);

const STATE_LABELS = {
  prepared: '待开始',
  probing: '巡检中',
  waiting_confirm: '待收货',
  pending_review: '待评价',
  reviewing: '评价中',
  reviewed: '已评价',
  waiting_followup: '待追评',
  following_up: '追评中',
  done: '已完成',
  paused: '已暂停',
  needs_attention: '需处理',
  error: '失败',
  expired: '已过期',
};

const STATE_BADGE = {
  done: 'ok',
  reviewed: 'ok',
  waiting_followup: 'warn',
  pending_review: 'busy',
  waiting_confirm: 'warn',
  probing: 'busy',
  reviewing: 'busy',
  following_up: 'busy',
  needs_attention: 'err',
  error: 'err',
  expired: 'err',
  paused: '',
  prepared: '',
};

const MAX_IMAGES = 5;

let data = null;
let editingId = null;
let reviewImages = [];
let followupImages = [];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function timeLabel(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const md = `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (abs < 60 * 1000) return '马上';
  if (abs < 60 * 60 * 1000) return `${diff > 0 ? '' : '已过 '}${Math.round(abs / 60000)} 分钟${diff > 0 ? '后' : ''}（${md}）`;
  if (abs < 24 * 60 * 60 * 1000) return `${diff > 0 ? '' : '已过 '}${Math.round(abs / 3600000)} 小时${diff > 0 ? '后' : ''}（${md}）`;
  return `${diff > 0 ? '' : '已过 '}${Math.round(abs / 86400000)} 天${diff > 0 ? '后' : ''}（${md}）`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function renderStatus(d) {
  const runner = d.runner || {};
  const dot = $('#runDot');
  dot.className = 'dot';
  let text = '空闲';
  let hint = runner.lastTickAt ? `上次检查：${timeLabel(runner.lastTickAt)}` : '打开页面会自动检查一次';
  if (!d.settings.enabled) {
    text = '自动检查已暂停';
    dot.classList.add('warn');
  } else if (runner.busy) {
    text = '正在执行任务';
    dot.classList.add('busy');
  } else {
    dot.classList.add('ok');
    hint += ' · 可点「立即巡检」手动触发';
    hint += ` · 今日已执行 ${(d.rate && d.rate.day) || 0}/${(d.rate && d.rate.dailyLimit) || 30}`;
  }
  $('#runState').textContent = text;
  $('#runHint').textContent = hint;
  $('#toggleBtn').textContent = d.settings.enabled ? '暂停自动检查' : '恢复自动检查';
}

function renderStats(stats) {
  $('#statConfirm').textContent = stats.waitingConfirm || 0;
  $('#statReview').textContent = stats.pendingReview || 0;
  $('#statFollowup').textContent = stats.waitingFollowup || 0;
  $('#statDone').textContent = stats.done || 0;
  $('#statAttention').textContent = stats.needsAttention || 0;
}

function renderSettings(settings) {
  if (document.activeElement && document.activeElement.closest('.settings-grid')) return;
  $('#setFollowupDays').value = settings.followupDefaultDays;
  $('#setHourly').value = settings.hourlyLimit;
  $('#setDaily').value = settings.dailyLimit;
}

function taskActionButtons(task) {
  const buttons = [];
  buttons.push(`<button class="btn small" data-act="run" data-id="${task.id}">立即执行</button>`);
  if (task.reviewedAt && !['done', 'expired'].includes(task.state)) {
    buttons.push(`<button class="btn small" data-act="followup" data-id="${task.id}">立即追评</button>`);
  }
  if (task.state === 'paused') {
    buttons.push(`<button class="btn small" data-act="resume" data-id="${task.id}">恢复</button>`);
  } else if (!['done', 'expired'].includes(task.state)) {
    buttons.push(`<button class="btn small" data-act="pause" data-id="${task.id}">暂停</button>`);
  }
  if (['error', 'needs_attention', 'expired'].includes(task.state)) {
    buttons.push(`<button class="btn small" data-act="retry" data-id="${task.id}">重试</button>`);
  }
  buttons.push(`<button class="btn small ghost" data-act="edit" data-id="${task.id}">编辑</button>`);
  buttons.push(`<button class="btn small ghost danger" data-act="delete" data-id="${task.id}">删除</button>`);
  return buttons.join('');
}

function thumbStrip(urls, prefix) {
  if (!urls || !urls.length) return '';
  return `<div class="task-thumbs">${urls.map((url) => `<img src="${esc(url)}" alt="" title="${prefix}" />`).join('')}</div>`;
}

function renderTasks(tasks) {
  const wrap = $('#tasks');
  if (!tasks.length) {
    wrap.innerHTML = '<div class="empty">还没有任务，先在上面新建一个</div>';
    return;
  }
  wrap.innerHTML = tasks.map((task) => {
    const badge = STATE_BADGE[task.state] || '';
    const due = task.state === 'waiting_followup' || task.state === 'reviewed'
      ? `追评到期：${timeLabel(task.followupDueAt)}`
      : task.state === 'waiting_confirm' || task.state === 'pending_review'
        ? `下次检查：${timeLabel(task.nextCheckAt)}`
        : task.state === 'done'
          ? `完成于：${timeLabel(task.followupDoneAt || task.updatedAt)}`
          : '';
    const logs = (task.logs || []).slice(-30).map((log) => `<div class="${esc(log.level)}">${esc(log.time.slice(11, 19))} ${esc(log.message)}</div>`).join('');
    const reviewThumbs = thumbStrip(task.imageUrls, '首次晒图');
    const followThumbs = thumbStrip(task.followupImageUrls, '追评晒图');
    return `
      <div class="task" data-id="${task.id}">
        <div class="task-head">
          <span class="task-title">${esc(task.orderId)}</span>
          <span class="badge ${badge}">${esc(STATE_LABELS[task.state] || task.state)}</span>
          ${task.orderTitle ? `<span class="muted">${esc(task.orderTitle)}</span>` : ''}
          <div class="task-actions">${taskActionButtons(task)}</div>
        </div>
        <div class="task-body">
          <div class="task-thumbs-wrap">
            ${reviewThumbs ? `<div class="thumb-group"><span class="thumb-label">首次</span>${reviewThumbs}</div>` : ''}
            ${followThumbs ? `<div class="thumb-group"><span class="thumb-label">追评</span>${followThumbs}</div>` : ''}
          </div>
          <div class="task-meta">
            <div>评价：${esc(task.content || '（空）')}</div>
            <div>追评：${esc(task.followupContent || '（空）')} · ${task.followupDays} 天后</div>
            ${due ? `<div>${esc(due)}</div>` : ''}
            ${task.lastError ? `<div style="color:var(--err)">${esc(task.lastError)}</div>` : ''}
            <a href="#" data-act="logs" data-id="${task.id}" style="font-size:12px;color:var(--muted)">查看日志</a>
          </div>
        </div>
        <div class="logs" id="logs-${task.id}">${logs || '<div>暂无日志</div>'}</div>
      </div>`;
  }).join('');
}

function render(d) {
  data = d;
  renderStatus(d);
  renderStats(d.stats || {});
  renderSettings(d.settings);
  renderTasks(d.tasks || []);
}

async function poll() {
  try {
    const d = await api('/api/review/state');
    render(d);
  } catch (error) {
    $('#runState').textContent = '连接失败';
    $('#runHint').textContent = error.message;
  }
}

function renderThumbs(kind) {
  const list = kind === 'review' ? reviewImages : followupImages;
  const box = kind === 'review' ? $('#reviewThumbs') : $('#followupThumbs');
  box.innerHTML = list.map((item, index) => `
    <div class="thumb">
      <img src="${esc(item.url)}" alt="" />
      <button type="button" data-kind="${kind}" data-remove="${index}">×</button>
    </div>`).join('');
}

function addFiles(kind, fileList) {
  const list = kind === 'review' ? reviewImages : followupImages;
  for (const file of fileList) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      toast('只支持 jpg / png / webp / gif');
      continue;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast(`${file.name} 超过 5MB`);
      continue;
    }
    if (list.length >= MAX_IMAGES) {
      toast(`每边最多 ${MAX_IMAGES} 张`);
      break;
    }
    list.push({ file, url: URL.createObjectURL(file), kind });
  }
  renderThumbs(kind);
}

function resetForm() {
  editingId = null;
  reviewImages = [];
  followupImages = [];
  $('#taskForm').reset();
  $('#taskId').value = '';
  $('#followupDays').value = data ? data.settings.followupDefaultDays : 3;
  $('#formTitle').textContent = '新建晒评价任务';
  renderThumbs('review');
  renderThumbs('followup');
}

async function uploadList(taskId, kind, list) {
  const uploaded = [];
  for (const item of list) {
    if (!item.file) {
      if (item.path) uploaded.push(item.path);
      continue;
    }
    const response = await fetch(`/api/review/upload?taskId=${encodeURIComponent(taskId)}&name=${encodeURIComponent(item.file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: item.file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '图片上传失败');
    uploaded.push(body.path);
  }
  return uploaded;
}

async function saveTask(event) {
  event.preventDefault();
  const orderId = $('#orderId').value.trim();
  if (!orderId) return;
  const payload = {
    orderId,
    orderTitle: $('#orderTitle').value.trim(),
    itemUrl: $('#itemUrl').value.trim(),
    content: $('#content').value.trim(),
    followupContent: $('#followupContent').value.trim(),
    followupDays: Number($('#followupDays').value) || 0,
  };
  $('#saveBtn').disabled = true;
  try {
    let task;
    if (editingId) {
      task = (await api(`/api/review/tasks/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) })).task;
    } else {
      task = (await api('/api/review/tasks', { method: 'POST', body: JSON.stringify(payload) })).task;
    }
    const nextReview = await uploadList(task.id, 'review', reviewImages);
    const nextFollowup = await uploadList(task.id, 'followup', followupImages);
    task = (await api(`/api/review/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewImages: nextReview, followupImages: nextFollowup }),
    })).task;
    toast(editingId ? '已保存修改' : '任务已创建');
    resetForm();
    await poll();
  } catch (error) {
    toast(error.message);
  } finally {
    $('#saveBtn').disabled = false;
  }
}

function startEdit(task) {
  editingId = task.id;
  $('#taskId').value = task.id;
  $('#orderId').value = task.orderId;
  $('#orderTitle').value = task.orderTitle || '';
  $('#itemUrl').value = task.itemUrl || '';
  $('#content').value = task.content || '';
  $('#followupContent').value = task.followupContent || '';
  $('#followupDays').value = task.followupDays;
  reviewImages = (task.reviewImages || []).map((path, index) => ({
    path,
    url: (task.imageUrls || [])[index] || '',
  }));
  followupImages = (task.followupImages || []).map((path, index) => ({
    path,
    url: (task.followupImageUrls || [])[index] || '',
  }));
  $('#formTitle').textContent = `编辑任务 ${task.orderId}`;
  renderThumbs('review');
  renderThumbs('followup');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchProductImages() {
  const url = $('#itemUrl').value.trim();
  if (!url) { toast('先填商品链接'); return; }
  const btn = $('#fetchImagesBtn');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const result = await api('/api/review/fetch-images', {
      method: 'POST',
      body: JSON.stringify({
        url,
        sku1: $('#sku1') ? $('#sku1').value : '',
        sku2: $('#sku2') ? $('#sku2').value : '',
      }),
    });
    if (!result.images || !result.images.length) {
      toast('没有抓到图片，可能需要登录或页面结构变了');
      return;
    }
    for (const image of result.images) {
      if (reviewImages.length >= MAX_IMAGES) break;
      const blob = await (await fetch(image.dataUrl)).blob();
      const file = new File([blob], image.name || 'image.jpg', { type: blob.type || 'image/jpeg' });
      reviewImages.push({ file, url: URL.createObjectURL(file), kind: 'review' });
    }
    renderThumbs('review');
    toast(`抓到 ${result.images.length} 张图`);
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '抓取主图/SKU图';
  }
}

async function importOrders() {
  const btn = $('#importBtn');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const result = await api('/api/review/import-orders', { method: 'POST' });
    toast(`同步完成：新增 ${result.imported} 个，已存在 ${result.skipped} 个`);
    await poll();
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '同步已收货订单';
  }
}

async function onTaskClick(event) {
  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;
  const act = trigger.dataset.act;
  const id = trigger.dataset.id;
  const task = (data.tasks || []).find((item) => item.id === id);
  if (!task) return;
  event.preventDefault();

  try {
    if (act === 'logs') {
      $('#logs-' + id).classList.toggle('open');
      return;
    }
    if (act === 'edit') {
      startEdit(task);
      return;
    }
    if (act === 'run') {
      await api(`/api/review/tasks/${id}/run`, { method: 'POST' });
      toast('已开始执行，稍后刷新查看结果');
    } else if (act === 'followup') {
      if (!confirm(`立即给订单 ${task.orderId} 追评？`)) return;
      await api(`/api/review/tasks/${id}/followup`, { method: 'POST' });
      toast('已开始追评，稍后刷新查看结果');
    } else if (act === 'pause' || act === 'resume' || act === 'retry') {
      await api(`/api/review/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ action: act }) });
      toast('已更新');
    } else if (act === 'delete') {
      if (!confirm(`删除任务 ${task.orderId}？`)) return;
      await api(`/api/review/tasks/${id}`, { method: 'DELETE' });
      toast('已删除');
    }
    await poll();
  } catch (error) {
    toast(error.message);
  }
}

function bindDrop(kind) {
  const drop = kind === 'review' ? $('#reviewDrop') : $('#followupDrop');
  const input = kind === 'review' ? $('#reviewInput') : $('#followupInput');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', (event) => {
    addFiles(kind, event.target.files);
    event.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add('hover');
  }));
  ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.remove('hover');
  }));
  drop.addEventListener('drop', (event) => addFiles(kind, event.dataTransfer.files));
}

async function main() {
  $('#taskForm').addEventListener('submit', saveTask);
  $('#resetFormBtn').addEventListener('click', resetForm);
  $('#tasks').addEventListener('click', onTaskClick);
  $('#fetchImagesBtn').addEventListener('click', fetchProductImages);
  $('#importBtn').addEventListener('click', importOrders);

  for (const kind of ['review', 'followup']) {
    bindDrop(kind);
    const box = kind === 'review' ? $('#reviewThumbs') : $('#followupThumbs');
    box.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-remove]');
      if (!btn) return;
      const list = kind === 'review' ? reviewImages : followupImages;
      list.splice(Number(btn.dataset.remove), 1);
      renderThumbs(kind);
    });
  }

  $('#checkNowBtn').addEventListener('click', async () => {
    try {
      await api('/api/review/check-now', { method: 'POST' });
      toast('已触发巡检');
      await poll();
    } catch (error) { toast(error.message); }
  });

  $('#toggleBtn').addEventListener('click', async () => {
    try {
      await api('/api/review/settings', { method: 'PATCH', body: JSON.stringify({ enabled: !data.settings.enabled }) });
      await poll();
    } catch (error) { toast(error.message); }
  });

  $('#saveSettingsBtn').addEventListener('click', async () => {
    try {
      await api('/api/review/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          followupDefaultDays: Number($('#setFollowupDays').value),
          hourlyLimit: Number($('#setHourly').value),
          dailyLimit: Number($('#setDaily').value),
        }),
      });
      toast('设置已保存');
      await poll();
    } catch (error) { toast(error.message); }
  });

  await poll();

  api('/api/review/check-now?auto=1', { method: 'POST' })
    .then((result) => {
      if (result && result.accepted) setTimeout(poll, 3000);
    })
    .catch(() => {});

  setInterval(poll, 3000);
}

main();
