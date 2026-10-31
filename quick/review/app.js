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

let data = null;
let formImages = [];
let pendingFiles = [];
let editingId = null;

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
  let hint = runner.lastTickAt ? `上次巡检：${timeLabel(runner.lastTickAt)}` : '还没有巡检过';
  if (!d.settings.enabled) {
    text = '调度已暂停';
    dot.classList.add('warn');
  } else if (runner.busy) {
    text = '正在执行任务';
    dot.classList.add('busy');
  } else {
    dot.classList.add('ok');
    hint += ` · 每 ${d.settings.checkIntervalMinutes} 分钟巡检一次`;
  }
  $('#runState').textContent = text;
  $('#runHint').textContent = hint;
  $('#toggleBtn').textContent = d.settings.enabled ? '暂停调度' : '恢复调度';
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
  $('#setInterval').value = settings.checkIntervalMinutes;
  $('#setFollowupDays').value = settings.followupDefaultDays;
  $('#setQuietStart').value = settings.quietHours.start;
  $('#setQuietEnd').value = settings.quietHours.end;
}

function taskActionButtons(task) {
  const buttons = [];
  buttons.push(`<button class="btn small" data-act="run" data-id="${task.id}">立即执行</button>`);
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

function renderTasks(tasks) {
  const wrap = $('#tasks');
  if (!tasks.length) {
    wrap.innerHTML = '<div class="empty">还没有任务，先在上面新建一个</div>';
    return;
  }
  wrap.innerHTML = tasks.map((task) => {
    const badge = STATE_BADGE[task.state] || '';
    const thumbs = (task.imageUrls || []).slice(0, 6).map((url) => `<img src="${esc(url)}" alt="" />`).join('');
    const due = task.state === 'waiting_followup' || task.state === 'reviewed'
      ? `追评到期：${timeLabel(task.followupDueAt)}`
      : task.state === 'waiting_confirm' || task.state === 'pending_review'
        ? `下次检查：${timeLabel(task.nextCheckAt)}`
        : task.state === 'done'
          ? `完成于：${timeLabel(task.followupDoneAt || task.updatedAt)}`
          : '';
    const logs = (task.logs || []).slice(-30).map((log) => `<div class="${esc(log.level)}">${esc(log.time.slice(11, 19))} ${esc(log.message)}</div>`).join('');
    return `
      <div class="task" data-id="${task.id}">
        <div class="task-head">
          <span class="task-title">${esc(task.orderId)}</span>
          <span class="badge ${badge}">${esc(STATE_LABELS[task.state] || task.state)}</span>
          ${task.orderTitle ? `<span class="muted">${esc(task.orderTitle)}</span>` : ''}
          <div class="task-actions">${taskActionButtons(task)}</div>
        </div>
        <div class="task-body">
          <div class="task-thumbs">${thumbs}</div>
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

function renderThumbs() {
  $('#thumbs').innerHTML = formImages.map((item, index) => `
    <div class="thumb">
      <img src="${esc(item.url)}" alt="" />
      <button type="button" data-remove="${index}">×</button>
    </div>`).join('');
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      toast('只支持 jpg / png / webp / gif');
      continue;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast(`${file.name} 超过 5MB`);
      continue;
    }
    const url = URL.createObjectURL(file);
    formImages.push({ file, url });
    pendingFiles.push(file);
  }
  renderThumbs();
}

function resetForm() {
  editingId = null;
  formImages = [];
  pendingFiles = [];
  $('#taskForm').reset();
  $('#taskId').value = '';
  $('#followupDays').value = data ? data.settings.followupDefaultDays : 3;
  $('#formTitle').textContent = '新建晒评价任务';
  renderThumbs();
}

async function uploadPending(taskId) {
  const uploaded = [];
  for (const file of pendingFiles) {
    const response = await fetch(`/api/review/upload?taskId=${encodeURIComponent(taskId)}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '图片上传失败');
    uploaded.push(body.path);
  }
  pendingFiles = [];
  return uploaded;
}

async function saveTask(event) {
  event.preventDefault();
  const orderId = $('#orderId').value.trim();
  if (!orderId) return;
  const payload = {
    orderId,
    orderTitle: $('#orderTitle').value.trim(),
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
    if (pendingFiles.length) {
      const uploaded = await uploadPending(task.id);
      const keep = formImages.filter((item) => !item.file).map((item) => item.path).filter(Boolean);
      task = (await api(`/api/review/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ images: [...keep, ...uploaded] }),
      })).task;
    }
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
  $('#content').value = task.content || '';
  $('#followupContent').value = task.followupContent || '';
  $('#followupDays').value = task.followupDays;
  formImages = (task.images || []).map((path, index) => ({
    path,
    url: (task.imageUrls || [])[index] || '',
  }));
  pendingFiles = [];
  $('#formTitle').textContent = `编辑任务 ${task.orderId}`;
  renderThumbs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

async function main() {
  $('#taskForm').addEventListener('submit', saveTask);
  $('#resetFormBtn').addEventListener('click', resetForm);
  $('#tasks').addEventListener('click', onTaskClick);
  $('#thumbs').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove]');
    if (!btn) return;
    const index = Number(btn.dataset.remove);
    const [removed] = formImages.splice(index, 1);
    if (removed && removed.file) {
      pendingFiles = pendingFiles.filter((file) => file !== removed.file);
    }
    renderThumbs();
  });

  const drop = $('#drop');
  drop.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => {
    addFiles(event.target.files);
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
  drop.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

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
          checkIntervalMinutes: Number($('#setInterval').value),
          followupDefaultDays: Number($('#setFollowupDays').value),
          quietHours: { start: $('#setQuietStart').value, end: $('#setQuietEnd').value },
        }),
      });
      toast('设置已保存');
      await poll();
    } catch (error) { toast(error.message); }
  });

  await poll();
  setInterval(poll, 3000);
}

main();
