'use strict';

const state = {
  orders: [],
  operators: [],
  activities: [],
  stats: { total: 0, pending: 0, processing: 0, done: 0, overdue: 0 },
  filter: {
    status: '全部',
    search: '',
    operator: '',
    overdue: false,
  },
};

const STATUSES = ['待派单', '待拍摄', '待回传', '待验收', '已完成', '异常'];
const STATUS_TABS = ['全部', ...STATUSES];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ICONS = {
  total:
    '<svg viewBox="0 0 24 24"><path d="M4 6.5h16v13H4zM8 4v5m8-5v5M4 10h16"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  processing:
    '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/></svg>',
  overdue:
    '<svg viewBox="0 0 24 24"><path d="M12 3 3.5 19h17L12 3Z"/><path d="M12 9v4m0 2.5v.1"/></svg>',
  more:
    '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24"><path d="m4 16-.7 4.7L8 20l10.7-10.7a2.1 2.1 0 0 0-3-3L4 16Z"/><path d="m13.5 7.5 3 3"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });
}

function formatDateLabel() {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]}`;
}

function todayString() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

function dayGap(dateString) {
  if (!dateString) return null;
  const due = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function relativeTime(isoString) {
  const value = new Date(isoString).getTime();
  if (Number.isNaN(value)) return '';
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

function applyState(nextState) {
  if (!nextState) return;
  state.orders = nextState.orders || [];
  state.operators = nextState.operators || [];
  state.activities = nextState.activities || [];
  state.stats = nextState.stats || state.stats;
  if (
    state.filter.operator &&
    state.filter.operator !== 'unassigned' &&
    !state.operators.some((operator) => operator.id === state.filter.operator)
  ) {
    state.filter.operator = '';
  }
  renderAll();
}

async function refresh() {
  try {
    applyState(await api('/api/state'));
  } catch (error) {
    toast(error.message, 'error');
  }
}

function toast(message, type = 'success') {
  const stack = $('#toastStack');
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.innerHTML = `<i></i><span>${escapeHtml(message)}</span>`;
  stack.appendChild(element);
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transform = 'translateY(5px)';
    element.style.transition = 'all .2s ease';
    setTimeout(() => element.remove(), 220);
  }, 3200);
}

function sortOrders(orders) {
  const rank = { 异常: 0, 待派单: 1, 待拍摄: 2, 待回传: 3, 待验收: 4, 已完成: 9 };
  return [...orders].sort((a, b) => {
    const statusDiff = (rank[a.status] ?? 5) - (rank[b.status] ?? 5);
    if (statusDiff) return statusDiff;
    if (a.priority !== b.priority) return a.priority === '加急' ? -1 : 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

function filteredOrders() {
  const { status, search, operator, overdue } = state.filter;
  const needle = search.trim().toLowerCase();
  return sortOrders(
    state.orders.filter((order) => {
      if (status !== '全部' && order.status !== status) return false;
      if (operator === 'unassigned' && order.operatorId) return false;
      if (operator && operator !== 'unassigned' && order.operatorId !== operator) return false;
      if (overdue) {
        const gap = dayGap(order.dueDate);
        if (order.status === '已完成' || gap === null || gap >= 0) return false;
      }
      if (needle) {
        const haystack = [
          order.taobaoOrderNo,
          order.product,
          order.sku,
          order.buyerNick,
          order.shop,
          order.receiver,
          order.region,
          order.note,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    }),
  );
}

function renderStats() {
  const { total, pending, processing, done, overdue } = state.stats;
  const cards = [
    {
      label: '全部订单',
      value: total,
      foot: `已完成 ${done} 个`,
      icon: ICONS.total,
      className: '',
    },
    {
      label: '待派单',
      value: pending,
      foot: pending ? '等待分配执行人' : '当前无积压',
      icon: ICONS.pending,
      className: 'accent',
    },
    {
      label: '进行中',
      value: processing,
      foot: '拍摄 / 回传 / 验收',
      icon: ICONS.processing,
      className: 'green',
    },
    {
      label: '逾期未完成',
      value: overdue,
      foot: overdue ? '需要优先处理' : '进度正常',
      icon: ICONS.overdue,
      className: 'danger',
    },
  ];

  $('#stats').innerHTML = cards
    .map(
      (card) => `
      <article class="stat-card ${card.className}">
        <div class="stat-top">
          <span class="stat-label">${card.label}</span>
          <span class="stat-icon">${card.icon}</span>
        </div>
        <strong class="stat-value">${card.value}</strong>
        <span class="stat-foot">${card.foot}</span>
      </article>`,
    )
    .join('');

  $('#introPending').textContent = `${pending} 个订单待分配`;
}

function renderStatusTabs() {
  $('#statusTabs').innerHTML = STATUS_TABS.map((status) => {
    const count =
      status === '全部'
        ? state.orders.length
        : state.orders.filter((order) => order.status === status).length;
    return `<button type="button" data-status="${status}" class="${state.filter.status === status ? 'active' : ''}">${status}<span style="opacity:.52;margin-left:4px">${count}</span></button>`;
  }).join('');
}

function renderOperatorFilter() {
  const select = $('#operatorFilter');
  const current = state.filter.operator;
  select.innerHTML = [
    '<option value="">全部执行人</option>',
    '<option value="unassigned">未分配</option>',
    ...state.operators.map(
      (operator) =>
        `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.name)}${operator.active ? '' : '（停用）'}</option>`,
    ),
  ].join('');
  select.value = current;
}

function operatorOptions(selectedId) {
  return [
    '<option value="">未分配</option>',
    ...state.operators.map(
      (operator) =>
        `<option value="${escapeHtml(operator.id)}" ${operator.id === selectedId ? 'selected' : ''}>${escapeHtml(operator.name)}${operator.active ? '' : '（停用）'}</option>`,
    ),
  ].join('');
}

function renderOrders() {
  const orders = filteredOrders();
  const tbody = $('#orderRows');
  const empty = $('#emptyState');
  const table = $('.orders-table');

  tbody.innerHTML = orders
    .map((order) => {
      const operator = state.operators.find((item) => item.id === order.operatorId);
      const gap = dayGap(order.dueDate);
      const isOverdue = gap !== null && gap < 0 && order.status !== '已完成';
      let dueLabel = '';
      if (gap !== null) {
        if (order.status === '已完成') dueLabel = '已完成';
        else if (gap < 0) dueLabel = `逾期 ${Math.abs(gap)} 天`;
        else if (gap === 0) dueLabel = '今天截止';
        else if (gap === 1) dueLabel = '明天截止';
        else dueLabel = `${gap} 天后`;
      }

      return `
      <tr data-id="${escapeHtml(order.id)}">
        <td>
          <div class="order-main">
            <strong title="${escapeHtml(order.product || '未命名商品')}">${escapeHtml(order.product || '未命名商品')}</strong>
            <span class="order-no">${escapeHtml(order.taobaoOrderNo || '未填订单号')}</span>
            <div class="sku-line">
              ${order.priority === '加急' ? '<span class="priority-tag">加急</span>' : ''}
              <span class="order-no" title="${escapeHtml(order.sku || '')}">${escapeHtml(order.sku || order.shop || '—')}</span>
            </div>
          </div>
        </td>
        <td>
          <div class="buyer-cell">
            <strong>${escapeHtml(order.buyerNick || order.receiver || '—')}</strong>
            <span>${escapeHtml(order.region || order.receiver || '—')}</span>
          </div>
        </td>
        <td class="num"><span class="amount">¥${money(order.amount)}</span></td>
        <td class="operator-cell">
          <select class="operator-select ${order.operatorId ? '' : 'unassigned'}" data-action="operator" data-id="${escapeHtml(order.id)}" aria-label="执行人">
            ${operatorOptions(order.operatorId)}
          </select>
        </td>
        <td>
          <select class="status-select status-${escapeHtml(order.status)}" data-action="status" data-id="${escapeHtml(order.id)}" aria-label="状态">
            ${STATUSES.map(
              (status) =>
                `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status}</option>`,
            ).join('')}
          </select>
        </td>
        <td>
          <div class="due-cell">
            <span class="due-date ${order.dueDate ? '' : 'empty'}">${escapeHtml(order.dueDate || '未设置')}</span>
            <span class="due-label ${isOverdue ? 'overdue' : ''}">${dueLabel || '—'}</span>
          </div>
        </td>
        <td>
          <div class="row-actions">
            <button class="icon-btn row-menu-btn" type="button" data-action="menu" data-id="${escapeHtml(order.id)}" aria-label="更多操作">${ICONS.more}</button>
            <div class="mini-menu">
              <button type="button" data-action="edit" data-id="${escapeHtml(order.id)}">${ICONS.edit} 编辑订单</button>
              <button type="button" data-action="copy" data-id="${escapeHtml(order.id)}">${ICONS.copy} 回访文案</button>
              <button type="button" class="danger" data-action="delete" data-id="${escapeHtml(order.id)}">${ICONS.trash} 删除</button>
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  const hasRows = orders.length > 0;
  table.hidden = !hasRows;
  empty.hidden = hasRows;

  const pendingCount = state.orders.filter((order) => order.status === '待派单').length;
  $('#orderCountLabel').textContent = `共 ${state.orders.length} 条订单${
    pendingCount ? ` · ${pendingCount} 条待派单` : ''
  }`;
  $('#footerSummary').textContent = `显示 ${orders.length} 条${
    orders.length !== state.orders.length ? ` / 共 ${state.orders.length} 条` : ''
  }`;
}

function renderTeam() {
  const list = $('#teamList');
  if (!state.operators.length) {
    list.innerHTML = '<div class="team-empty">还没有执行人。添加后即可使用自动派单。</div>';
    return;
  }
  const maxLoad = Math.max(1, ...state.operators.map((operator) => operator.load));
  list.innerHTML = state.operators
    .map((operator) => {
      const width = operator.load === 0 ? 0 : Math.max(7, Math.round((operator.load / maxLoad) * 100));
      return `
        <div class="team-item" data-operator-id="${escapeHtml(operator.id)}" title="筛选 ${escapeHtml(operator.name)} 的订单">
          <span class="avatar">${escapeHtml(operator.name.slice(0, 1))}</span>
          <span class="team-copy">
            <strong>${escapeHtml(operator.name)}${operator.active ? '' : ' · 停用'}</strong>
            <span>${operator.load} 个进行中 · 已完成 ${operator.done}</span>
          </span>
          <span class="load-meter" title="当前负载 ${operator.load}">
            <span class="load-track"><i style="width:${width}%"></i></span>
            <b>${operator.load}</b>
          </span>
        </div>`;
    })
    .join('');
}

function renderActivity() {
  const list = $('#activityList');
  if (!state.activities.length) {
    list.innerHTML = '<li class="activity-empty">还没有操作记录。新建或分配订单后会显示在这里。</li>';
    return;
  }
  list.innerHTML = state.activities
    .slice(0, 14)
    .map(
      (activity) => `
      <li class="activity-item">
        <span class="activity-copy">
          <strong>${escapeHtml(activity.action)}</strong>
          <span>${escapeHtml(activity.detail || '')}</span>
          <time>${escapeHtml(relativeTime(activity.at))}</time>
        </span>
      </li>`,
    )
    .join('');
}

function renderAll() {
  renderStats();
  renderStatusTabs();
  renderOperatorFilter();
  renderOrders();
  renderTeam();
  renderActivity();
  syncOperatorSelects();
}

function syncOperatorSelects() {
  const orderOperatorSelect = $('#operatorId');
  if (orderOperatorSelect) {
    const current = orderOperatorSelect.value;
    orderOperatorSelect.innerHTML = operatorOptions(current);
  }
}

function openOrderDialog(order = null) {
  const dialog = $('#orderDialog');
  const form = $('#orderForm');
  form.reset();
  $('#orderId').value = order?.id || '';
  $('#orderDialogEyebrow').textContent = order ? 'EDIT ORDER' : 'NEW ORDER';
  $('#orderDialogTitle').textContent = order ? '编辑订单' : '新建订单';

  if (order) {
    $('#taobaoOrderNo').value = order.taobaoOrderNo || '';
    $('#shop').value = order.shop || '';
    $('#product').value = order.product || '';
    $('#sku').value = order.sku || '';
    $('#buyerNick').value = order.buyerNick || '';
    $('#amount').value = order.amount || '';
    $('#receiver').value = order.receiver || '';
    $('#region').value = order.region || '';
    $('#priority').value = order.priority || '普通';
    $('#dueDate').value = order.dueDate || '';
    $('#note').value = order.note || '';
    $('#operatorId').innerHTML = operatorOptions(order.operatorId);
  } else {
    $('#priority').value = '普通';
    $('#dueDate').value = addDays(todayString(), 3);
    $('#operatorId').innerHTML = operatorOptions('');
  }
  dialog.showModal();
  setTimeout(() => $('#product').focus(), 40);
}

async function saveOrder(event) {
  event.preventDefault();
  const id = $('#orderId').value;
  const payload = {
    taobaoOrderNo: $('#taobaoOrderNo').value,
    shop: $('#shop').value,
    product: $('#product').value,
    sku: $('#sku').value,
    buyerNick: $('#buyerNick').value,
    amount: $('#amount').value,
    receiver: $('#receiver').value,
    region: $('#region').value,
    priority: $('#priority').value,
    dueDate: $('#dueDate').value,
    note: $('#note').value,
    operatorId: $('#operatorId').value,
  };
  const button = $('#saveOrderBtn');
  button.disabled = true;
  try {
    const result = await api(id ? `/api/orders/${id}` : '/api/orders', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    applyState(result.state);
    $('#orderDialog').close();
    toast(id ? '订单已更新' : '订单已创建');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function updateOrder(id, patch) {
  try {
    const result = await api(`/api/orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    applyState(result.state);
  } catch (error) {
    toast(error.message, 'error');
    renderOrders();
  }
}

async function deleteOrder(order) {
  if (!window.confirm(`确认删除「${order.product || order.taobaoOrderNo}」？此操作不可撤销。`)) return;
  try {
    const result = await api(`/api/orders/${order.id}`, { method: 'DELETE' });
    applyState(result.state);
    toast('订单已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function reviewCopy(order) {
  const name = order.buyerNick ? `${order.buyerNick}，` : '';
  return `您好，${name}您购买的「${order.product || '商品'}」已经签收。若使用体验满意，欢迎在订单页分享真实的使用感受和照片；如有任何问题，随时联系我们处理。`;
}

async function copyReview(order) {
  try {
    await navigator.clipboard.writeText(reviewCopy(order));
    toast('回访文案已复制');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = reviewCopy(order);
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toast('回访文案已复制');
  }
}

async function autoAssign() {
  const button = $('#autoAssignBtn');
  button.disabled = true;
  try {
    const result = await api('/api/orders/auto-assign', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    applyState(result.state);
    toast(result.assigned ? `已自动分配 ${result.assigned} 个订单` : result.message || '没有待派单订单');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text || '').replace(/^\ufeff/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => String(cell).trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => String(cell).trim())) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  taobaoOrderNo: ['淘宝订单号', '订单编号', '订单号', '淘宝订单编号', '主订单编号', 'orderno'],
  shop: ['店铺', '店铺名称', '商家', '商家名称'],
  product: ['商品名称', '商品', '宝贝标题', '宝贝名称', '任务名称', 'product'],
  sku: ['sku', '规格', '商品规格', 'sku规格', '销售属性'],
  buyerNick: ['买家昵称', '买家会员名', '买家', '会员名', 'buyer'],
  amount: ['实付金额', '金额', '订单金额', '付款金额', 'amount'],
  receiver: ['收货人', '收件人', '收货人姓名', 'receiver'],
  region: ['地区', '省份', '收货地区', '收货地址', 'region'],
  note: ['备注', '订单备注', '卖家备注', 'note'],
  priority: ['优先级', 'priority'],
  dueDate: ['截止日期', '截止时间', '交付日期', 'duedate'],
  operatorId: ['执行人', '负责人', 'operator'],
  status: ['状态', '任务状态', 'status'],
};

function normalizeHeader(header) {
  return String(header || '')
    .replace(/^\ufeff/, '')
    .replace(/[\s_\-()（）]/g, '')
    .toLowerCase();
}

function headerField(header) {
  const normalized = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) return field;
  }
  return null;
}

function mapCsvRows(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  const header = rows[0];
  const fields = header.map(headerField);
  if (!fields.some(Boolean)) {
    throw new Error('没有识别到可用表头，请检查第一行字段名');
  }
  return rows.slice(1).map((cells) => {
    const order = {};
    fields.forEach((field, index) => {
      if (field) order[field] = String(cells[index] ?? '').trim();
    });
    if (order.operatorId) {
      const found = state.operators.find(
        (operator) =>
          operator.id === order.operatorId ||
          operator.name.toLowerCase() === order.operatorId.toLowerCase(),
      );
      order.operatorId = found?.id || '';
    }
    if (order.status && !STATUSES.includes(order.status)) delete order.status;
    if (order.priority && !['普通', '加急'].includes(order.priority)) delete order.priority;
    return order;
  });
}

async function importCsv(event) {
  event.preventDefault();
  const text = $('#csvText').value;
  let orders;
  try {
    orders = mapCsvRows(text).filter((order) => order.product || order.taobaoOrderNo);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  if (!orders.length) {
    toast('没有可导入的有效订单', 'error');
    return;
  }
  try {
    const result = await api('/api/orders/import', {
      method: 'POST',
      body: JSON.stringify({ orders }),
    });
    applyState(result.state);
    $('#importDialog').close();
    $('#csvText').value = '';
    $('#csvFile').value = '';
    toast(`导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function downloadTemplate() {
  const headers = [
    '淘宝订单号',
    '店铺',
    '商品名称',
    'SKU',
    '买家昵称',
    '实付金额',
    '收货人',
    '地区',
    '优先级',
    '截止日期',
    '备注',
  ];
  const sample = [
    '3829104756201938475',
    '示例店铺',
    '夏日纯棉短袖 T 恤',
    '白色 / M',
    'test_buyer',
    '89.00',
    '张三',
    '浙江 杭州',
    '普通',
    addDays(todayString(), 3),
    '拍摄白底图 2 张 + 场景图 1 张',
  ];
  const csv = `\ufeff${headers.join(',')}\r\n${sample.join(',')}\r\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '派单导入模板.csv';
  link.click();
  URL.revokeObjectURL(url);
}

async function openTeamDialog() {
  $('#teamDialog').showModal();
  renderTeamEditor();
}

function renderTeamEditor() {
  const editor = $('#teamEditor');
  if (!state.operators.length) {
    editor.innerHTML = '<div class="team-empty">还没有执行人。</div>';
    return;
  }
  editor.innerHTML = state.operators
    .map(
      (operator) => `
      <div class="team-editor-row" data-id="${escapeHtml(operator.id)}">
        <input type="text" value="${escapeHtml(operator.name)}" maxlength="40" data-role="name" aria-label="执行人名称" />
        <label><input type="checkbox" data-role="active" ${operator.active ? 'checked' : ''} /> 启用</label>
        <button type="button" class="icon-btn danger" data-role="delete" aria-label="删除执行人" title="删除">${ICONS.trash}</button>
      </div>`,
    )
    .join('');
}

async function createOperator() {
  const input = $('#newOperatorName');
  const name = input.value.trim();
  if (!name) {
    toast('请输入执行人名称', 'error');
    return;
  }
  try {
    const result = await api('/api/operators', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    applyState(result.state);
    input.value = '';
    renderTeamEditor();
    toast('执行人已添加');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function updateOperator(id, patch, options = {}) {
  try {
    const result = await api(`/api/operators/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    applyState(result.state);
    if (options.rerenderEditor) renderTeamEditor();
    if (!options.silent) toast('执行人已更新');
  } catch (error) {
    toast(error.message, 'error');
    renderTeamEditor();
  }
}

async function deleteOperator(operator) {
  if (!window.confirm(`确认删除执行人「${operator.name}」？`)) return;
  try {
    const result = await api(`/api/operators/${operator.id}`, { method: 'DELETE' });
    applyState(result.state);
    renderTeamEditor();
    toast('执行人已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setupEvents() {
  $('#todayLabel').textContent = formatDateLabel();

  $('#newOrderBtn').addEventListener('click', () => openOrderDialog());
  $('#emptyAddBtn').addEventListener('click', () => openOrderDialog());
  $('#orderForm').addEventListener('submit', saveOrder);
  $('#autoAssignBtn').addEventListener('click', autoAssign);
  $('#exportBtn').addEventListener('click', () => {
    window.location.href = '/api/export.csv';
  });

  $('#statusTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    state.filter.status = button.dataset.status;
    renderStatusTabs();
    renderOrders();
  });

  let searchTimer;
  $('#searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.search = event.target.value;
      renderOrders();
    }, 110);
  });

  $('#operatorFilter').addEventListener('change', (event) => {
    state.filter.operator = event.target.value;
    renderOrders();
  });

  $('#overdueFilter').addEventListener('change', (event) => {
    state.filter.overdue = event.target.checked;
    renderOrders();
  });

  $('#orderRows').addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const order = state.orders.find((item) => item.id === actionButton.dataset.id);
    if (!order) return;
    const action = actionButton.dataset.action;

    if (action === 'menu') {
      const container = actionButton.closest('.row-actions');
      $$('.row-actions.open').forEach((item) => {
        if (item !== container) item.classList.remove('open');
      });
      container.classList.toggle('open');
      event.stopPropagation();
      return;
    }
    if (action === 'edit') openOrderDialog(order);
    if (action === 'copy') copyReview(order);
    if (action === 'delete') deleteOrder(order);
    actionButton.closest('.row-actions')?.classList.remove('open');
  });

  $('#orderRows').addEventListener('change', (event) => {
    const select = event.target.closest('select[data-action]');
    if (!select) return;
    const id = select.dataset.id;
    if (select.dataset.action === 'operator') {
      updateOrder(id, { operatorId: select.value });
    }
    if (select.dataset.action === 'status') {
      updateOrder(id, { status: select.value });
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.row-actions')) {
      $$('.row-actions.open').forEach((item) => item.classList.remove('open'));
    }
  });

  $('#teamList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-operator-id]');
    if (!item) return;
    state.filter.operator = item.dataset.operatorId;
    renderOperatorFilter();
    renderOrders();
    document.querySelector('.orders-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#manageTeamBtn').addEventListener('click', openTeamDialog);
  $('#addOperatorBtn').addEventListener('click', openTeamDialog);
  $('#createOperatorBtn').addEventListener('click', createOperator);
  $('#newOperatorName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createOperator();
    }
  });

  $('#teamEditor').addEventListener('change', (event) => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    const operator = state.operators.find((item) => item.id === row.dataset.id);
    if (!operator) return;
    if (event.target.dataset.role === 'active') {
      updateOperator(operator.id, { active: event.target.checked });
    }
    if (event.target.dataset.role === 'name') {
      const name = event.target.value.trim();
      if (name && name !== operator.name) updateOperator(operator.id, { name });
      else event.target.value = operator.name;
    }
  });

  $('#teamEditor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-role="delete"]');
    if (!button) return;
    const row = button.closest('[data-id]');
    const operator = state.operators.find((item) => item.id === row.dataset.id);
    if (operator) deleteOperator(operator);
  });

  $('#importBtn').addEventListener('click', () => $('#importDialog').showModal());
  $('#importForm').addEventListener('submit', importCsv);
  $('#downloadTemplateBtn').addEventListener('click', downloadTemplate);

  $('#csvFile').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $('#csvText').value = await file.text();
  });

  const dropZone = $('#fileDrop');
  ['dragenter', 'dragover'].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });
  dropZone.addEventListener('drop', async (event) => {
    const file = event.dataTransfer.files[0];
    if (file) $('#csvText').value = await file.text();
  });

  $$('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });

  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
    }
  });
}

setupEvents();
refresh();
