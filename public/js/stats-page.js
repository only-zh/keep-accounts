/**
 * stats-page.js —— 统计页（范围 / 筛选 / 指标卡 / 图表 / 大额消费 / 分类明细 / 明细）
 *
 * 设计要点：
 *  1. 外壳（范围选择 + 筛选栏）只在 render() 时建立一次，输入框永远不参与「结果区」重绘，
 *     所以用户打字时不会丢焦点、不会跳光标；refresh() 只重绘结果区。
 *  2. 所有数字都来自 shared/stats.js 的 computeStats()，页面自身不做任何聚合，
 *     保证与 /api/stats、聊天问答的口径完全一致。
 *  3. 图表统一走 charts.js，实例存在 Map 里，重绘前先 destroy()，
 *     避免 ResizeObserver 与 document 级监听泄漏。
 *  4. 所有数据文案一律走 textContent / createTextNode，绝不把数据拼进 innerHTML。
 *
 * 依赖：./charts.js、../../shared/stats.js、../../shared/date.js、../../shared/categories.js
 * （相对路径在 web 服务器 /shared/* 与 APK assets/ui/shared/ 两种部署下都成立）
 */

import {
  renderBarChart,
  renderPieChart,
  renderLineChart,
  renderCalendar,
  formatMoney,
  formatCompact,
  PALETTE,
} from './charts.js';
import { computeStats, presetRange, DEFAULT_LARGE_CENTS } from '../../shared/stats.js';
import { ymdAddMonths, monthRange } from '../../shared/date.js';
import { CATEGORY_TREE, iconOf } from '../../shared/categories.js';

// ============================================================================
// §1 常量
// ============================================================================

/** 预设时间范围（key 与 shared/stats.js 的 presetRange 一一对应） */
const RANGE_PRESETS = Object.freeze([
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '本周' },
  { key: 'last_week', label: '上周' },
  { key: 'month', label: '本月' },
  { key: 'last_month', label: '上个月' },
  { key: 'last7', label: '近 7 天' },
  { key: 'last30', label: '近 30 天' },
  { key: 'year', label: '今年' },
  { key: 'all', label: '全部' },
]);

/** 记录类型筛选（与 records.type 的取值一致） */
const TYPE_OPTIONS = Object.freeze([
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'refund', label: '退款' },
  { value: 'transfer', label: '转账' },
]);

/** 默认范围：本月 */
const DEFAULT_RANGE_KEY = 'month';
/** 实时筛选项的防抖时长（毫秒） */
const FILTER_DEBOUNCE_MS = 150;
/** 明细列表每次展开的条数 */
const DETAIL_PAGE_SIZE = 40;
/** 趋势图点数超过该值就按月聚合 */
const TREND_DAILY_MAX = 92;
/** 按月的点数超过该值就按年聚合 */
const TREND_MONTH_MAX = 60;
/** 星期展示顺序：周一开头 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** 金额输入上限（1000 万元），防手滑输入天文数字 */
const AMOUNT_MAX_CENTS = 1000000000;
/** 分类筛选项（含收入类别，和 records.category 对齐） */
const CATEGORY_OPTIONS = Object.freeze(
  CATEGORY_TREE.map((def) => ({ name: def.name, icon: def.icon })),
);
/** CSS 文件相对路径：web 为 /css/stats.css，APK 为 ui/css/stats.css，两者都成立 */
const STYLESHEET_HREF = 'css/stats.css';

// ============================================================================
// §2 通用工具（纯函数 / 无副作用）
// ============================================================================

/** 清空子节点 */
function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 创建元素（唯一允许的 DOM 构造入口）。
 * @param {string} tag 标签名
 * @param {{class?:string, text?:string|number, attrs?:object, style?:object, on?:object}} [props]
 * @param {Array<Node|string|number|null|undefined|false>|Node|string} [children]
 * @returns {HTMLElement}
 */
function h(tag, props, children) {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined && props.text !== null) el.textContent = String(props.text);
    if (props.attrs) {
      for (const key of Object.keys(props.attrs)) {
        const value = props.attrs[key];
        if (value === null || value === undefined || value === false) continue;
        el.setAttribute(key, String(value));
      }
    }
    if (props.style) Object.assign(el.style, props.style);
    if (props.on) {
      for (const key of Object.keys(props.on)) el.addEventListener(key, props.on[key]);
    }
  }
  if (children !== undefined && children !== null) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    }
  }
  return el;
}

/** 金额（分 → ¥ 文本） */
function money(cents) {
  return formatMoney(cents);
}

/** 占比（0~1 → 百分比文本） */
function percentText(share) {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const pct = share * 100;
  return `${pct.toFixed(pct >= 10 ? 0 : 1).replace(/\.0$/, '')}%`;
}

/** 环图圆心总额：短金额保留两位小数，过长改用紧凑写法，避免被裁成「¥27,501…」 */
function centerTotalText(cents) {
  const full = formatMoney(cents);
  return full.length <= 8 ? full : formatCompact(cents);
}

/** 元（字符串） → 分；空 / 非法返回 null */
function parseYuanToCents(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(AMOUNT_MAX_CENTS, Math.round(n * 100));
}

/** 分 → 元输入框文本 */
function centsToYuanText(cents) {
  return Number.isFinite(cents) ? String(cents / 100) : '';
}

/** 是否 'YYYY-MM-DD' */
function isYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 本地今天（仅当调用方没给 today 时兜底） */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM' → '2025 年 3 月' */
function monthLabel(month) {
  const text = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(text)) return '—';
  return `${text.slice(0, 4)} 年 ${Number(text.slice(5, 7))} 月`;
}

/** 环比信息：文字 / 方向 / 说明（deltaPct 为 null 时显示 —） */
function deltaInfo(compare) {
  if (!compare) return { text: '—', dir: 'flat', hint: '环比上一段' };
  if (compare.deltaPct === null || !Number.isFinite(compare.deltaPct)) {
    return { text: '—', dir: 'flat', hint: `上期 ${money(compare.cents)}` };
  }
  const pct = compare.deltaPct * 100;
  const dir = pct > 0.05 ? 'up' : (pct < -0.05 ? 'down' : 'flat');
  const sign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
  const abs = Math.abs(pct);
  return {
    text: `${sign}${abs >= 100 ? abs.toFixed(0) : abs.toFixed(1)}%`,
    dir,
    hint: `环比 ${compare.from} ~ ${compare.to}`,
  };
}

/** 明细 / 大额排序：日期倒序，同日按 id 倒序 */
function byRecordDesc(a, b) {
  const da = String(a.occurredDate || '');
  const db = String(b.occurredDate || '');
  if (da !== db) return da < db ? 1 : -1;
  return Number(b.id || 0) - Number(a.id || 0);
}

/** 图表容器里写入错误占位（图表初始化失败时兜底） */
function chartFallback(body) {
  clearNode(body);
  body.appendChild(h('div', { class: 'st-chart-empty', text: '图表暂不可用' }));
}

// ============================================================================
// §3 统计页
// ============================================================================

/**
 * 创建统计页控制器。
 *
 * @param {Object} options
 * @param {HTMLElement} options.mount 挂载点（已在 DOM 中、初始为空）
 * @param {() => {
 *   records: any[], users: any[], books: any[], activeBookId: number|string|null,
 *   config?: { largeThresholdCents?: number }, today: string,
 * }} options.getState 每次重绘时读取的只读快照（records 由调用方保证只含未删除记录）
 * @param {(recordId: number|string) => void} [options.onOpenRecord] 点击明细 / 大额行时回调
 * @returns {{ render: () => void, refresh: () => void, destroy: () => void }}
 *   render() 全量重建并首绘；refresh() 保持当前范围 / 筛选重绘；destroy() 释放图表与监听。
 */
export function createStatsPage(options) {
  const opts = options || {};
  const mount = opts.mount;
  const getState = typeof opts.getState === 'function' ? opts.getState : () => ({});
  const onOpenRecord = typeof opts.onOpenRecord === 'function' ? opts.onOpenRecord : null;

  // 没有挂载点也要返回合法接口，避免调用方崩溃
  if (!mount || typeof mount.appendChild !== 'function') {
    return { render() {}, refresh() {}, destroy() {} };
  }

  /** 页面内部状态：范围 / 筛选 / 图表口径，refresh 之间保持不变 */
  const ui = {
    rangeKey: DEFAULT_RANGE_KEY,
    custom: { from: '', to: '' },
    calendarMonth: null,      // null 表示跟随区间结束月
    memberMetric: 'share',    // share=我该承担的，paid=我付的
    detailsLimit: DETAIL_PAGE_SIZE,
    filters: {
      accountIds: [],
      categories: [],
      types: [],
      minCents: null,
      maxCents: null,
      keyword: '',
      largeOnly: false,
    },
  };

  let refs = null;                 // 外壳元素引用
  let snapshot = null;             // 最近一次 getState() 归一化结果
  let lastStats = null;            // 最近一次 computeStats() 结果（供局部重绘用）
  const charts = new Map();        // key → {destroy()}
  let memberRefs = null;           // 成员图：{ body, segs }
  let calendarRefs = null;         // 日历：{ body, label }
  let debounceTimer = 0;
  let destroyed = false;

  // ------------------------------------------------------------------ 状态读取

  /** 归一化 getState() 快照，缺字段也安全 */
  function readSnapshot() {
    const raw = getState() || {};
    const records = Array.isArray(raw.records) ? raw.records : [];
    const users = Array.isArray(raw.users) ? raw.users : [];
    const userMap = new Map();
    for (const user of users) {
      if (user && user.id !== undefined && user.id !== null) userMap.set(Number(user.id), user);
    }
    const config = raw.config && typeof raw.config === 'object' ? raw.config : {};
    const threshold = Number(config.largeThresholdCents);
    return {
      records,
      users,
      userMap,
      books: Array.isArray(raw.books) ? raw.books : [],
      activeBookId: raw.activeBookId === undefined ? null : raw.activeBookId,
      largeThresholdCents: Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_LARGE_CENTS,
      today: isYmd(raw.today) ? raw.today : localToday(),
    };
  }

  /** 求值当前范围 */
  function resolveRange(snap) {
    if (ui.rangeKey === 'custom') {
      let from = ui.custom.from;
      let to = ui.custom.to;
      if (!isYmd(from) && !isYmd(to)) {
        const fallback = presetRange(DEFAULT_RANGE_KEY, snap.today);
        return { from: fallback.from, to: fallback.to, label: '自定义' };
      }
      if (!isYmd(from)) from = to;
      if (!isYmd(to)) to = from;
      if (from > to) { const tmp = from; from = to; to = tmp; }
      return { from, to, label: '自定义' };
    }
    const preset = presetRange(ui.rangeKey, snap.today);
    return { from: preset.from, to: preset.to, label: preset.label };
  }

  /** 内部状态 → computeStats 的 filters（空值不下发，交给 filterRecords 忽略） */
  function buildFilters(snap) {
    const f = ui.filters;
    const out = {};
    if (snap.activeBookId !== null && snap.activeBookId !== undefined) out.bookId = snap.activeBookId;
    if (f.accountIds.length) out.accountIds = f.accountIds.map(Number);
    if (f.categories.length) out.categories = f.categories.slice();
    if (f.types.length) out.types = f.types.slice();
    let minCents = Number.isFinite(f.minCents) ? f.minCents : null;
    let maxCents = Number.isFinite(f.maxCents) ? f.maxCents : null;
    if (minCents !== null && maxCents !== null && minCents > maxCents) {
      const tmp = minCents; minCents = maxCents; maxCents = tmp;
    }
    if (minCents !== null) out.minCents = minCents;
    if (maxCents !== null) out.maxCents = maxCents;
    const keyword = f.keyword.trim();
    if (keyword) out.keyword = keyword;
    if (f.largeOnly) out.largeOnly = true;
    return out;
  }

  /** 唯一的数据出口：全部指标 / 图表都基于它 */
  function computeFor(snap, range) {
    return computeStats(snap.records, {
      from: range.from,
      to: range.to,
      filters: buildFilters(snap),
      users: snap.users,
      largeThresholdCents: snap.largeThresholdCents,
      compare: true,
    });
  }

  // ------------------------------------------------------------------ 调度

  /** 立即重绘（chip 切换、日期应用等） */
  function refresh() {
    if (destroyed || !refs) return;
    ui.detailsLimit = DETAIL_PAGE_SIZE;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = 0; }
    snapshot = readSnapshot();
    syncControls(snapshot);
    paint(snapshot);
  }

  /** 防抖重绘（金额 / 关键词输入） */
  function scheduleRefresh() {
    if (destroyed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      refresh();
    }, FILTER_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------ 图表实例管理

  function destroyChart(key) {
    const instance = charts.get(key);
    charts.delete(key);
    if (instance && typeof instance.destroy === 'function') {
      try {
        instance.destroy();
      } catch (err) {
        /* 单个图表清理失败不影响整页 */
      }
    }
  }

  function destroyAllCharts() {
    for (const key of [...charts.keys()]) destroyChart(key);
  }

  /** 渲染图表并登记实例；异常时降级为占位文案 */
  function safeChart(key, body, factory) {
    try {
      const instance = factory();
      if (instance && typeof instance.destroy === 'function') charts.set(key, instance);
      return instance;
    } catch (err) {
      console.error('[stats] 图表渲染失败：', key, err);
      chartFallback(body);
      return null;
    }
  }

  // ------------------------------------------------------------------ 外壳（只建一次）

  function buildShell(snap) {
    clearNode(mount);
    const rangeChips = new Map();
    const rangeChipRow = h('div', { class: 'st-chips', attrs: { role: 'group', 'aria-label': '时间范围' } });
    for (const preset of RANGE_PRESETS) {
      const chip = makeChip({
        label: preset.label,
        active: preset.key === ui.rangeKey,
        onClick: () => applyRangeKey(preset.key),
      });
      rangeChips.set(preset.key, chip);
      rangeChipRow.appendChild(chip);
    }
    const customChip = makeChip({
      label: '自定义',
      active: ui.rangeKey === 'custom',
      onClick: () => applyRangeKey('custom'),
    });
    rangeChips.set('custom', customChip);
    rangeChipRow.appendChild(customChip);

    const fromInput = h('input', {
      class: 'st-date',
      attrs: { type: 'date', 'aria-label': '起始日期' },
      on: { change: () => { ui.custom.from = fromInput.value; scheduleRefresh(); } },
    });
    const toInput = h('input', {
      class: 'st-date',
      attrs: { type: 'date', 'aria-label': '结束日期' },
      on: { change: () => { ui.custom.to = toInput.value; scheduleRefresh(); } },
    });
    const applyCustom = h('button', {
      class: 'st-btn st-btn--primary',
      text: '应用',
      attrs: { type: 'button' },
      on: {
        click: () => {
          ui.custom.from = fromInput.value;
          ui.custom.to = toInput.value;
          ui.rangeKey = 'custom';
          ui.calendarMonth = null;
          refresh();
        },
      },
    });
    const customPanel = h('div', { class: 'st-custom is-hidden' }, [
      fromInput,
      h('span', { class: 'st-custom__sep', text: '~' }),
      toInput,
      applyCustom,
    ]);

    const resolved = h('span', { class: 'st-range-resolved' });

    const rangePanel = h('section', { class: 'st-panel' }, [
      h('div', { class: 'st-panel__head' }, [
        h('h2', { class: 'st-panel__title', text: '时间范围' }),
        resolved,
      ]),
      rangeChipRow,
      customPanel,
    ]);

    // ---------------- 筛选 ----------------
    const memberChips = new Map();
    const filterBlocks = [];
    if (snap.users.length) {
      const row = h('div', { class: 'st-scroll' });
      for (const user of snap.users) {
        if (!user || user.id === undefined || user.id === null) continue;
        const id = Number(user.id);
        const chip = makeChip({
          label: String(user.name || '未知'),
          emoji: String(user.emoji || '🙂'),
          active: ui.filters.accountIds.includes(id),
          onClick: () => toggleFilterValue('accountIds', id),
        });
        memberChips.set(id, chip);
        row.appendChild(chip);
      }
      filterBlocks.push(filterGroup('成员', row));
    }

    const categoryChips = new Map();
    const categoryRow = h('div', { class: 'st-scroll' });
    for (const item of CATEGORY_OPTIONS) {
      const chip = makeChip({
        label: item.name,
        emoji: item.icon,
        active: ui.filters.categories.includes(item.name),
        onClick: () => toggleFilterValue('categories', item.name),
      });
      categoryChips.set(item.name, chip);
      categoryRow.appendChild(chip);
    }
    filterBlocks.push(filterGroup('类别', categoryRow));

    const typeChips = new Map();
    const typeRow = h('div', { class: 'st-scroll' });
    for (const item of TYPE_OPTIONS) {
      const chip = makeChip({
        label: item.label,
        active: ui.filters.types.includes(item.value),
        onClick: () => toggleFilterValue('types', item.value),
      });
      typeChips.set(item.value, chip);
      typeRow.appendChild(chip);
    }
    filterBlocks.push(filterGroup('类型', typeRow));

    const minInput = h('input', {
      class: 'st-input st-input--num',
      attrs: { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '最低 (元)', 'aria-label': '最小金额（元）' },
      on: { input: () => { ui.filters.minCents = parseYuanToCents(minInput.value); scheduleRefresh(); } },
    });
    const maxInput = h('input', {
      class: 'st-input st-input--num',
      attrs: { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '最高 (元)', 'aria-label': '最大金额（元）' },
      on: { input: () => { ui.filters.maxCents = parseYuanToCents(maxInput.value); scheduleRefresh(); } },
    });
    const keywordInput = h('input', {
      class: 'st-input st-input--kw',
      attrs: { type: 'search', placeholder: '搜索备注 / 商家 / 类别', 'aria-label': '关键词', enterkeyhint: 'search' },
      on: { input: () => { ui.filters.keyword = keywordInput.value; scheduleRefresh(); } },
    });

    const largeOnlyChip = makeChip({
      label: '仅看大额',
      active: ui.filters.largeOnly,
      onClick: () => {
        ui.filters.largeOnly = !ui.filters.largeOnly;
        refresh();
      },
    });
    const resetBtn = h('button', {
      class: 'st-btn st-btn--ghost',
      text: '重置',
      attrs: { type: 'button', 'aria-label': '重置筛选条件' },
      on: { click: () => resetFilters() },
    });

    const filterPanel = h('section', { class: 'st-panel' }, [
      h('div', { class: 'st-panel__head' }, [
        h('h2', { class: 'st-panel__title', text: '筛选' }),
      ]),
      ...filterBlocks,
      h('div', { class: 'st-filter-row' }, [
        h('div', { class: 'st-amount' }, [
          minInput,
          h('span', { class: 'st-custom__sep', text: '~' }),
          maxInput,
        ]),
        keywordInput,
      ]),
      h('div', { class: 'st-filter-actions' }, [largeOnlyChip, resetBtn]),
    ]);

    const results = h('div', { class: 'st-results' });

    refs = {
      rangeChips,
      customChip,
      customPanel,
      fromInput,
      toInput,
      resolved,
      memberChips,
      categoryChips,
      typeChips,
      largeOnlyChip,
      minInput,
      maxInput,
      keywordInput,
      results,
    };

    mount.appendChild(h('div', { class: 'st-page' }, [rangePanel, filterPanel, results]));
    ensureStylesheet();
  }

  /** chip 工厂 */
  function makeChip(spec) {
    const chip = h('button', {
      class: `st-chip${spec.active ? ' is-active' : ''}`,
      attrs: { type: 'button', 'aria-pressed': spec.active ? 'true' : 'false' },
    }, [
      spec.emoji ? h('span', { class: 'st-chip__emoji', text: spec.emoji }) : null,
      h('span', { class: 'st-chip__text', text: spec.label }),
    ]);
    if (typeof spec.onClick === 'function') chip.addEventListener('click', spec.onClick);
    return chip;
  }

  /** 「标签 + 横向滚动 chip 行」 */
  function filterGroup(label, row) {
    return h('div', { class: 'st-filter-group' }, [
      h('div', { class: 'st-filter-label', text: label }),
      row,
    ]);
  }

  /** 静态样式表兜底：宿主页面若已引入则什么都不做 */
  function ensureStylesheet() {
    try {
      if (document.querySelector('link[data-stats-css], link[href$="stats.css"]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = STYLESHEET_HREF;
      link.setAttribute('data-stats-css', '1');
      document.head.appendChild(link);
    } catch (err) {
      /* 拿不到 document.head 就交给宿主页面负责样式 */
    }
  }

  // ------------------------------------------------------------------ 控件状态同步

  function setPressed(el, on) {
    if (!el) return;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setInputValue(input, value) {
    if (input && input.value !== value) input.value = value;
  }

  /** 把 ui 状态写回外壳（不动 text 输入框，避免打断输入） */
  function syncControls(snap) {
    if (!refs) return;
    const range = resolveRange(snap);
    for (const [key, chip] of refs.rangeChips) setPressed(chip, key === ui.rangeKey);
    refs.customPanel.classList.toggle('is-hidden', ui.rangeKey !== 'custom');
    setInputValue(refs.fromInput, ui.custom.from || '');
    setInputValue(refs.toInput, ui.custom.to || '');
    refs.resolved.textContent = `${range.from} ~ ${range.to}`;
    for (const [id, chip] of refs.memberChips) setPressed(chip, ui.filters.accountIds.includes(id));
    for (const [name, chip] of refs.categoryChips) setPressed(chip, ui.filters.categories.includes(name));
    for (const [type, chip] of refs.typeChips) setPressed(chip, ui.filters.types.includes(type));
    setPressed(refs.largeOnlyChip, ui.filters.largeOnly);
  }

  // ------------------------------------------------------------------ 交互

  function applyRangeKey(key) {
    if (key === 'custom') {
      if (ui.rangeKey !== 'custom') {
        const current = resolveRange(snapshot || readSnapshot());
        ui.custom = { from: current.from, to: current.to };
      }
      ui.rangeKey = 'custom';
    } else {
      if (ui.rangeKey === key) return;
      ui.rangeKey = key;
    }
    ui.calendarMonth = null;
    refresh();
  }

  function setCustomRange(from, to) {
    ui.rangeKey = 'custom';
    ui.custom = { from, to };
    ui.calendarMonth = null;
    refresh();
  }

  /** 日历点某天 → 只统计该天（并激活「自定义」chip） */
  function applySingleDay(day) {
    if (!isYmd(day)) return;
    setCustomRange(day, day);
  }

  /** 趋势图点某月 → 该自然月 */
  function applyMonth(month) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) return;
    const range = monthRange(`${month}-01`);
    setCustomRange(range.from, range.to);
  }

  /** 趋势图点某年 → 该自然年（x 形如 '2025 年'） */
  function applyYear(year) {
    const matched = /^(\d{4})/.exec(String(year === undefined || year === null ? '' : year));
    if (!matched) return;
    setCustomRange(`${matched[1]}-01-01`, `${matched[1]}-12-31`);
  }

  /** 趋势图数据点点击：按聚合粒度决定落到天 / 月 / 年 */
  function applyTrendPoint(value, unit, lookup) {
    const text = String(value === undefined || value === null ? '' : value);
    if (unit === 'day') {
      const full = lookup && typeof lookup.get === 'function' ? lookup.get(text) : null;
      if (full) applySingleDay(full);
    } else if (unit === 'month') {
      applyMonth(text);
    } else if (unit === 'year') {
      applyYear(text);
    }
  }

  /** 环图选扇区 → 把分类筛选聚焦到该类别（再次点击取消） */
  function applyCategoryFocus(category) {
    if (!category) return;
    const only = ui.filters.categories.length === 1 && ui.filters.categories[0] === category;
    ui.filters.categories = only ? [] : [category];
    refresh();
  }

  /** 多选筛选项的增删 */
  function toggleFilterValue(field, value) {
    const list = ui.filters[field];
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
    else list.push(value);
    refresh();
  }

  function resetFilters() {
    ui.filters.accountIds = [];
    ui.filters.categories = [];
    ui.filters.types = [];
    ui.filters.minCents = null;
    ui.filters.maxCents = null;
    ui.filters.keyword = '';
    ui.filters.largeOnly = false;
    if (refs) {
      setInputValue(refs.minInput, '');
      setInputValue(refs.maxInput, '');
      setInputValue(refs.keywordInput, '');
    }
    refresh();
  }

  // ------------------------------------------------------------------ 结果区

  function paint(snap) {
    const range = resolveRange(snap);
    const stats = computeFor(snap, range);
    lastStats = stats;
    destroyAllCharts();
    memberRefs = null;
    calendarRefs = null;
    const results = refs.results;
    clearNode(results);

    if (!stats.records.length) {
      results.appendChild(renderEmptyState());
      return;
    }

    results.appendChild(h('div', { class: 'st-summary' }, [
      h('span', { class: 'st-summary__range', text: `${range.from} ~ ${range.to}` }),
      h('span', { class: 'st-summary__sep', text: '·' }),
      h('span', { text: `共 ${stats.count} 笔记录` }),
    ]));
    results.appendChild(renderMetrics(stats, snap));
    results.appendChild(renderCharts(stats, snap, range));
    results.appendChild(renderLargeSection(stats, snap));
    results.appendChild(renderCategorySection(stats));
    results.appendChild(renderDetailsSection(stats, snap));
  }

  /** 全量空状态（筛选栏仍然保留在外壳里） */
  function renderEmptyState() {
    return h('section', { class: 'st-card st-empty' }, [
      h('div', { class: 'st-empty__emoji', text: '🔍' }),
      h('div', { class: 'st-empty__title', text: '这段时间没有符合条件的记录' }),
      h('div', { class: 'st-empty__hint', text: '试试放宽时间范围，或点「重置」清空筛选条件' }),
      h('button', {
        class: 'st-btn st-btn--primary',
        text: '重置筛选',
        attrs: { type: 'button' },
        on: { click: () => resetFilters() },
      }),
    ]);
  }

  /** 区块内的小空状态 */
  function inlineEmpty(text) {
    return h('div', { class: 'st-inline-empty', text });
  }

  // ------------------------------------------------------------------ 指标卡

  /**
   * 指标卡
   * @param {{label:string, value:string, sub?:Array, wide?:boolean, accent?:boolean, title?:string, valueClass?:string}} spec
   */
  function metricCard(spec) {
    const classes = ['st-metric'];
    if (spec.wide) classes.push('st-metric--wide');
    if (spec.accent) classes.push('st-metric--accent');
    return h('div', {
      class: classes.join(' '),
      attrs: spec.title ? { title: spec.title } : null,
    }, [
      h('div', { class: 'st-metric__label', text: spec.label }),
      h('div', { class: `st-metric__value${spec.valueClass ? ` ${spec.valueClass}` : ''}`, text: spec.value }),
      h('div', { class: 'st-metric__sub' }, spec.sub || []),
    ]);
  }

  function renderMetrics(stats, snap) {
    const grid = h('div', { class: 'st-metrics' });

    // 总支出 + 环比
    const delta = deltaInfo(stats.compare);
    grid.appendChild(metricCard({
      label: '总支出',
      value: money(stats.expenseCents),
      wide: true,
      sub: [
        h('span', { class: `st-delta is-${delta.dir}`, text: delta.text }),
        h('span', { class: 'st-metric__subtext', text: delta.hint }),
      ],
    }));

    // 餐食（头条指标，视觉加重）
    grid.appendChild(metricCard({
      label: '餐食支出',
      value: money(stats.meal.cents),
      wide: true,
      accent: true,
      sub: [
        h('span', { class: 'st-metric__subtext', text: `占支出 ${percentText(stats.meal.share)}` }),
        h('span', { class: 'st-metric__sep', text: '·' }),
        h('span', { class: 'st-metric__subtext', text: `${stats.meal.count} 笔` }),
      ],
    }));

    // 笔数 + 日均
    grid.appendChild(metricCard({
      label: '支出笔数',
      value: `${stats.expenseCount} 笔`,
      sub: [h('span', { class: 'st-metric__subtext', text: `日均 ${money(stats.avgPerDayCents)}` })],
    }));

    // 单笔均值 + 最大一笔
    const maxRecord = stats.maxRecord;
    grid.appendChild(metricCard({
      label: '单笔均值',
      value: money(stats.avgPerRecordCents),
      sub: [
        h('span', {
          class: 'st-metric__subtext',
          text: maxRecord
            ? `最大 ${money(maxRecord.amountCents)} · ${iconOf(maxRecord.category)}${maxRecord.category || '其他'}`
            : '最大一笔 —',
        }),
      ],
    }));

    // 大额消费
    grid.appendChild(metricCard({
      label: '大额消费',
      value: `${stats.large.count} 笔`,
      sub: [
        h('span', { class: 'st-metric__subtext', text: `合计 ${money(stats.large.cents)}` }),
        h('span', { class: 'st-metric__sep', text: '·' }),
        h('span', { class: 'st-metric__subtext', text: `≥ ${money(snap.largeThresholdCents)}` }),
      ],
    }));

    // 收入 / 结余
    const net = stats.netCents;
    grid.appendChild(metricCard({
      label: '收入',
      value: money(stats.incomeCents),
      sub: [
        h('span', { class: 'st-metric__subtext', text: '结余' }),
        h('span', {
          class: `st-net ${net > 0 ? 'is-positive' : (net < 0 ? 'is-negative' : '')}`,
          text: formatMoney(net, { signed: true }),
        }),
      ],
    }));

    return grid;
  }

  // ------------------------------------------------------------------ 图表区

  /** 图表卡片外壳 */
  function chartCard(title, actions, config) {
    const options2 = config || {};
    const head = h('div', { class: 'st-card__head' }, [
      h('h3', { class: 'st-card__title', text: title }),
      actions || null,
    ]);
    const body = h('div', { class: 'st-chart' });
    const card = h('section', { class: `st-card${options2.wide ? ' st-card--wide' : ''}` }, [head, body]);
    return { card, body };
  }

  /**
   * 趋势序列：天太多就按月、月太多就按年聚合，保证图表可读且不卡。
   * x 轴标签刻意取短（MM-DD / YYYY-MM / YYYY 年）：手机宽度下完整日期会被截断成
   * 「2025-03..」，短标签更易读；点击时再通过 lookup / 解析还原成完整日期。
   */
  function trendSeries(byDay) {
    const days = Array.isArray(byDay) ? byDay : [];
    if (days.length <= TREND_DAILY_MAX) {
      const lookup = new Map();
      const points = days.map((day) => {
        const full = String(day.date);
        const label = full.slice(5); // MM-DD
        lookup.set(label, full);
        return { x: label, y: day.cents };
      });
      return { unit: 'day', points, lookup };
    }
    const months = new Set(days.map((day) => String(day.date).slice(0, 7))).size;
    const byYear = months > TREND_MONTH_MAX;
    const buckets = new Map();
    for (const day of days) {
      const text = String(day.date);
      // 年维度加「年」字：避免被 charts.js 当成数值轴（否则刻度会出现 2020.5 这样的标签）
      const key = byYear ? `${text.slice(0, 4)} 年` : text.slice(0, 7);
      const current = buckets.get(key);
      if (current) current.y += day.cents;
      else buckets.set(key, { x: key, y: day.cents });
    }
    return { unit: byYear ? 'year' : 'month', points: [...buckets.values()], lookup: null };
  }

  function renderCharts(stats, snap, range) {
    const wrap = h('div', { class: 'st-charts' });

    // —— 每日消费趋势 ——
    const series = trendSeries(stats.byDay);
    const trend = chartCard('每日消费趋势', h('span', {
      class: 'st-card__hint',
      text: trendUnitLabel(series.unit),
    }), { wide: true });
    wrap.appendChild(trend.card);
    safeChart('trend', trend.body, () => renderLineChart(trend.body, {
      series: [{ name: series.unit === 'day' ? '每日支出' : '支出', points: series.points, color: PALETTE[0] }],
      area: true,
      valueFormat: formatCompact,
      height: 210,
      ariaLabel: '每日消费趋势',
      onSelect: (info) => applyTrendPoint(info && info.x, series.unit, series.lookup),
    }));

    // —— 分类占比（环图，点扇区 = 聚焦该类别）——
    const pie = chartCard('分类占比');
    wrap.appendChild(pie.card);
    safeChart('pie', pie.body, () => renderPieChart(pie.body, {
      data: stats.byCategory.map((item, index) => ({
        label: `${item.icon} ${item.category}`,
        value: item.cents,
        color: PALETTE[index % PALETTE.length],
        category: item.category,
      })),
      donut: true,
      centerLabel: '总支出',
      centerValue: stats.expenseCents,
      valueFormat: formatMoney,
      height: 230,
      ariaLabel: '分类占比环图',
      onSelect: (item) => applyCategoryFocus(item && item.category),
    }));

    // —— 成员消费（我该承担的 / 我付的）——
    const segments = [
      { key: 'share', label: '我该承担' },
      { key: 'paid', label: '我付的' },
    ];
    memberRefs = {
      body: null,
      segs: [],
      data: stats.byUser,
    };
    const segWrap = h('div', { class: 'st-seg', attrs: { role: 'group', 'aria-label': '成员统计口径' } });
    for (const segment of segments) {
      const button = h('button', {
        class: `st-seg__btn${ui.memberMetric === segment.key ? ' is-active' : ''}`,
        text: segment.label,
        attrs: { type: 'button', 'aria-pressed': ui.memberMetric === segment.key ? 'true' : 'false' },
      });
      button.addEventListener('click', () => {
        if (ui.memberMetric === segment.key) return;
        ui.memberMetric = segment.key;
        for (const item of memberRefs.segs) {
          setPressed(item.el, item.key === segment.key);
        }
        drawMemberChart();
      });
      memberRefs.segs.push({ key: segment.key, el: button });
      segWrap.appendChild(button);
    }
    const member = chartCard('成员消费', segWrap);
    memberRefs.body = member.body;
    wrap.appendChild(member.card);
    drawMemberChart();

    // —— 日历天维度 ——
    const calendar = renderCalendarCard(stats, snap, range);
    wrap.appendChild(calendar);

    // —— 星期分布 ——
    const weekday = chartCard('星期分布');
    wrap.appendChild(weekday.card);
    safeChart('weekday', weekday.body, () => renderBarChart(weekday.body, {
      data: WEEKDAY_ORDER
        .map((index) => stats.byWeekday[index])
        .filter(Boolean)
        .map((item) => ({ label: item.label, value: item.cents })),
      valueFormat: formatCompact,
      height: 170,
      ariaLabel: '星期分布柱状图',
    }));

    return wrap;
  }

  function trendUnitLabel(unit) {
    if (unit === 'month') return '按月聚合';
    if (unit === 'year') return '按年聚合';
    return '';
  }

  /** 成员消费横条（share=我该承担的 / paid=我付的） */
  function drawMemberChart() {
    if (!memberRefs || !memberRefs.body) return;
    const metric = ui.memberMetric;
    const rows = (memberRefs.data || []).slice().sort((a, b) => {
      const va = metric === 'paid' ? a.paidCents : a.shareCents;
      const vb = metric === 'paid' ? b.paidCents : b.shareCents;
      return (vb || 0) - (va || 0);
    });
    destroyChart('member');
    safeChart('member', memberRefs.body, () => renderBarChart(memberRefs.body, {
      data: rows.map((user, index) => ({
        label: `${user.emoji || '🙂'} ${user.name || '未知'}`,
        value: metric === 'paid' ? (user.paidCents || 0) : (user.shareCents || 0),
        color: user.color || PALETTE[index % PALETTE.length],
      })),
      horizontal: true,
      valueFormat: formatMoney,
      ariaLabel: metric === 'paid' ? '成员消费（我付的）' : '成员消费（我该承担的）',
    }));
  }

  /** 日历卡片：默认定位到区间结束月（未来区间则定位到本月），支持上/下月切换 */
  function renderCalendarCard(stats, snap, range) {
    const month = ui.calendarMonth || defaultCalendarMonth(range, snap);
    const label = h('span', { class: 'st-stepper__label', text: monthLabel(month) });
    const prev = h('button', {
      class: 'st-stepper__btn',
      text: '‹',
      attrs: { type: 'button', 'aria-label': '上个月' },
      on: { click: () => stepCalendarMonth(-1) },
    });
    const next = h('button', {
      class: 'st-stepper__btn',
      text: '›',
      attrs: { type: 'button', 'aria-label': '下个月' },
      on: { click: () => stepCalendarMonth(1) },
    });
    const card = chartCard('日历', h('div', { class: 'st-stepper' }, [prev, label, next]));
    calendarRefs = { body: card.body, label };
    drawCalendarChart(stats, range);
    return card.card;
  }

  function defaultCalendarMonth(range, snap) {
    const end = range.to > snap.today ? snap.today : range.to;
    return end.slice(0, 7);
  }

  function stepCalendarMonth(delta) {
    if (!snapshot || !calendarRefs) return;
    const range = resolveRange(snapshot);
    const month = ui.calendarMonth || defaultCalendarMonth(range, snapshot);
    const next = ymdAddMonths(`${month}-01`, delta).slice(0, 7);
    ui.calendarMonth = next;
    calendarRefs.label.textContent = monthLabel(next);
    if (lastStats) drawCalendarChart(lastStats, range);
  }

  function drawCalendarChart(stats, range) {
    if (!calendarRefs) return;
    const month = ui.calendarMonth || (snapshot ? defaultCalendarMonth(range, snapshot) : range.to.slice(0, 7));
    const single = range.from === range.to ? range.from : null;
    destroyChart('calendar');
    safeChart('calendar', calendarRefs.body, () => renderCalendar(calendarRefs.body, {
      month,
      days: stats.calendar,
      valueFormat: formatCompact,
      selected: single,
      height: 260,
      ariaLabel: `${month} 每日消费日历`,
      onSelect: (day) => applySingleDay(day),
    }));
  }

  // ------------------------------------------------------------------ 大额消费

  function renderLargeSection(stats, snap) {
    const rows = stats.large.records || [];
    const card = h('section', { class: 'st-card' }, [
      h('div', { class: 'st-card__head' }, [
        h('h3', { class: 'st-card__title', text: '大额消费' }),
        h('span', { class: 'st-card__hint', text: `≥ ${money(snap.largeThresholdCents)} · ${rows.length} 笔` }),
      ]),
    ]);
    if (!rows.length) {
      card.appendChild(inlineEmpty('这段时间没有大额消费'));
      return card;
    }
    const list = h('div', { class: 'st-list' });
    for (const record of rows) list.appendChild(recordRow(record, snap, { fullDate: true }));
    card.appendChild(list);
    return card;
  }

  // ------------------------------------------------------------------ 分类明细表

  function renderCategorySection(stats) {
    const rows = stats.byCategory || [];
    const card = h('section', { class: 'st-card' }, [
      h('div', { class: 'st-card__head' }, [
        h('h3', { class: 'st-card__title', text: '分类明细' }),
        h('span', { class: 'st-card__hint', text: `${rows.length} 个类别` }),
      ]),
    ]);
    if (!rows.length) {
      card.appendChild(inlineEmpty('这段时间没有支出'));
      return card;
    }
    const list = h('div', { class: 'st-cat-list' });
    for (const item of rows) {
      const share = Number.isFinite(item.share) ? item.share : 0;
      const row = h('button', {
        class: 'st-cat-row',
        attrs: {
          type: 'button',
          'aria-label': `${item.category} ${money(item.cents)} 占比 ${percentText(share)} ${item.count} 笔`,
        },
      }, [
        h('span', { class: 'st-cat-row__icon', text: item.icon || iconOf(item.category) }),
        h('span', { class: 'st-cat-row__name', text: item.category || '其他' }),
        h('span', { class: 'st-cat-row__amount', text: money(item.cents) }),
        h('span', { class: 'st-cat-row__bar' }, [
          h('span', { class: 'st-cat-row__fill', style: { width: `${Math.max(2, Math.min(100, share * 100))}%` } }),
        ]),
        h('span', { class: 'st-cat-row__meta' }, [
          h('span', { text: percentText(share) }),
          h('span', { class: 'st-metric__sep', text: '·' }),
          h('span', { text: `${item.count} 笔` }),
        ]),
      ]);
      row.addEventListener('click', () => applyCategoryFocus(item.category));
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  // ------------------------------------------------------------------ 明细列表

  function renderDetailsSection(stats, snap) {
    const card = h('section', { class: 'st-card' });
    card.appendChild(h('div', { class: 'st-card__head' }, [
      h('h3', { class: 'st-card__title', text: '明细' }),
      h('span', { class: 'st-card__hint', text: `共 ${stats.records.length} 笔` }),
    ]));
    const body = h('div', { class: 'st-details' });
    card.appendChild(body);
    renderDetailsBody(body, stats, snap);
    return card;
  }

  /** 明细体：只重绘这一块（「显示更多」不会重建图表） */
  function renderDetailsBody(body, stats, snap) {
    clearNode(body);
    const sorted = stats.records.slice().sort(byRecordDesc);
    const shown = sorted.slice(0, ui.detailsLimit);
    const list = h('div', { class: 'st-list' });
    for (const record of shown) list.appendChild(recordRow(record, snap, { fullDate: false }));
    body.appendChild(list);
    if (sorted.length > shown.length) {
      const rest = sorted.length - shown.length;
      const more = h('button', {
        class: 'st-btn st-btn--ghost st-more',
        text: `显示更多（还有 ${rest} 笔）`,
        attrs: { type: 'button' },
      });
      more.addEventListener('click', () => {
        ui.detailsLimit += DETAIL_PAGE_SIZE;
        renderDetailsBody(body, stats, snap);
      });
      body.appendChild(more);
    }
  }

  /**
   * 单条记录行（大额列表与明细列表共用）
   * @param {object} record
   * @param {object} snap 归一化快照
   * @param {{fullDate:boolean}} config
   */
  function recordRow(record, snap, config) {
    const user = snap.userMap.get(Number(record.payerAccountId));
    const isIncome = record.type === 'income' || record.type === 'refund';
    const title = record.subcategory
      ? `${record.category || '其他'} · ${record.subcategory}`
      : (record.category || '其他');
    const meta = [];
    if (record.type === 'income') meta.push('收入');
    else if (record.type === 'refund') meta.push('退款');
    else if (record.type === 'transfer') meta.push('转账');
    meta.push(user ? `${user.emoji || '🙂'} ${user.name || '未知'}` : '未知成员');
    const note = record.note || record.merchant || '';
    if (note) meta.push(note);
    const dateText = config && config.fullDate
      ? String(record.occurredDate || '')
      : String(record.occurredDate || '').slice(5);
    const amountText = `${isIncome ? '+' : ''}${money(record.amountCents)}`;

    const row = h('button', {
      class: 'st-row',
      attrs: {
        type: 'button',
        'aria-label': `${record.occurredDate || ''} ${title} ${amountText}`,
      },
    }, [
      h('span', { class: 'st-row__date', text: dateText }),
      h('span', { class: 'st-row__icon', text: iconOf(record.category) }),
      h('span', { class: 'st-row__body' }, [
        h('span', { class: 'st-row__title', text: title }),
        h('span', { class: 'st-row__meta', text: meta.join(' · ') }),
      ]),
      h('span', { class: `st-row__amount${isIncome ? ' is-in' : ''}`, text: amountText }),
    ]);
    if (onOpenRecord) {
      row.addEventListener('click', () => onOpenRecord(record.id));
    }
    return row;
  }

  // ------------------------------------------------------------------ 生命周期

  /** 全量重建 + 首绘（会重新读取 getState()，用于初始化或成员/账本变化后） */
  function render() {
    if (destroyed) return;
    snapshot = readSnapshot();
    buildShell(snapshot);
    syncControls(snapshot);
    paint(snapshot);
  }

  /** 释放图表、定时器与 DOM */
  function destroy() {
    destroyed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = 0;
    }
    destroyAllCharts();
    memberRefs = null;
    calendarRefs = null;
    lastStats = null;
    snapshot = null;
    refs = null;
    clearNode(mount);
  }

  return { render, refresh, destroy };
}

export default createStatsPage;
