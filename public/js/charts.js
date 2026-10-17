/**
 * charts.js —— 零依赖、纯手绘 SVG 的图表模块（深色主题优先，兼容浅色主题）
 *
 * 约定：
 *  1. 无构建、无 npm、无 CDN；所有图形用 document.createElementNS 绘制。
 *  2. 标签与数值一律走 textContent，绝不把数据拼进 innerHTML（防 XSS）。
 *  3. 自适应宽度：viewBox + preserveAspectRatio + ResizeObserver，320px ~ 900px 可用。
 *  4. 颜色读 CSS 变量（--text/--muted/--grid/--brand/--border/--card），读不到用安全回退值。
 *  5. 金额一律是「整数分」，展示统一走 formatMoney / formatCompact。
 *  6. opts.valueFormat 未提供时默认按「分」格式化（记账场景口径）；若传的是笔数等非金额，
 *     请自行传入 valueFormat。
 */

// ============================================================================
// §0 调色板
// ============================================================================

/** 12 色通用调色板：深色背景上对比清晰、彼此可区分，浅色背景亦可读 */
export const PALETTE = Object.freeze([
    '#FF8FAB', '#F2A65A', '#55B390', '#7FBFE8', '#C9A7EB', '#FFC94D',
    '#F27D8B', '#8ED9BC', '#E8A0C4', '#94B4F0', '#6FC7C9', '#D9A06A'
]);

// ============================================================================
// §1 通用工具：DOM / SVG / 主题 / 数字 / 刻度 / 文本
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_HEIGHT = 220;      // 默认高度，可用 opts.height 覆盖
const EMPTY_TEXT = '暂无数据';    // 空数据占位文案
const MOUNT_KEY = '__dshChartDestroy__'; // 挂在容器上的销毁钩子，保证重复调用可清理上一个实例
let uidSeq = 0;                  // 渐变 id 序号

/** 创建 SVG 元素；attrs 里 null/undefined/false 会被跳过 */
function svgNode(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
        for (const key of Object.keys(attrs)) {
            const value = attrs[key];
            if (value === null || value === undefined || value === false) continue;
            node.setAttribute(key, String(value));
        }
    }
    return node;
}

/** 创建 HTML 元素（只用于提示气泡这类非 SVG 结构） */
function htmlNode(tag, style, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (style) Object.assign(node.style, style);
    return node;
}

/** 清空子节点 */
function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** 数值安全化：非有限值回退到 fallback */
function toFinite(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** 区间钳制 */
function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

/** 保留两位小数，避免 path 出现超长浮点串 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/** 补零到两位 */
function pad2(value) {
    return String(value).padStart(2, '0');
}

/** 是否处于系统「减少动效」偏好 */
function prefersReducedMotion() {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {
        return false;
    }
}

/**
 * rAF 驱动的入场动画（无外部动画库）；减少动效时直接跳到终态。
 * @param {number} duration 毫秒
 * @param {(progress:number)=>void} onFrame progress 为 0~1 缓动值
 * @returns {() => void} 取消函数
 */
function animate(duration, onFrame) {
    if (prefersReducedMotion() || !(duration > 0) || typeof requestAnimationFrame !== 'function') {
        onFrame(1);
        return () => {};
    }
    const start = performance && performance.now ? performance.now() : Date.now();
    let raf = 0;
    let timer = 0;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        onFrame(1);
    };
    const tick = (now) => {
        if (done) return;
        const t = clamp((now - start) / duration, 0, 1);
        onFrame(1 - Math.pow(1 - t, 3)); // easeOutCubic
        if (t < 1) raf = requestAnimationFrame(tick);
        else done = true;
    };
    raf = requestAnimationFrame(tick);
    // 兜底：rAF 可能被节流或暂停（后台标签页、无头环境、省电模式）。
    // 若不补这一刀，靠动画淡入的元素会永久停在 opacity:0，直接不可见。
    timer = setTimeout(finish, duration + 150);
    return () => {
        done = true;
        if (raf) cancelAnimationFrame(raf);
        if (timer) clearTimeout(timer);
    };
}

/** 读取主题色（CSS 变量），读不到时给安全回退值 */
function readTheme(container) {
    let styles = null;
    try {
        styles = getComputedStyle(container);
    } catch (err) {
        styles = null;
    }
    const pick = (name, fallback) => {
        if (!styles || typeof styles.getPropertyValue !== 'function') return fallback;
        const value = styles.getPropertyValue(name);
        return value && value.trim() ? value.trim() : fallback;
    };
    return {
        text: pick('--text', 'currentColor'),      // currentColor 让文字跟随前景色，浅色主题同样成立
        muted: pick('--muted', 'currentColor'),
        grid: pick('--grid', 'rgba(148, 163, 184, 0.28)'),
        brand: pick('--brand', PALETTE[0]),
        border: pick('--border', 'rgba(148, 163, 184, 0.32)'),
        card: pick('--card', 'rgba(24, 28, 38, 0.96)')
    };
}

/** 容器若非定位元素则补 position:relative，供提示气泡绝对定位 */
function ensureRelative(container) {
    try {
        const styles = getComputedStyle(container);
        if (!styles || styles.position === 'static') container.style.position = 'relative';
    } catch (err) {
        container.style.position = 'relative';
    }
}

/** 估算字符串像素宽度（不触发排版）：CJK 按 1em，其余约 0.56em */
function estimateTextWidth(text, fontSize) {
    let width = 0;
    for (const ch of String(text)) {
        width += (ch.codePointAt(0) || 0) > 0x2e80 ? fontSize : fontSize * 0.56;
    }
    return width;
}

/** 按像素宽度截断文本，超出用省略号（完整文本由调用方放进 <title>） */
function truncateToWidth(input, maxWidth, fontSize) {
    const text = input === null || input === undefined ? '' : String(input);
    if (!text || !(maxWidth > 0)) return '';
    if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
    const ellipsisWidth = estimateTextWidth('…', fontSize);
    let out = '';
    let width = 0;
    for (const ch of text) {
        const chWidth = estimateTextWidth(ch, fontSize);
        if (width + chWidth + ellipsisWidth > maxWidth) break;
        out += ch;
        width += chWidth;
    }
    return out ? `${out}…` : '…';
}

/** 追加 SVG 文本（textContent 写入；text 与 title 不同时自动带 <title>） */
function appendText(parent, spec) {
    const {
        x = 0, y = 0, text = '', size = 11, fill = 'currentColor',
        anchor = 'start', baseline = 'middle', weight = 400, opacity = null, title = null
    } = spec;
    const node = svgNode('text', {
        x: round2(x), y: round2(y), 'font-size': size, fill, 'text-anchor': anchor,
        'dominant-baseline': baseline === 'auto' ? null : baseline,
        'font-weight': weight === 400 ? null : weight, opacity
    });
    node.textContent = String(text);
    const full = title === null || title === undefined ? String(text) : String(title);
    if (full && full !== String(text)) {
        const tip = svgNode('title');
        tip.textContent = full;
        node.appendChild(tip);
    }
    parent.appendChild(node);
    return node;
}

// ---------------------------- 金额 / 数字格式 ----------------------------

/**
 * 格式化金额。`cents` 为整数「分」（内部除以 100）。
 * @param {number} cents 分值
 * @param {{symbol?:string, showSymbol?:boolean, decimals?:number, signed?:boolean}} [opts]
 *        decimals 省略时：整数金额不显示小数，其余保留 2 位；signed 为 true 时正数带 +
 * @returns {string} 例如 `¥1,234.50` / `¥1,234` / `-¥12.30`
 */
export function formatMoney(cents, opts) {
    const options = opts || {};
    const symbol = options.symbol === undefined ? '¥' : String(options.symbol);
    const showSymbol = options.showSymbol !== false;
    const n = toFinite(cents, NaN);
    if (!Number.isFinite(n)) return '—';
    const negative = n < 0;
    const yuan = Math.abs(Math.round(n)) / 100;
    const decimals = Number.isInteger(options.decimals) && options.decimals >= 0
        ? Math.min(6, options.decimals)
        : (Number.isInteger(yuan) ? 0 : 2);
    const parts = yuan.toFixed(decimals).split('.');
    const intText = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sign = negative ? '-' : (options.signed === true && n > 0 ? '+' : '');
    return `${sign}${showSymbol ? symbol : ''}${intText}${parts[1] ? `.${parts[1]}` : ''}`;
}

/**
 * 紧凑金额，用于坐标轴 / 日历格子等窄空间。
 * @param {number} cents 分值
 * @param {{symbol?:string, showSymbol?:boolean}} [opts]
 * @returns {string} 例如 `¥1.2k` / `¥1.2万` / `¥1.2亿` / `¥25`
 */
export function formatCompact(cents, opts) {
    const options = opts || {};
    const symbol = options.symbol === undefined ? '¥' : String(options.symbol);
    const showSymbol = options.showSymbol !== false;
    const n = toFinite(cents, NaN);
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const pre = `${sign}${showSymbol ? symbol : ''}`;
    const yuan = Math.abs(n) / 100;
    const trim = (value) => value.toFixed(1).replace(/\.0$/, '');
    if (yuan === 0) return `${pre}0`;
    if (yuan >= 1e8) return `${pre}${trim(yuan / 1e8)}亿`;
    if (yuan >= 1e4) return `${pre}${trim(yuan / 1e4)}万`;
    if (yuan >= 1000) return `${pre}${trim(yuan / 1000)}k`;
    if (Number.isInteger(yuan)) return `${pre}${yuan}`;
    return formatMoney(n, { symbol, showSymbol, decimals: yuan >= 10 ? 0 : 2 });
}

/** 百分比文本（图例 / 提示气泡用） */
function formatPercent(part, total) {
    if (!(total > 0) || !Number.isFinite(part)) return '0%';
    const pct = (part / total) * 100;
    return `${pct.toFixed(pct >= 10 ? 0 : 1).replace(/\.0$/, '')}%`;
}

// ---------------------------- 刻度 / 比例尺 ----------------------------

/** 取「好看」的步长（1/2/2.5/5/10 × 10^n） */
function niceStep(raw) {
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(raw)));
    const frac = raw / base;
    let mult = 10;
    if (frac <= 1) mult = 1;
    else if (frac <= 2) mult = 2;
    else if (frac <= 2.5) mult = 2.5;
    else if (frac <= 5) mult = 5;
    return mult * base;
}

/** 取步长的小数位数 */
function decimalsOf(step) {
    const text = String(step);
    const exp = /e-(\d+)/.exec(text);
    if (exp) return Number(exp[1]);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * 生成等距的漂亮刻度；min === max 也会得到非退化区间。
 * @returns {{min:number, max:number, step:number, ticks:number[]}}
 */
function niceScale(min, max, count) {
    const wanted = Number.isFinite(count) && count > 0 ? Math.floor(count) : 4;
    let lo = Number.isFinite(min) ? min : 0;
    let hi = Number.isFinite(max) ? max : 1;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (lo === hi) {
        const pad = Math.abs(lo) || 1;
        if (lo >= 0) { lo = 0; hi = pad; } else { hi = 0; lo -= pad; }
    }
    const step = niceStep((hi - lo) / wanted);
    const dp = Math.min(6, decimalsOf(step) + 1);
    const factor = Math.pow(10, dp);
    const niceMin = Math.round(Math.floor(lo / step) * step * factor) / factor;
    const niceMax = Math.round(Math.ceil(hi / step) * step * factor) / factor;
    const segments = Math.min(50, Math.max(1, Math.round((niceMax - niceMin) / step)));
    const ticks = [];
    for (let i = 0; i <= segments; i += 1) {
        ticks.push(Math.round((niceMin + i * step) * factor) / factor);
    }
    return { min: niceMin, max: niceMax, step, ticks };
}

/** 线性比例尺；domain 退化（min === max）时恒为 rangeMin，不会除零 */
function makeScale(domainMin, domainMax, rangeMin, rangeMax) {
    const span = domainMax - domainMin;
    const factor = !Number.isFinite(span) || span === 0 ? 0 : (rangeMax - rangeMin) / span;
    return (value) => rangeMin + ((Number.isFinite(value) ? value : domainMin) - domainMin) * factor;
}

/** 取数值区间 [min, max]，可强制包含 0 */
function minMaxOf(values, includeZero) {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0];
    if (includeZero) {
        if (min > 0) min = 0;
        if (max < 0) max = 0;
    }
    return [min, max];
}

/** 数据是否「全为 0 或没有任何有效值」 */
function isAllZero(values) {
    for (const value of values) {
        if (Number.isFinite(value) && value !== 0) return false;
    }
    return true;
}

// ============================================================================
// §2 提示气泡 / 交互绑定 / 挂载外壳
// ============================================================================

/**
 * @typedef {Object} TooltipContent
 * @property {string} [title]
 * @property {{label?:string, value?:string, color?:string}[]} [rows]
 */

/** 创建提示气泡（绝对定位于容器内的 div），destroy 时移除 */
function createTooltip(container) {
    const box = htmlNode('div', {
        position: 'absolute', left: '0px', top: '0px', zIndex: '20', display: 'none', opacity: '0',
        pointerEvents: 'none', maxWidth: '230px', padding: '8px 11px', borderRadius: '12px',
        fontSize: '12px', lineHeight: '1.5', whiteSpace: 'nowrap',
        color: 'var(--text, inherit)', background: 'var(--card, rgba(24, 28, 38, 0.96))',
        border: '1.5px solid var(--border, rgba(148, 163, 184, 0.32))',
        boxShadow: '0 12px 26px -16px rgba(91, 64, 56, 0.55)', transition: 'opacity 120ms ease'
    }, 'chart-tooltip');
    box.setAttribute('aria-hidden', 'true');
    container.appendChild(box);
    let rafId = 0;

    /** 只重建结构，全部文本走 textContent */
    const fill = (content) => {
        clearNode(box);
        const data = content || {};
        if (data.title !== undefined && data.title !== null && String(data.title) !== '') {
            const title = htmlNode('div', { fontWeight: '600', marginBottom: '2px' });
            title.textContent = String(data.title);
            box.appendChild(title);
        }
        for (const row of Array.isArray(data.rows) ? data.rows : []) {
            if (!row) continue;
            const line = htmlNode('div', { display: 'flex', alignItems: 'center', gap: '6px' });
            if (row.color) {
                line.appendChild(htmlNode('span', {
                    width: '8px', height: '8px', flex: '0 0 auto', borderRadius: '50%',
                    background: String(row.color)
                }));
            }
            if (row.label !== undefined && row.label !== null && String(row.label) !== '') {
                const label = htmlNode('span', { color: 'var(--muted, inherit)' });
                label.textContent = String(row.label);
                line.appendChild(label);
            }
            if (row.value !== undefined && row.value !== null && String(row.value) !== '') {
                const value = htmlNode('span', { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' });
                value.textContent = String(row.value);
                line.appendChild(value);
            }
            box.appendChild(line);
        }
    };

    return {
        show(point, content) {
            fill(content);
            box.style.display = 'block';
            const boxWidth = box.offsetWidth || 0;
            const boxHeight = box.offsetHeight || 0;
            const hostWidth = container.clientWidth || 0;
            const hostHeight = container.clientHeight || 0;
            const px = toFinite(point && point.x, 0);
            const py = toFinite(point && point.y, 0);
            let left = px + 12;
            let top = py - boxHeight - 10;
            if (hostWidth && left + boxWidth > hostWidth - 4) left = px - boxWidth - 12;
            if (top < 4) top = py + 16;
            left = clamp(left, 4, Math.max(4, hostWidth - boxWidth - 4));
            if (hostHeight) top = clamp(top, 4, Math.max(4, hostHeight - boxHeight - 4));
            box.style.left = `${Math.round(left)}px`;
            box.style.top = `${Math.round(top)}px`;
            if (rafId) cancelAnimationFrame(rafId);
            if (prefersReducedMotion()) {
                box.style.opacity = '1';
            } else {
                box.style.opacity = '0';
                rafId = requestAnimationFrame(() => { box.style.opacity = '1'; rafId = 0; });
            }
        },
        hide() {
            box.style.display = 'none';
            box.style.opacity = '0';
        },
        destroy() {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = 0;
            if (box.parentNode) box.parentNode.removeChild(box);
        }
    };
}

/** 事件坐标 → 容器内相对坐标 */
function eventPoint(container, event) {
    const rect = container.getBoundingClientRect();
    return {
        x: event && Number.isFinite(event.clientX) ? event.clientX - rect.left : rect.width / 2,
        y: event && Number.isFinite(event.clientY) ? event.clientY - rect.top : rect.height / 2
    };
}

/** 元素几何中心 → 容器内相对坐标（键盘聚焦时用） */
function nodeCenterPoint(container, node) {
    const host = container.getBoundingClientRect();
    let rect = null;
    try {
        rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
    } catch (err) {
        rect = null;
    }
    if (!rect || (!rect.width && !rect.height)) return { x: host.width / 2, y: host.height / 2 };
    return { x: rect.left - host.left + rect.width / 2, y: rect.top - host.top + rect.height / 2 };
}

/**
 * 给图形元素绑定「悬停 / 点按 / 聚焦 → 气泡」与「点击 / 回车 / 空格 → 选中」。
 * @param {object} ctx 图表上下文
 * @param {SVGElement} node 交互元素（<g> 或 <rect>/<path>）
 * @param {{content:()=>TooltipContent, onActivate?:()=>void, ariaLabel?:string, title?:string}} config
 */
function bindInteractive(ctx, node, config) {
    const { container, tooltip } = ctx;
    node.setAttribute('data-hit', '1');
    node.setAttribute('tabindex', '0');
    if (config.onActivate) node.setAttribute('role', 'button');
    if (config.ariaLabel) node.setAttribute('aria-label', config.ariaLabel);
    node.style.cursor = config.onActivate ? 'pointer' : 'default';
    if (config.title) {
        const tip = svgNode('title');
        tip.textContent = String(config.title);
        node.insertBefore(tip, node.firstChild);
    }

    const show = (event) => tooltip.show(eventPoint(container, event), config.content());
    const showCentered = () => tooltip.show(nodeCenterPoint(container, node), config.content());
    node.addEventListener('pointerenter', (e) => { if (!e.pointerType || e.pointerType === 'mouse') show(e); });
    node.addEventListener('pointermove', (e) => { if (!e.pointerType || e.pointerType === 'mouse') show(e); });
    node.addEventListener('pointerleave', (e) => { if (!e.pointerType || e.pointerType === 'mouse') tooltip.hide(); });
    node.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') show(e); }); // 触屏没有 hover
    node.addEventListener('focus', showCentered);
    node.addEventListener('blur', () => tooltip.hide());
    node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        if (config.onActivate) {
            tooltip.hide();
            config.onActivate();
        } else {
            showCentered();
        }
    });
    if (config.onActivate) {
        node.addEventListener('click', (event) => {
            event.stopPropagation();
            config.onActivate();
        });
    }
}

/**
 * 图表挂载外壳：清空容器 → 建 svg / tooltip → 监听宽度变化重绘 → 返回 destroy。
 * @param {HTMLElement} container
 * @param {object} opts 用户配置（会读取 opts.height / opts.ariaLabel）
 * @param {(ctx:object)=>void} draw 绘制回调（尺寸变化时重放）
 * @param {number} fallbackHeight 该图表的默认高度
 * @returns {{destroy:()=>void}}
 */
function mountChart(container, opts, draw, fallbackHeight) {
    if (!container || typeof container.appendChild !== 'function') return { destroy() {} };
    const previous = container[MOUNT_KEY];
    if (typeof previous === 'function') {
        try {
            previous(); // 同一容器重复渲染：先销毁上一个实例
        } catch (err) {
            /* 上一次清理失败不应阻塞本次渲染 */
        }
    }
    clearNode(container);
    ensureRelative(container);

    const height = Math.round(clamp(toFinite(opts && opts.height, fallbackHeight), 60, 2000));
    const svgRoot = svgNode('svg', {
        viewBox: `0 0 320 ${height}`, preserveAspectRatio: 'xMidYMid meet', width: '100%',
        height: String(height), role: 'img',
        'aria-label': opts && typeof opts.ariaLabel === 'string' ? opts.ariaLabel : '图表',
        style: 'display:block;font-family:inherit;overflow:visible'
    });
    container.appendChild(svgRoot);
    const tooltip = createTooltip(container);
    const cancels = [];
    const ctx = {
        container, svg: svgRoot, tooltip, opts: opts || {}, width: 320, height,
        theme: readTheme(container),
        /** 注册入场动画（重绘 / destroy 时统一取消） */
        animate(duration, onFrame) {
            cancels.push(animate(duration, onFrame));
        }
    };

    const measure = () => {
        let width = container.clientWidth || 0;
        if (!width && typeof container.getBoundingClientRect === 'function') {
            width = container.getBoundingClientRect().width || 0;
        }
        return Math.max(160, Math.round(width || 320));
    };
    const cancelAll = () => {
        while (cancels.length) {
            try {
                cancels.pop()();
            } catch (err) {
                /* 忽略取消异常 */
            }
        }
    };

    let lastWidth = -1;
    const renderNow = () => {
        const width = measure();
        if (width === lastWidth) return;
        lastWidth = width;
        ctx.width = width;
        ctx.theme = readTheme(container);
        svgRoot.setAttribute('viewBox', `0 0 ${width} ${height}`);
        cancelAll();
        clearNode(svgRoot);
        tooltip.hide();
        try {
            draw(ctx);
        } catch (err) {
            console.error('[charts] 渲染失败', err);
        }
    };

    let rafId = 0;
    const schedule = () => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => { rafId = 0; renderNow(); });
    };

    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule);
        observer.observe(container);
    } else if (typeof window !== 'undefined') {
        window.addEventListener('resize', schedule); // 老浏览器兜底
    }
    const onDocumentPointerDown = (event) => {
        if (!container.contains || !container.contains(event.target)) tooltip.hide();
    };
    document.addEventListener('pointerdown', onDocumentPointerDown, true);

    renderNow();

    const destroy = () => {
        cancelAll();
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        if (observer) {
            observer.disconnect();
            observer = null;
        } else if (typeof window !== 'undefined') {
            window.removeEventListener('resize', schedule);
        }
        document.removeEventListener('pointerdown', onDocumentPointerDown, true);
        tooltip.destroy();
        clearNode(container);
        if (container[MOUNT_KEY] === destroy) container[MOUNT_KEY] = null;
    };
    container[MOUNT_KEY] = destroy;
    return { destroy };
}

/** 统一的空数据渲染：居中显示 muted 文案 */
function mountEmpty(container, opts, message) {
    const render = (ctx) => {
        appendText(ctx.svg, {
            x: ctx.width / 2, y: ctx.height / 2, text: message || EMPTY_TEXT,
            size: 13, fill: ctx.theme.muted, anchor: 'middle'
        });
    };
    return mountChart(container, { ...(opts || {}), ariaLabel: message || EMPTY_TEXT }, render, DEFAULT_HEIGHT);
}

// ============================================================================
// §3 柱状图（默认垂直，opts.horizontal 切换为水平条）
// ============================================================================

/**
 * 渲染柱状图。
 * @param {HTMLElement} container 容器
 * @param {Object} opts
 * @param {{label:string, value:number, color?:string}[]} opts.data 数据（value 默认按「分」）
 * @param {(cents:number)=>string} [opts.valueFormat] 数值格式化，默认 formatCompact
 * @param {boolean} [opts.horizontal] 水平条
 * @param {number} [opts.maxBars] 只显示绝对值最大的前 N 项（按降序展示）
 * @param {number} [opts.highlightIndex] 高亮某项（按原始下标匹配，其余淡化）
 * @param {(item:object, index:number)=>void} [opts.onSelect] 点击 / 回车选中
 * @param {number} [opts.height] 自定义高度
 * @param {string} [opts.ariaLabel] 自定义无障碍描述
 * @returns {{destroy:()=>void}}
 */
export function renderBarChart(container, opts) {
    const options = opts || {};
    const horizontal = options.horizontal === true;
    const format = typeof options.valueFormat === 'function' ? options.valueFormat : formatCompact;
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    const maxBars = Number.isFinite(options.maxBars) && options.maxBars > 0 ? Math.floor(options.maxBars) : 0;
    const raw = Array.isArray(options.data) ? options.data : [];

    let entries = raw.map((item, index) => ({
        item, index,
        label: item && item.label !== undefined && item.label !== null ? String(item.label) : '',
        value: toFinite(item && item.value, 0),
        color: item && item.color ? String(item.color) : PALETTE[index % PALETTE.length]
    }));
    const highlight = Number.isInteger(options.highlightIndex)
        ? entries.find((entry) => entry.index === options.highlightIndex) || null
        : null;
    if (maxBars && entries.length > maxBars) {
        entries = entries.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, maxBars);
    }
    if (!entries.length || isAllZero(entries.map((entry) => entry.value))) {
        return mountEmpty(container, options);
    }

    const values = entries.map((entry) => entry.value);
    const totalPositive = values.reduce((sum, value) => (value > 0 ? sum + value : sum), 0);
    const [domainMin, domainMax] = minMaxOf(values, true);
    const maxAbs = values.reduce((acc, value) => Math.max(acc, Math.abs(value)), 0);
    const ariaLabel = options.ariaLabel || `柱状图，共 ${entries.length} 项，最大 ${format(maxAbs)}`;
    const height = horizontal ? Math.max(140, entries.length * 30 + 40) : DEFAULT_HEIGHT;

    return mountChart(container, { ...options, ariaLabel }, (ctx) => {
        const scale = niceScale(domainMin, domainMax, 4);
        const tickTexts = scale.ticks.map((tick) => format(tick));
        const tickFont = 10;
        const longestTick = tickTexts.reduce((acc, text) => Math.max(acc, estimateTextWidth(text, tickFont)), 0);
        const shared = { entries, scale, tickTexts, tickFont, highlight, totalPositive, format, onSelect };
        if (horizontal) drawHorizontalBars(ctx, shared);
        else drawVerticalBars(ctx, { ...shared, longestTick });
    }, height);
}

/** 垂直柱绘制 */
function drawVerticalBars(ctx, config) {
    const { entries, scale, tickTexts, longestTick, tickFont, highlight, totalPositive, format, onSelect } = config;
    const { svg, width, height, theme } = ctx;
    const padTop = 12;
    const padRight = 8;
    const padBottom = 28;
    const padLeft = clamp(longestTick + 10, 32, Math.max(32, width * 0.34));
    const plotWidth = Math.max(16, width - padLeft - padRight);
    const plotHeight = Math.max(16, height - padTop - padBottom);
    const yOf = makeScale(scale.min, scale.max, padTop + plotHeight, padTop);
    const zeroY = yOf(0);
    const band = plotWidth / entries.length;
    const barWidth = Math.max(4, Math.min(40, band * 0.62));
    const gridGroup = svgNode('g');
    const barGroup = svgNode('g');
    const axisGroup = svgNode('g');
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(axisGroup);

    scale.ticks.forEach((tick, i) => {
        const y = yOf(tick);
        gridGroup.appendChild(svgNode('line', {
            x1: round2(padLeft), x2: round2(padLeft + plotWidth), y1: round2(y), y2: round2(y),
            stroke: theme.grid, 'stroke-width': 1, 'stroke-dasharray': tick === 0 ? null : '3 3'
        }));
        appendText(gridGroup, { x: padLeft - 6, y, text: tickTexts[i], size: tickFont, fill: theme.muted, anchor: 'end' });
    });
    // 0 轴
    axisGroup.appendChild(svgNode('line', {
        x1: round2(padLeft), x2: round2(padLeft + plotWidth), y1: round2(zeroY), y2: round2(zeroY),
        stroke: theme.border, 'stroke-width': 1
    }));

    const animatable = [];
    entries.forEach((entry, i) => {
        const centerX = padLeft + band * i + band / 2;
        const finalHeight = Math.max(1, Math.abs(yOf(entry.value) - zeroY));
        const positive = entry.value >= 0;
        const finalY = positive ? zeroY - finalHeight : zeroY;
        const dimmed = highlight && highlight !== entry;
        const rect = svgNode('rect', {
            x: round2(centerX - barWidth / 2), y: round2(finalY), width: round2(barWidth),
            height: round2(finalHeight), rx: 3, fill: entry.color, opacity: dimmed ? 0.35 : 1,
            stroke: highlight === entry ? theme.text : null, 'stroke-width': highlight === entry ? 1 : null
        });
        const group = svgNode('g');
        group.appendChild(rect);
        barGroup.appendChild(group);
        bindInteractive(ctx, group, {
            ariaLabel: `${entry.label} ${format(entry.value)}`,
            title: `${entry.label}：${format(entry.value)}`,
            content: () => ({
                title: entry.label,
                rows: [
                    { value: format(entry.value), color: entry.color },
                    entry.value > 0 && totalPositive > 0
                        ? { label: '占比', value: formatPercent(entry.value, totalPositive) } : null
                ].filter(Boolean)
            }),
            onActivate: onSelect ? () => onSelect(entry.item, entry.index) : null
        });
        appendText(axisGroup, {
            x: centerX, y: height - 10, text: truncateToWidth(entry.label, band - 4, 10),
            title: entry.label, size: 10, fill: theme.muted, anchor: 'middle'
        });
        animatable.push({ rect, finalY, finalHeight, positive });
    });

    animatable.forEach((item) => {
        item.rect.setAttribute('y', String(round2(item.positive ? item.finalY + item.finalHeight : item.finalY)));
        item.rect.setAttribute('height', '0');
    });
    ctx.animate(480, (t) => {
        for (const item of animatable) {
            item.rect.setAttribute('height', String(round2(item.finalHeight * t)));
            item.rect.setAttribute('y', String(round2(item.positive ? item.finalY + item.finalHeight * (1 - t) : item.finalY)));
        }
    });
}

/** 水平条绘制 */
function drawHorizontalBars(ctx, config) {
    const { entries, scale, tickTexts, tickFont, highlight, totalPositive, format, onSelect } = config;
    const { svg, width, height, theme } = ctx;
    const padTop = 8;
    const padBottom = 24;
    const labelFont = 10.5;
    const valueFont = 10;
    const longestValue = entries.reduce((acc, e) => Math.max(acc, estimateTextWidth(format(e.value), valueFont)), 0);
    const longestLabel = entries.reduce((acc, e) => Math.max(acc, estimateTextWidth(e.label, labelFont)), 0);
    const labelWidth = clamp(longestLabel + 8, 44, Math.max(44, width * 0.4));
    const barLeft = labelWidth + 8;
    const plotWidth = Math.max(24, width - 8 - longestValue - 8 - barLeft);
    const plotHeight = Math.max(16, height - padTop - padBottom);
    const xOf = makeScale(scale.min, scale.max, barLeft, barLeft + plotWidth);
    const zeroX = xOf(0);
    const rowHeight = plotHeight / entries.length;
    const barHeight = Math.max(4, Math.min(20, rowHeight * 0.62));
    const gridGroup = svgNode('g');
    const barGroup = svgNode('g');
    const axisGroup = svgNode('g');
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(axisGroup);

    scale.ticks.forEach((tick, i) => {
        const x = xOf(tick);
        gridGroup.appendChild(svgNode('line', {
            x1: round2(x), x2: round2(x), y1: round2(padTop), y2: round2(padTop + plotHeight),
            stroke: theme.grid, 'stroke-width': 1, 'stroke-dasharray': tick === 0 ? null : '3 3'
        }));
        appendText(gridGroup, { x, y: height - 10, text: tickTexts[i], size: tickFont, fill: theme.muted, anchor: 'middle' });
    });
    if (scale.min < 0 && scale.max > 0) {
        axisGroup.appendChild(svgNode('line', {
            x1: round2(zeroX), x2: round2(zeroX), y1: round2(padTop), y2: round2(padTop + plotHeight),
            stroke: theme.border, 'stroke-width': 1
        }));
    }

    const animatable = [];
    entries.forEach((entry, i) => {
        const valueX = xOf(entry.value);
        const finalWidth = Math.max(1, Math.abs(valueX - zeroX));
        const finalX = Math.min(valueX, zeroX);
        const top = padTop + rowHeight * i + (rowHeight - barHeight) / 2;
        const dimmed = highlight && highlight !== entry;
        const rect = svgNode('rect', {
            x: round2(finalX), y: round2(top), width: round2(finalWidth), height: round2(barHeight),
            rx: 3, fill: entry.color, opacity: dimmed ? 0.35 : 1,
            stroke: highlight === entry ? theme.text : null, 'stroke-width': highlight === entry ? 1 : null
        });
        const group = svgNode('g');
        group.appendChild(rect);
        barGroup.appendChild(group);
        bindInteractive(ctx, group, {
            ariaLabel: `${entry.label} ${format(entry.value)}`,
            title: `${entry.label}：${format(entry.value)}`,
            content: () => ({
                title: entry.label,
                rows: [
                    { value: format(entry.value), color: entry.color },
                    entry.value > 0 && totalPositive > 0
                        ? { label: '占比', value: formatPercent(entry.value, totalPositive) } : null
                ].filter(Boolean)
            }),
            onActivate: onSelect ? () => onSelect(entry.item, entry.index) : null
        });
        appendText(axisGroup, {
            x: barLeft - 6, y: top + barHeight / 2, text: truncateToWidth(entry.label, labelWidth - 6, labelFont),
            title: entry.label, size: labelFont, fill: theme.muted, anchor: 'end'
        });
        appendText(axisGroup, {
            x: entry.value >= 0 ? finalX + finalWidth + 4 : zeroX + 4, y: top + barHeight / 2,
            text: format(entry.value), size: valueFont, fill: theme.muted, anchor: 'start'
        });
        animatable.push({ rect, finalX, finalWidth });
    });

    animatable.forEach((item) => {
        item.rect.setAttribute('x', String(round2(zeroX)));
        item.rect.setAttribute('width', '0');
    });
    ctx.animate(480, (t) => {
        for (const item of animatable) {
            item.rect.setAttribute('width', String(round2(item.finalWidth * t)));
            item.rect.setAttribute('x', String(round2(zeroX + (item.finalX - zeroX) * t)));
        }
    });
}

// ============================================================================
// §4 饼图 / 环形图
// ============================================================================

/** 极坐标：角度 0 = 12 点方向，顺时针为正 */
function polarPoint(cx, cy, radius, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

/**
 * 圆环扇区路径；rInner < 0.5 退化为扇形，整圆用两段半圆拼接（避免弧线首尾重合）。
 * @returns {string} path 的 d 属性，空串表示无需绘制
 */
function ringSegmentPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
    const sweep = clamp(endAngle - startAngle, 0, 360);
    if (!(sweep > 0.01) || !(rOuter > 0)) return '';
    const donut = rInner > 0.5;
    const largeArc = sweep > 180 ? 1 : 0;

    if (sweep >= 359.99) {
        const [ox, oy] = polarPoint(cx, cy, rOuter, startAngle);
        if (!donut) {
            return `M ${round2(cx - rOuter)} ${round2(cy)} ` +
                `A ${round2(rOuter)} ${round2(rOuter)} 0 1 0 ${round2(cx + rOuter)} ${round2(cy)} ` +
                `A ${round2(rOuter)} ${round2(rOuter)} 0 1 0 ${round2(cx - rOuter)} ${round2(cy)} Z`;
        }
        const [ix, iy] = polarPoint(cx, cy, rInner, startAngle);
        return `M ${round2(ox)} ${round2(oy)} ` +
            `A ${round2(rOuter)} ${round2(rOuter)} 0 1 1 ${round2(2 * cx - ox)} ${round2(2 * cy - oy)} ` +
            `A ${round2(rOuter)} ${round2(rOuter)} 0 1 1 ${round2(ox)} ${round2(oy)} ` +
            `L ${round2(ix)} ${round2(iy)} ` +
            `A ${round2(rInner)} ${round2(rInner)} 0 1 0 ${round2(2 * cx - ix)} ${round2(2 * cy - iy)} ` +
            `A ${round2(rInner)} ${round2(rInner)} 0 1 0 ${round2(ix)} ${round2(iy)} Z`;
    }

    const [ox0, oy0] = polarPoint(cx, cy, rOuter, startAngle);
    const [ox1, oy1] = polarPoint(cx, cy, rOuter, endAngle);
    if (!donut) {
        return `M ${round2(cx)} ${round2(cy)} L ${round2(ox0)} ${round2(oy0)} ` +
            `A ${round2(rOuter)} ${round2(rOuter)} 0 ${largeArc} 1 ${round2(ox1)} ${round2(oy1)} Z`;
    }
    const [ix1, iy1] = polarPoint(cx, cy, rInner, endAngle);
    const [ix0, iy0] = polarPoint(cx, cy, rInner, startAngle);
    return `M ${round2(ox0)} ${round2(oy0)} ` +
        `A ${round2(rOuter)} ${round2(rOuter)} 0 ${largeArc} 1 ${round2(ox1)} ${round2(oy1)} ` +
        `L ${round2(ix1)} ${round2(iy1)} ` +
        `A ${round2(rInner)} ${round2(rInner)} 0 ${largeArc} 0 ${round2(ix0)} ${round2(iy0)} Z`;
}

/**
 * 渲染饼图 / 环形图（默认环形），右侧为「数值 + 百分比」图例。
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {{label:string, value:number, color?:string}[]} opts.data 负数按 0 处理（饼图无法表达负值）
 * @param {boolean} [opts.donut] 默认 true
 * @param {string} [opts.centerLabel] 圆心小标题
 * @param {string|number} [opts.centerValue] 圆心大字；传数字时按「分」格式化
 * @param {(cents:number)=>string} [opts.valueFormat] 图例格式化，默认 formatMoney
 * @param {(item:object, index:number)=>void} [opts.onSelect] 点击扇区 / 图例选中
 * @param {number} [opts.height]
 * @returns {{destroy:()=>void}}
 */
export function renderPieChart(container, opts) {
    const options = opts || {};
    const donut = options.donut !== false;
    const format = typeof options.valueFormat === 'function' ? options.valueFormat : formatMoney;
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    const raw = Array.isArray(options.data) ? options.data : [];

    const entries = raw.map((item, index) => ({
        item, index,
        label: item && item.label !== undefined && item.label !== null ? String(item.label) : '',
        value: Math.max(0, toFinite(item && item.value, 0)),
        color: item && item.color ? String(item.color) : PALETTE[index % PALETTE.length]
    })).filter((entry) => entry.value > 0);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    if (!entries.length || !(total > 0)) return mountEmpty(container, options);

    const ariaLabel = options.ariaLabel || `饼图，共 ${entries.length} 项，合计 ${format(total)}`;
    const height = Math.round(clamp(toFinite(options.height, DEFAULT_HEIGHT), 140, 2000));

    return mountChart(container, { ...options, ariaLabel }, (ctx) => {
        const { svg, width, theme } = ctx;
        const h = ctx.height;
        const pieBox = clamp(width * 0.42, 96, Math.max(96, h));
        const radius = Math.max(16, Math.min(pieBox / 2 - 4, (h - 24) / 2));
        const innerRadius = donut ? Math.max(0, radius * 0.58) : 0;
        const cx = 4 + pieBox / 2;
        const cy = h / 2;
        const group = svgNode('g');
        svg.appendChild(group);

        let angle = 0;
        for (const entry of entries) {
            const sweep = (entry.value / total) * 360;
            const percent = formatPercent(entry.value, total);
            const path = svgNode('path', {
                d: ringSegmentPath(cx, cy, radius, innerRadius, angle, angle + sweep),
                fill: entry.color, stroke: theme.card, 'stroke-width': 1, 'stroke-linejoin': 'round'
            });
            group.appendChild(path);
            bindInteractive(ctx, path, {
                ariaLabel: `${entry.label} ${format(entry.value)} ${percent}`,
                title: `${entry.label}：${format(entry.value)}（${percent}）`,
                content: () => ({
                    title: entry.label,
                    rows: [{ value: format(entry.value), color: entry.color }, { label: '占比', value: percent }]
                }),
                onActivate: onSelect ? () => onSelect(entry.item, entry.index) : null
            });
            angle += sweep;
        }

        if (donut) {
            const hasValue = options.centerValue !== undefined && options.centerValue !== null;
            const valueText = hasValue
                ? (typeof options.centerValue === 'number' ? formatMoney(options.centerValue) : String(options.centerValue))
                : '';
            const labelText = options.centerLabel ? String(options.centerLabel) : '';
            const innerWidth = innerRadius * 2 - 6;
            if (labelText) {
                appendText(group, {
                    x: cx, y: hasValue ? cy - 8 : cy, size: 10.5, text: truncateToWidth(labelText, innerWidth, 10.5),
                    title: labelText, fill: theme.muted, anchor: 'middle'
                });
            }
            if (valueText) {
                appendText(group, {
                    x: cx, y: labelText ? cy + 9 : cy, size: 16, weight: 600,
                    text: truncateToWidth(valueText, innerWidth, 16), title: valueText,
                    fill: theme.text, anchor: 'middle'
                });
            }
        }

        // 图例：超出可视行数时把尾部合并成「其他 N 项」
        const legendX = pieBox + 10;
        const legendWidth = Math.max(40, width - legendX - 6);
        const rowHeight = clamp((h - 18) / Math.max(1, Math.min(entries.length, 8)), 14, 22);
        const maxRows = Math.max(1, Math.floor((h - 14) / rowHeight));
        let visible = entries;
        let overflow = null;
        if (entries.length > maxRows) {
            visible = entries.slice(0, Math.max(1, maxRows - 1));
            const rest = entries.slice(visible.length);
            overflow = { count: rest.length, value: rest.reduce((sum, entry) => sum + entry.value, 0) };
        }
        const legendTop = Math.max(6, (h - rowHeight * (visible.length + (overflow ? 1 : 0))) / 2);
        const dotRadius = 3.5;

        const drawRow = (rowY, label, valueText, color, entry) => {
            const row = svgNode('g');
            row.appendChild(svgNode('circle', { cx: round2(legendX + dotRadius), cy: round2(rowY), r: dotRadius, fill: color }));
            appendText(row, {
                x: legendX + dotRadius * 2 + 6, y: rowY, size: 11,
                text: truncateToWidth(label, Math.max(16, legendWidth - estimateTextWidth(valueText, 11) - 16), 11),
                title: label, fill: theme.text, anchor: 'start'
            });
            appendText(row, { x: width - 6, y: rowY, text: valueText, size: 11, fill: theme.muted, anchor: 'end' });
            svg.appendChild(row);
            if (!entry) return;
            const percent = formatPercent(entry.value, total);
            bindInteractive(ctx, row, {
                ariaLabel: `${label} ${valueText} ${percent}`,
                title: `${label}：${valueText}`,
                content: () => ({
                    title: label,
                    rows: [{ value: valueText, color }, { label: '占比', value: percent }]
                }),
                onActivate: onSelect ? () => onSelect(entry.item, entry.index) : null
            });
        };

        visible.forEach((entry, i) => {
            drawRow(
                legendTop + rowHeight * i + rowHeight / 2, entry.label,
                `${format(entry.value)} · ${formatPercent(entry.value, total)}`, entry.color, entry
            );
        });
        if (overflow) {
            drawRow(
                legendTop + rowHeight * visible.length + rowHeight / 2, `其他 ${overflow.count} 项`,
                `${format(overflow.value)} · ${formatPercent(overflow.value, total)}`, theme.grid, null
            );
        }

        // 入场动画从「半可见」开始而不是 0：即使 rAF 被节流、动画被取消、
        // 或容器在动画过程中被重绘，饼图也绝不会整块消失（只有 0.35 的透明度差异）。
        const PIE_MIN_OPACITY = 0.5;
        group.setAttribute('opacity', String(PIE_MIN_OPACITY));
        ctx.animate(420, (t) => {
            const eased = clamp(t * 1.2, 0, 1);
            const scale = 0.9 + 0.1 * eased;
            group.setAttribute('opacity', String(PIE_MIN_OPACITY + (1 - PIE_MIN_OPACITY) * eased));
            group.setAttribute('transform',
                `translate(${round2(cx * (1 - scale))} ${round2(cy * (1 - scale))}) scale(${round2(scale)})`);
        });
    }, height);
}

// ============================================================================
// §5 折线图（1~3 条系列）
// ============================================================================

/** 平滑折线：二次贝塞尔经过相邻点中点，曲线不会超出数据范围 */
function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${round2(points[0].x)} ${round2(points[0].y)}`;
    const parts = [`M ${round2(points[0].x)} ${round2(points[0].y)}`];
    for (let i = 1; i < points.length - 1; i += 1) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        parts.push(`Q ${round2(points[i].x)} ${round2(points[i].y)} ${round2(midX)} ${round2(midY)}`);
    }
    const last = points[points.length - 1];
    parts.push(`L ${round2(last.x)} ${round2(last.y)}`);
    return parts.join(' ');
}

/** 折线 y 值域：全等值时上下留白，避免除零并把线压在边缘 */
function lineDomain(values) {
    const [min, max] = minMaxOf(values, false);
    if (min === max) {
        const pad = Math.abs(max) * 0.5 || 1;
        return [min - pad, max + pad];
    }
    if (min >= 0) return [0, max];
    if (max <= 0) return [min, 0];
    return [min, max];
}

/**
 * 渲染折线图（1~3 条系列；单点与全等值都安全）。
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {{name?:string, color?:string, points:{x:string|number, y:number}[]}[]} opts.series
 * @param {(cents:number)=>string} [opts.valueFormat] 默认 formatCompact
 * @param {boolean} [opts.area] 面积填充
 * @param {boolean} [opts.showDots] 是否画数据点（默认 true；透明命中区始终存在）
 * @param {(info:object, pointIndex:number)=>void} [opts.onSelect]
 *        info = { point, series, seriesIndex, pointIndex, x, y }
 * @param {number} [opts.height]
 * @returns {{destroy:()=>void}}
 */
export function renderLineChart(container, opts) {
    const options = opts || {};
    const format = typeof options.valueFormat === 'function' ? options.valueFormat : formatCompact;
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    const area = options.area === true;
    const rawSeries = Array.isArray(options.series) ? options.series.slice(0, 3) : [];

    const series = rawSeries.map((item, seriesIndex) => {
        const source = item || {};
        return {
            name: source.name !== undefined && source.name !== null ? String(source.name) : `系列 ${seriesIndex + 1}`,
            color: source.color ? String(source.color) : PALETTE[seriesIndex % PALETTE.length],
            seriesIndex,
            points: (Array.isArray(source.points) ? source.points : []).map((point, pointIndex) => ({
                raw: point,
                x: point && point.x !== undefined && point.x !== null ? point.x : pointIndex,
                y: toFinite(point && point.y, 0),
                pointIndex
            }))
        };
    }).filter((item) => item.points.length > 0);

    const allPoints = [];
    for (const item of series) allPoints.push(...item.points);
    if (!allPoints.length || isAllZero(allPoints.map((point) => point.y))) return mountEmpty(container, options);

    const yValues = allPoints.map((point) => point.y);
    const ariaLabel = options.ariaLabel || `折线图，${series.length} 条系列，共 ${allPoints.length} 个数据点`;
    const showDots = options.showDots !== false || series.some((item) => item.points.length === 1);
    const height = Math.round(clamp(toFinite(options.height, DEFAULT_HEIGHT), 100, 2000));

    // x 轴：全部 x 可数字化则用线性轴，否则按出现顺序作为分类轴
    const xKeys = [];
    const seen = new Set();
    for (const item of series) {
        for (const point of item.points) {
            const key = String(point.x);
            if (!seen.has(key)) { seen.add(key); xKeys.push(key); }
        }
    }
    const numericX = xKeys.length > 0 && xKeys.every((key) => key !== '' && Number.isFinite(Number(key)));

    return mountChart(container, { ...options, ariaLabel }, (ctx) => {
        const { svg, width, theme } = ctx;
        const h = ctx.height;
        const showLegend = series.length > 1;
        const padTop = showLegend ? 26 : 12;
        const padRight = 10;
        const padBottom = 26;
        const scale = niceScale(lineDomain(yValues)[0], lineDomain(yValues)[1], 4);
        const tickTexts = scale.ticks.map((tick) => format(tick));
        const tickFont = 10;
        const longestTick = tickTexts.reduce((acc, text) => Math.max(acc, estimateTextWidth(text, tickFont)), 0);
        const padLeft = clamp(longestTick + 10, 30, Math.max(30, width * 0.32));
        const plotWidth = Math.max(20, width - padLeft - padRight);
        const plotHeight = Math.max(20, h - padTop - padBottom);
        const yOf = makeScale(scale.min, scale.max, padTop + plotHeight, padTop);

        let xOf;
        let xTicks;
        if (xKeys.length === 1) {
            const center = padLeft + plotWidth / 2;
            xOf = () => center;
            xTicks = [{ x: center, label: xKeys[0] }];
        } else if (numericX) {
            const numbers = xKeys.map((key) => Number(key));
            const xScale = niceScale(Math.min(...numbers), Math.max(...numbers), 4);
            xOf = makeScale(xScale.min, xScale.max, padLeft, padLeft + plotWidth);
            const labeled = numbers.length <= 8 ? numbers : xScale.ticks;
            xTicks = labeled.map((value) => ({ x: xOf(value), label: String(value) }));
        } else {
            const step = plotWidth / Math.max(1, xKeys.length - 1);
            xOf = (key) => {
                const index = xKeys.indexOf(String(key));
                return padLeft + (index < 0 ? 0 : index * step);
            };
            const labelStep = Math.max(1, Math.ceil(xKeys.length / 6));
            xTicks = xKeys
                .map((key, index) => ({ x: xOf(key), label: key, index }))
                .filter((tick) => tick.index % labelStep === 0 || tick.index === xKeys.length - 1);
        }

        const gridGroup = svgNode('g');
        const seriesGroup = svgNode('g');
        const axisGroup = svgNode('g');
        const hitGroup = svgNode('g');
        svg.appendChild(gridGroup);
        svg.appendChild(seriesGroup);
        svg.appendChild(axisGroup);
        svg.appendChild(hitGroup);

        scale.ticks.forEach((tick, i) => {
            const y = yOf(tick);
            gridGroup.appendChild(svgNode('line', {
                x1: round2(padLeft), x2: round2(padLeft + plotWidth), y1: round2(y), y2: round2(y),
                stroke: theme.grid, 'stroke-width': 1, 'stroke-dasharray': tick === 0 ? null : '3 3'
            }));
            appendText(gridGroup, { x: padLeft - 6, y, text: tickTexts[i], size: tickFont, fill: theme.muted, anchor: 'end' });
        });
        xTicks.forEach((tick) => {
            appendText(axisGroup, {
                x: tick.x, y: h - 10, size: tickFont, fill: theme.muted, anchor: 'middle',
                text: truncateToWidth(tick.label, Math.max(28, plotWidth / Math.max(1, xTicks.length) - 2), tickFont),
                title: tick.label
            });
        });

        if (showLegend) {
            const itemWidth = plotWidth / series.length;
            series.forEach((item, index) => {
                const x = padLeft + itemWidth * index;
                const legend = svgNode('g');
                legend.appendChild(svgNode('line', {
                    x1: round2(x), x2: round2(x + 12), y1: 12, y2: 12,
                    stroke: item.color, 'stroke-width': 2, 'stroke-linecap': 'round'
                }));
                appendText(legend, {
                    x: x + 17, y: 12, size: 10.5, fill: theme.muted, anchor: 'start',
                    text: truncateToWidth(item.name, Math.max(16, itemWidth - 24), 10.5), title: item.name
                });
                svg.appendChild(legend);
            });
        }

        const hitRadius = clamp(plotWidth / Math.max(4, xKeys.length * 2), 7, 14);
        series.forEach((meta, seriesIndex) => {
            const geoPoints = meta.points.map((point) => ({
                source: point,
                x: xOf(numericX && xKeys.length > 1 ? Number(point.x) : String(point.x)),
                y: yOf(point.y)
            }));
            const linePath = smoothPath(geoPoints);
            if (!linePath) return;

            if (area && geoPoints.length > 1) {
                const gradientId = `dsh-chart-grad-${uidSeq += 1}`;
                const defs = svgNode('defs');
                const gradient = svgNode('linearGradient', {
                    id: gradientId, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0,
                    y1: round2(padTop), y2: round2(padTop + plotHeight)
                });
                gradient.appendChild(svgNode('stop', { offset: '0%', 'stop-color': meta.color, 'stop-opacity': 0.32 }));
                gradient.appendChild(svgNode('stop', { offset: '100%', 'stop-color': meta.color, 'stop-opacity': 0.02 }));
                defs.appendChild(gradient);
                seriesGroup.appendChild(defs);
                const baseY = padTop + plotHeight;
                const areaPath = svgNode('path', {
                    d: `${linePath} L ${round2(geoPoints[geoPoints.length - 1].x)} ${round2(baseY)} ` +
                        `L ${round2(geoPoints[0].x)} ${round2(baseY)} Z`,
                    fill: `url(#${gradientId})`, stroke: 'none', opacity: 0.5
                });
                seriesGroup.appendChild(areaPath);
                ctx.animate(520, (t) => areaPath.setAttribute('opacity', String(0.5 + 0.5 * t)));
            }

            const stroke = svgNode('path', {
                d: linePath, fill: 'none', stroke: meta.color, 'stroke-width': 2,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round'
            });
            seriesGroup.appendChild(stroke);
            // 入场：能量出长度就做描边动画，否则淡入（不依赖 pathLength 兼容性）
            let length = 0;
            try {
                length = typeof stroke.getTotalLength === 'function' ? stroke.getTotalLength() : 0;
            } catch (err) {
                length = 0;
            }
            if (length > 0 && geoPoints.length > 1) {
                stroke.setAttribute('stroke-dasharray', String(length));
                stroke.setAttribute('stroke-dashoffset', String(length));
                ctx.animate(560, (t) => stroke.setAttribute('stroke-dashoffset', String(length * (1 - t))));
            } else {
                stroke.setAttribute('opacity', '0.6');
                ctx.animate(360, (t) => stroke.setAttribute('opacity', String(0.6 + 0.4 * t)));
            }

            if (showDots) {
                const dotRadius = geoPoints.length === 1 ? 4 : 2.6;
                geoPoints.forEach((point) => {
                    seriesGroup.appendChild(svgNode('circle', {
                        cx: round2(point.x), cy: round2(point.y), r: dotRadius,
                        fill: meta.color, stroke: theme.card, 'stroke-width': 1
                    }));
                });
            }
            geoPoints.forEach((point) => {
                const pointValue = format(point.source.y);
                const hit = svgNode('circle', {
                    cx: round2(point.x), cy: round2(point.y), r: hitRadius,
                    fill: 'transparent', 'pointer-events': 'all'
                });
                hitGroup.appendChild(hit);
                bindInteractive(ctx, hit, {
                    ariaLabel: `${point.source.x} ${meta.name} ${pointValue}`,
                    title: `${point.source.x}：${meta.name} ${pointValue}`,
                    content: () => ({
                        title: String(point.source.x),
                        rows: [{ label: showLegend ? meta.name : '', value: pointValue, color: meta.color }]
                    }),
                    onActivate: onSelect ? () => onSelect({
                        point: point.source.raw, series: meta, seriesIndex,
                        pointIndex: point.source.pointIndex, x: point.source.x, y: point.source.y
                    }, point.source.pointIndex) : null
                });
            });
        });
    }, height);
}

// ============================================================================
// §6 日历热力图（周一为一周起点，7 列等宽，移动端无横向滚动）
// ============================================================================

/** 解析 'YYYY-MM'，非法返回 null */
function parseMonth(value) {
    const matched = /^(\d{4})-(\d{2})$/.exec(String(value === undefined || value === null ? '' : value));
    if (!matched) return null;
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    if (!(year >= 1970 && year <= 9999) || !(month >= 1 && month <= 12)) return null;
    return { year, month };
}

/** 本地时区安全的 Date 构造（避免 new Date('YYYY-MM-DD') 的 UTC 偏移） */
function localDate(year, month, day) {
    return new Date(year, month - 1, day);
}

/** Date → 'YYYY-MM-DD' */
function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 渲染月历热力图。颜色深浅 = 当日 value / 当月最大值；今天虚线圈出，相邻月份日期淡化。
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {string} opts.month 'YYYY-MM'，非法时渲染「暂无数据」
 * @param {Record<string, {value:number, count:number}>} [opts.days] 以 'YYYY-MM-DD' 为键
 * @param {(cents:number)=>string} [opts.valueFormat] 默认 formatCompact
 * @param {(dateStr:string)=>void} [opts.onSelect] 点击本月日期（相邻月日期不可交互）
 * @param {string} [opts.selected] 选中的日期 'YYYY-MM-DD'
 * @param {number} [opts.height]
 * @returns {{destroy:()=>void}}
 */
export function renderCalendar(container, opts) {
    const options = opts || {};
    const format = typeof options.valueFormat === 'function' ? options.valueFormat : formatCompact;
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    const selected = typeof options.selected === 'string' ? options.selected : null;
    const parsed = parseMonth(options.month);
    if (!parsed) return mountEmpty(container, options);

    const dayMap = options.days && typeof options.days === 'object' ? options.days : {};
    const firstOfMonth = localDate(parsed.year, parsed.month, 1);
    const daysInMonth = new Date(parsed.year, parsed.month, 0).getDate();
    const offset = (firstOfMonth.getDay() + 6) % 7; // 周一 = 0
    const weekCount = Math.ceil((offset + daysInMonth) / 7);
    const gridStart = localDate(parsed.year, parsed.month, 1 - offset);
    const monthPrefix = `${parsed.year}-${pad2(parsed.month)}`;

    const readDay = (key) => {
        const entry = dayMap[key];
        if (!entry || typeof entry !== 'object') return null;
        return { value: toFinite(entry.value, 0), count: toFinite(entry.count, 0) };
    };
    let monthMax = 0;
    let monthTotal = 0;
    let activeDays = 0;
    for (const key of Object.keys(dayMap)) {
        if (!key.startsWith(monthPrefix)) continue;
        const entry = readDay(key);
        if (!entry || !(entry.value > 0)) continue;
        monthMax = Math.max(monthMax, entry.value);
        monthTotal += entry.value;
        activeDays += 1;
    }

    const ariaLabel = options.ariaLabel
        || `${parsed.year} 年 ${parsed.month} 月日历，${activeDays} 天有记录，合计 ${format(monthTotal)}`;
    const today = dateKey(new Date());
    const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'];
    const headerHeight = 20;
    const gap = 2;

    return mountChart(container, { ...options, ariaLabel }, (ctx) => {
        const { svg, width, theme } = ctx;
        const cellWidth = (width - 4) / 7;
        const availableHeight = Math.max(40, ctx.height - headerHeight - 4);
        const cellHeight = availableHeight / weekCount;
        const showValue = cellWidth >= 34 && cellHeight >= 26;
        const valueFont = Math.min(9.5, Math.max(7.5, cellWidth * 0.2));
        const dayFont = Math.min(11.5, Math.max(9, cellWidth * 0.26));
        const cells = svgNode('g');
        svg.appendChild(cells);

        weekdayLabels.forEach((label, index) => {
            appendText(svg, {
                x: 2 + cellWidth * index + cellWidth / 2, y: 10, text: label,
                size: 10.5, fill: theme.muted, anchor: 'middle'
            });
        });

        for (let row = 0; row < weekCount; row += 1) {
            for (let col = 0; col < 7; col += 1) {
                const index = row * 7 + col;
                const date = localDate(gridStart.getFullYear(), gridStart.getMonth() + 1, gridStart.getDate() + index);
                const key = dateKey(date);
                const inMonth = date.getMonth() === parsed.month - 1 && date.getFullYear() === parsed.year;
                const entry = readDay(key);
                const value = entry ? entry.value : 0;
                const cellX = 2 + col * cellWidth + gap;
                const cellY = headerHeight + row * cellHeight + gap;
                const cellW = Math.max(4, cellWidth - gap * 2);
                const cellH = Math.max(4, cellHeight - gap * 2);
                const ratio = inMonth && monthMax > 0 && value > 0 ? value / monthMax : 0;
                const intensity = ratio > 0 ? 0.1 + 0.5 * Math.pow(ratio, 0.6) : 0;
                const isToday = key === today;
                const isSelected = selected === key;
                const group = svgNode('g');
                group.appendChild(svgNode('rect', {
                    x: round2(cellX), y: round2(cellY), width: round2(cellW), height: round2(cellH),
                    rx: Math.min(6, cellW / 3),
                    fill: intensity > 0 ? theme.brand : 'transparent',
                    'fill-opacity': intensity > 0 ? String(round2(intensity)) : null,
                    stroke: isSelected ? theme.text : (isToday ? theme.brand : null),
                    'stroke-width': isSelected ? 2 : (isToday ? 1.4 : null),
                    'stroke-dasharray': isToday && !isSelected ? '3 2' : null
                }));
                cells.appendChild(group);
                appendText(group, {
                    x: cellX + cellW / 2, y: cellY + Math.min(14, cellH * 0.34), text: String(date.getDate()),
                    size: dayFont, weight: isToday ? 600 : 400, fill: inMonth ? theme.text : theme.muted,
                    opacity: inMonth ? 1 : 0.45, anchor: 'middle'
                });
                if (inMonth && showValue && value > 0) {
                    appendText(group, {
                        x: cellX + cellW / 2, y: cellY + Math.min(cellH - 5, cellH * 0.72),
                        text: truncateToWidth(format(value), cellW - 2, valueFont),
                        title: format(value), size: valueFont, fill: theme.muted, anchor: 'middle'
                    });
                }
                if (inMonth) {
                    bindInteractive(ctx, group, {
                        ariaLabel: `${key} ${value > 0 ? format(value) : '无记录'}`,
                        title: `${key}${value > 0 ? `：${format(value)} · ${entry ? entry.count : 0} 笔` : '：无记录'}`,
                        content: () => ({
                            title: key,
                            rows: value > 0
                                ? [{ value: format(value) }, { label: '笔数', value: String(entry ? entry.count : 0) }]
                                : [{ label: '无记录', value: '' }]
                        }),
                        onActivate: onSelect ? () => onSelect(key) : null
                    });
                }
            }
        }

        // 日历承载的是全部信息（日期 + 金额），不做「从 0 淡入」：
        // 任何一次重渲染（例如 ResizeObserver 回调）被截在动画中间，整个月都会看不见。
        cells.setAttribute('opacity', '1');
    }, Math.round(clamp(toFinite(options.height, headerHeight + weekCount * 38 + 6), 140, 2000)));
}
