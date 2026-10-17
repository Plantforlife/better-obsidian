"use strict";
const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  FileView,
  Modal,
  Notice,
  TFile,
  TFolder
} = require("obsidian");

const DEFAULTS = {
  // 滚动同步与双栏
  enabled: true,
  linkedOnly: false,
  smoothWheel: true,
  smoothness: 70,
  heightMode: "stretch",
  wheelByFaster: true,
  autoDual: true,
  scrollSync: true,

  // 缩放控制
  lockDefaultZoom: true,

  // 文件列表增强与快捷键
  showTrashIcon: true,
  confirmDelete: true,
  enableDelHotkey: true,
  delHotkey: "Delete",
  enableF2Rename: true,
  renameHotkey: "F2"
};

const LINE_PX = 40;
const TOUCHPAD_PX = 40;
const WRITE_GRACE = 200;
const RESIZE_GRACE = 300;
const BLEND = 0.35;
const MAX_SEGMENTS = 400;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const now = () => performance.now();

function lastAtMost(arr, value) {
  let lo = 0, hi = arr.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// 快捷键匹配函数
function matchesHotkey(event, hotkeyStr) {
  if (!hotkeyStr) return false;
  const parts = hotkeyStr.split("+");
  const mainKey = parts[parts.length - 1].trim();
  const reqCtrl = parts.includes("Ctrl");
  const reqAlt = parts.includes("Alt");
  const reqShift = parts.includes("Shift");
  const reqMeta = parts.includes("Meta");

  if (!!event.ctrlKey !== reqCtrl) return false;
  if (!!event.altKey !== reqAlt) return false;
  if (!!event.shiftKey !== reqShift) return false;
  if (!!event.metaKey !== reqMeta) return false;

  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (mainKey.toLowerCase() === "space" && event.key === " ") return true;
  if ((mainKey.toLowerCase() === "del" || mainKey.toLowerCase() === "delete") &&
      (event.key === "Delete" || event.key === "Del")) return true;

  return eventKey.toLowerCase() === mainKey.toLowerCase();
}

// ----------------- CodeMirror 与 阅读视图桥接 -----------------
class CmBridge {
  constructor(mode, cm) {
    this.kind = "cm";
    this.mode = mode;
    this.cm = cm;
    this.scrollEl = cm.scrollDOM;
    this.contentEl = cm.contentDOM;
  }
  prepare() {
    const el = this.scrollEl;
    this.top = el.scrollTop;
    this.height = el.clientHeight;
    this.max = Math.max(0, el.scrollHeight - this.height);
    const docTop = this.cm.documentTop;
    this.origin = finite(docTop) ? docTop - el.getBoundingClientRect().top - el.clientTop + this.top : this.cm.contentDOM.offsetTop;
    this.doc = this.cm.state.doc;
  }
  span(block) {
    const doc = this.doc;
    const first = doc.lineAt(block.from).number - 1;
    const count = Math.max(1, doc.lineAt(block.to).number - first);
    let top = this.origin + block.top, height = block.height;
    if (first === 0) { height += top; top = 0; }
    return { first, count, top, height };
  }
  yAt(line) {
    const doc = this.doc;
    if (line <= 0) return 0;
    if (line >= doc.lines) {
      const b = this.cm.lineBlockAt(doc.length);
      return this.origin + b.top + b.height;
    }
    const s = this.span(this.cm.lineBlockAt(doc.line(Math.floor(line) + 1).from));
    return s.top + (line - s.first) * s.height / s.count;
  }
  lineAt(y) {
    if (y <= 0) return 0;
    const s = this.span(this.cm.lineBlockAtHeight(Math.max(0, y - this.origin)));
    return s.first + s.count * clamp((y - s.top) / Math.max(1, s.height), 0, 1);
  }
  rangeAtY(y) {
    const s = this.span(this.cm.lineBlockAtHeight(Math.max(0, y - this.origin)));
    return [s.first, s.first + s.count];
  }
  rangeFromLine(line) {
    if (line >= this.doc.lines) return null;
    const s = this.span(this.cm.lineBlockAt(this.doc.line(Math.floor(line) + 1).from));
    return [s.first, s.first + s.count];
  }
}

class PreviewBridge {
  constructor(mode, renderer) {
    this.kind = "preview";
    this.mode = mode;
    this.renderer = renderer;
    this.scrollEl = renderer.previewEl;
    this.contentEl = renderer.sizerEl || renderer.previewEl;
  }
  prepare() {
    const el = this.scrollEl, r = this.renderer;
    this.top = el.scrollTop;
    this.height = el.clientHeight;
    this.max = Math.max(0, el.scrollHeight - this.height);
    const sections = r.sections || [];
    let sum = 0, measured = 0;
    for (const s of sections) if (s.height > 0) { sum += s.height; measured++; }
    const average = measured ? sum / measured : 0;
    const starts = [], tops = [], heights = [];
    let y = finite(r.topSpace) ? r.topSpace : 0, line = 0;
    for (const s of sections) {
      // 1. 过滤无效/占位的空节点（如首尾无高度、无行数、无 HTML 内容的占位节点）
      if (s.lines === 0 && s.height === 0 && (!s.html || !s.html.trim())) continue;

      let start = finite(s.start?.line) ? s.start.line : line;
      // 2. 防止任何非单调递增的异常行号倒退
      if (start < line) {
        if (s.lines === 0 || s.height === 0) continue;
        start = line;
      }
      const lines = finite(s.lines) ? s.lines : finite(s.end?.line) ? Math.max(1, s.end.line - start + 1) : 1;
      const h = s.shown === false ? 0 : s.computed || s.height > 0 ? s.height : average;

      // 3. 合并同行起点的零高度节点，确保单调性
      if (starts.length > 0 && starts[starts.length - 1] === start && heights[heights.length - 1] === 0) {
        heights[heights.length - 1] = h;
      } else {
        starts.push(start);
        tops.push(y);
        heights.push(h);
      }
      y += h;
      line = Math.max(line, start + lines);
    }
    if (tops.length) { heights[0] += tops[0]; tops[0] = 0; }
    this.starts = starts; this.tops = tops; this.heights = heights;
    this.endLine = line; this.endY = y;
  }
  next(k) {
    return k + 1 < this.starts.length ? this.starts[k + 1] : this.endLine;
  }
  yAt(line) {
    if (!this.starts.length || line <= 0) return 0;
    if (line >= this.endLine) return this.endY;
    const k = lastAtMost(this.starts, line);
    if (k < 0) return 0;
    const from = this.starts[k], to = this.next(k);
    return this.tops[k] + (to > from ? clamp((line - from) / (to - from), 0, 1) : 0) * this.heights[k];
  }
  lineAt(y) {
    if (!this.starts.length || y <= 0) return 0;
    if (y >= this.endY) return this.endLine;
    const k = lastAtMost(this.tops, y);
    if (k < 0) return 0;
    const from = this.starts[k], to = this.next(k);
    const t = this.heights[k] > 0 ? clamp((y - this.tops[k]) / this.heights[k], 0, 1) : 0;
    return from + t * (to - from);
  }
  anchors() {
    const list = this.starts.slice();
    if (!list.length || list[0] > 0) list.unshift(0);
    list.push(this.endLine);
    return list;
  }
}

// ----------------- 滚动映射计算 -----------------
class PairMap {
  constructor(L, F, mode) {
    this.L = L;
    this.F = F;
    this.match = mode !== "stretch";
    this.anchors = L.kind === "preview" ? L.anchors() : F.kind === "preview" ? F.anchors() : null;
  }
  segAt(y) {
    const A = this.anchors;
    if (!A) {
      const [l0, l1] = this.L.rangeAtY(y);
      return { k: -1, l0, l1 };
    }
    let lo = 0, hi = A.length - 2;
    if (hi < 0) return { k: 0, l0: 0, l1: 0 };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.L.yAt(A[mid]) <= y) lo = mid; else hi = mid - 1;
    }
    return { k: lo, l0: A[lo], l1: A[lo + 1] };
  }
  next(seg) {
    const A = this.anchors;
    if (A) return seg.k + 2 < A.length ? { k: seg.k + 1, l0: A[seg.k + 1], l1: A[seg.k + 2] } : null;
    const range = this.L.rangeFromLine(seg.l1);
    return range && range[1] > seg.l1 ? { k: -1, l0: seg.l1, l1: range[1] } : null;
  }
  geom(seg) {
    const { L, F } = this;
    return { y0: L.yAt(seg.l0), y1: L.yAt(seg.l1), f0: F.yAt(seg.l0), f1: F.yAt(seg.l1) };
  }
  value(g, y) {
    const hl = g.y1 - g.y0, hf = Math.max(0, g.f1 - g.f0);
    if (hl <= 0) return g.f1;
    const u = clamp(y - g.y0, 0, hl);
    if (this.match && hf < hl) return g.f0 + Math.max(0, u - (hl - hf));
    return g.f0 + u * hf / hl;
  }
  at(y) {
    return this.value(this.geom(this.segAt(y)), y);
  }
  average(a, b) {
    if (b - a < 0.5) return this.at((a + b) / 2);
    let seg = this.segAt(a), g = this.geom(seg);
    let px = a, pf = this.value(g, a), area = 0;
    const add = (x, f) => {
      if (x > px) { area += (x - px) * (pf + f) / 2; px = x; }
      pf = f;
    };
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const hl = g.y1 - g.y0, hf = Math.max(0, g.f1 - g.f0);
      if (i > 0) { add(g.y0, pf); pf = g.f0; }
      if (this.match && hl > 0 && hf < hl) {
        const kink = g.y0 + hl - hf;
        if (kink > px && kink < b) add(kink, g.f0);
      }
      if (g.y1 >= b) break;
      add(g.y1, g.f1);
      const nextSeg = this.next(seg);
      if (!nextSeg) break;
      seg = nextSeg;
      g = this.geom(seg);
    }
    add(b, this.value(g, b));
    return area / (b - a);
  }
  smoothed(s) {
    const L = this.L;
    if (L.max <= 0) return this.at(s);
    const half = Math.min(L.height * BLEND / 2, s, L.max - s);
    return half >= 0.5 ? this.average(s - half, s + half) : this.at(s);
  }
}

function targetFor(L, F, s, mode) {
  const map = new PairMap(L, F, mode);
  const f = map.smoothed(s);
  // 当文档总高度较短时（如 L.max < L.height），防止底部过渡区从 0 开始占满整个文档导致整篇缩放失真
  const bottomZone = Math.min(L.height, Math.max(60, L.max * 0.25));
  const start = Math.max(0, L.max - bottomZone);
  if (L.max <= 0 || s <= start) return f;
  const fStart = map.smoothed(start), fEnd = map.at(L.max);
  if (fEnd - fStart > 0.5 && F.max > fStart) return fStart + (f - fStart) * (F.max - fStart) / (fEnd - fStart);
  return Math.min(f, F.max);
}

const project = (C, X, c, mode) => (X === C ? c : targetFor(C, X, c, mode));

function solve(L, bridges, s, mode) {
  let C = L;
  for (const b of bridges) if (b.max > C.max) C = b;
  if (C === L) return { C, c: s };
  let lo = 0, hi = C.max;
  for (let i = 0; i < 40 && hi - lo > 0.05; i++) {
    const mid = (lo + hi) / 2;
    if (targetFor(C, L, mid, mode) < s) lo = mid; else hi = mid;
  }
  return { C, c: (lo + hi) / 2 };
}

function canScrollInside(target, root, dy) {
  let el = target instanceof Element ? target : target?.parentElement;
  for (; el && el !== root; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") continue;
    if (dy < 0 ? el.scrollTop > 0.5 : el.scrollTop + el.clientHeight < el.scrollHeight - 0.5) return true;
  }
  return false;
}

// ----------------- 同步引擎 -----------------
class SmoothScrollSync {
  constructor(plugin) {
    this.plugin = plugin;
    this.workspace = plugin.app.workspace;
    this.win = this.workspace.containerEl.ownerDocument.defaultView;
    this.records = new Map();
    this.leader = null;
    this.anim = null;
    this.frame = 0;
    this.refreshFrame = 0;
    this.peersDirty = true;
    this.handoff = false;
    this.errors = new Map();
    this.resizingUntil = 0;
    this.scrollEls = new WeakSet();
    this.restorePreview = null;
    this.observer = new this.win.ResizeObserver((entries) => {
      if (entries.some((entry) => this.scrollEls.has(entry.target))) this.resizingUntil = now() + RESIZE_GRACE;
      this.scheduleTick();
    });
  }

  patchPreview(view) {
    const proto = view.previewMode && Object.getPrototypeOf(view.previewMode);
    if (this.restorePreview || !proto || typeof proto.onResize !== "function") return;
    const original = proto.onResize;
    const sync = this;
    const patched = function (...args) {
      if (!sync.isFollower(this.view) || typeof this.renderer?.onResize !== "function") return original.apply(this, args);
      this.renderer.onResize();
    };
    proto.onResize = patched;
    this.restorePreview = () => {
      if (proto.onResize === patched) proto.onResize = original;
    };
  }

  settleAfterResize() {
    if (this.settleTimer) return;
    this.settleTimer = this.win.setTimeout(() => {
      this.settleTimer = 0;
      this.scheduleTick();
    }, Math.max(16, this.resizingUntil - now() + 16));
  }

  isFollower(view) {
    const record = this.settings.enabled && view && this.records.get(view.leaf);
    return !!record && record.peers.length > 0 && !!this.leader && this.leader !== record;
  }

  get settings() {
    return this.plugin.settings;
  }

  guard(context, fn) {
    try {
      return fn();
    } catch (error) {
      if (!this.errors.has(context)) console.error(`Better Obsidian scroll sync: ${context}`, error);
      this.errors.set(context, String(error?.stack || error));
    }
  }

  requestRefresh() {
    if (this.refreshFrame) return;
    this.refreshFrame = this.win.requestAnimationFrame(() => {
      this.refreshFrame = 0;
      this.guard("refresh", () => this.refresh());
    });
  }

  refresh() {
    const seen = new Set();
    this.workspace.iterateRootLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      seen.add(leaf);
      const record = this.records.get(leaf);
      if (record && record.view === leaf.view) return;
      if (record) this.detach(record);
      this.attach(leaf);
    });
    for (const [leaf, record] of this.records) if (!seen.has(leaf)) this.detach(record);
    this.recomputePeers();
    if (!this.leader || !this.leader.peers.length) {
      const active = this.records.get(this.workspace.activeLeaf);
      const candidate = active?.peers.length ? active : [...this.records.values()].find((r) => r.peers.length);
      if (candidate && candidate !== this.leader) {
        this.leader = candidate;
        for (const r of this.records.values()) r.offset = 0;
      }
    }
    this.scheduleTick();
  }

  attach(leaf) {
    const view = leaf.view;
    const record = { leaf, view, bridge: null, peers: [], observed: [], cleanups: [], scrolled: false, expected: null, lastWrite: 0, offset: 0, claimAt: 0 };
    this.patchPreview(view);
    const listen = (name, handler, options) => {
      const wrapped = (event) => this.guard(name, () => handler(event));
      view.containerEl.addEventListener(name, wrapped, options);
      record.cleanups.push(() => view.containerEl.removeEventListener(name, wrapped, options));
    };
    listen("wheel", (e) => this.onWheel(record, e), { capture: true, passive: false });
    listen("scroll", (e) => this.onScroll(record, e), { capture: true, passive: true });
    for (const name of ["pointerdown", "touchstart"]) listen(name, () => this.claim(record, true), { capture: true, passive: true });
    listen("keydown", () => this.claim(record, true), { capture: true });
    this.records.set(leaf, record);
    return record;
  }

  detach(record) {
    for (const cleanup of record.cleanups.splice(0)) cleanup();
    for (const el of record.observed.splice(0)) this.observer.unobserve(el);
    if (this.anim?.record === record) this.cancelAnim();
    if (this.leader === record) this.leader = null;
    this.records.delete(record.leaf);
    this.peersDirty = true;
  }

  bridge(record) {
    const view = record.view;
    const mode = typeof view.getMode === "function" ? view.getMode() : null;
    const current = record.bridge;
    if (current && current.mode === mode && current.scrollEl.isConnected) return current;
    let next = null;
    if (mode === "preview") {
      const renderer = view.previewMode?.renderer;
      if (renderer?.previewEl && Array.isArray(renderer.sections)) next = new PreviewBridge(mode, renderer);
    } else {
      const cm = view.editor?.cm || view.currentMode?.cm;
      if (cm?.scrollDOM && cm.contentDOM && typeof cm.lineBlockAt === "function" && typeof cm.lineBlockAtHeight === "function") next = new CmBridge(mode, cm);
    }
    for (const el of record.observed.splice(0)) this.observer.unobserve(el);
    record.bridge = next;
    record.offset = 0;
    record.expected = null;
    this.peersDirty = true;
    if (next) {
      this.scrollEls.add(next.scrollEl);
      for (const el of new Set([next.scrollEl, next.contentEl])) {
        this.observer.observe(el);
        record.observed.push(el);
      }
    }
    return next;
  }

  recomputePeers() {
    this.peersDirty = false;
    const groups = new Map();
    for (const r of this.records.values()) {
      r.peers = [];
      const b = this.bridge(r);
      const file = r.view.file?.path;
      if (!this.settings.enabled || !b || !file || !b.scrollEl.isConnected || b.scrollEl.clientHeight <= 0) continue;
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file).push(r);
    }
    for (const list of groups.values()) {
      for (const r of list) {
        r.peers = list.filter((o) => o !== r && (!this.settings.linkedOnly || (r.leaf.group && o.leaf.group === r.leaf.group)));
      }
    }
    if (this.leader && !this.records.has(this.leader.leaf)) this.leader = null;
  }

  peersOf(record) {
    this.bridge(record);
    if (this.peersDirty) this.recomputePeers();
    return record.peers;
  }

  managedPair(a, b) {
    if (!this.settings.enabled || !a || !b || a === b || !a.file || a.file !== b.file) return false;
    const ra = this.records.get(a.leaf), rb = this.records.get(b.leaf);
    return !!ra && !!rb && ra.peers.includes(rb);
  }

  isSynced(view) {
    return this.settings.enabled && !!this.records.get(view?.leaf)?.peers.length;
  }

  claim(record, handoff) {
    if (!this.settings.enabled || this.leader === record || !this.records.has(record.leaf)) return;
    this.cancelAnim();
    this.leader = record;
    record.offset = 0;
    if (handoff) {
      this.handoff = true;
      this.scheduleTick();
    } else {
      this.handoff = false;
      for (const r of this.records.values()) r.offset = 0;
    }
  }

  onScroll(record, event) {
    if (!this.settings.enabled || event.target !== this.bridge(record)?.scrollEl) return;
    record.scrolled = true;
    this.scheduleTick();
  }

  onWheel(record, e) {
    if (!this.settings.enabled || !this.settings.smoothWheel || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const b = this.bridge(record);
    if (!b || !b.scrollEl.contains(e.target)) return;
    if (!this.peersOf(record).length) return;
    if (canScrollInside(e.target, b.scrollEl, e.deltaY)) return;
    e.preventDefault();
    this.claim(record, true);
    const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? b.scrollEl.clientHeight : 1);
    if (!this.anim || this.anim.record !== record) {
      this.cancelAnim();
      this.anim = { record, pos: null, written: null, remaining: 0, last: 0, immediate: false };
    }
    const a = this.anim;
    if (Math.sign(px) !== Math.sign(a.remaining)) a.remaining = 0;
    a.remaining += px;
    const tau = Number(this.settings.smoothness) || 0;
    if (tau <= 0 || Math.abs(px) < TOUCHPAD_PX) a.immediate = true;
    this.scheduleTick();
  }

  cancelAnim() {
    this.anim = null;
  }

  scheduleTick() {
    if (this.frame || !this.settings.enabled) return;
    this.frame = this.win.requestAnimationFrame((ts) => {
      this.frame = 0;
      this.guard("tick", () => this.tick(ts));
    });
  }

  tick(ts) {
    if (this.peersDirty) this.recomputePeers();
    if (now() < this.resizingUntil && !this.anim) {
      for (const r of this.records.values()) r.scrolled = false;
      this.settleAfterResize();
      return;
    }
    let leader = this.leader;
    if (!leader) return;
    for (const r of [leader, ...leader.peers]) this.bridge(r);
    if (this.peersDirty) this.recomputePeers();
    let peers = leader.peers;

    for (const p of peers) {
      if (!p.scrolled) continue;
      p.scrolled = false;
      const top = p.bridge.scrollEl.scrollTop;
      if (p.expected !== null && Math.abs(top - p.expected) <= 1) continue;
      if (now() - p.lastWrite < WRITE_GRACE || now() < this.resizingUntil) continue;
      this.claim(p, false);
      leader = p;
      peers = p.peers;
      break;
    }
    leader.scrolled = false;
    if (!peers.length) return;

    const L = leader.bridge;
    L.prepare();
    for (const p of peers) p.bridge.prepare();
    const mode = this.settings.heightMode;
    let s = L.top;

    const bridges = peers.map((p) => p.bridge);
    if (this.handoff) {
      this.handoff = false;
      const { C, c } = solve(L, bridges, s, mode);
      for (const p of peers) {
        p.offset = p.bridge.top - project(C, p.bridge, c, mode);
        p.claimAt = s;
      }
    }

    const a = this.anim;
    if (a && a.record === leader) {
      if (a.pos === null || Math.abs(L.top - a.written) > 2) a.pos = L.top;
      let dv;
      if (a.immediate) {
        dv = a.remaining;
        a.immediate = false;
      } else {
        const dt = a.last ? Math.min(64, ts - a.last) : 16;
        dv = a.remaining * (1 - Math.exp(-dt / Math.max(1, Number(this.settings.smoothness) || 1)));
        if (Math.abs(a.remaining - dv) < 0.5) dv = a.remaining;
      }
      a.last = ts;
      a.remaining -= dv;
      const rate = this.settings.wheelByFaster ? this.rate(L, bridges, a.pos, mode) : 1;
      const next = clamp(a.pos + dv / Math.max(1, rate), 0, L.max);
      if (next === 0 || next === L.max) a.remaining = 0;
      a.pos = next;
      L.scrollEl.scrollTop = next;
      a.written = next;
      L.top = next;
      s = next;
      if (Math.abs(a.remaining) >= 0.5) this.scheduleTick();
      else this.anim = null;
    }

    const writes = [];
    const { C, c } = solve(L, bridges, s, mode);
    for (const p of peers) {
      const F = p.bridge;
      let f = project(C, F, c, mode);
      if (p.offset) {
        const decay = Math.exp(-Math.abs(s - p.claimAt) / Math.max(200, L.height));
        if (decay < 0.01) p.offset = 0;
        else f += p.offset * decay;
      }
      if (s <= 0.5) f = 0;
      else if (L.max > 0 && s >= L.max - 0.5) f = F.max;
      writes.push([p, clamp(f, 0, F.max)]);
    }
    const stamp = now();
    leader.expected = s;
    for (const [p, f] of writes) {
      if (Math.abs(p.bridge.top - f) > 0.5) {
        p.bridge.scrollEl.scrollTop = f;
        p.lastWrite = stamp;
      }
      p.expected = f;
    }
  }

  rate(L, bridges, s, mode) {
    const { C, c } = solve(L, bridges, s, mode);
    const a = Math.max(0, c - 4), b = Math.min(C.max, c + 4);
    if (b - a < 1) return 1;
    const dl = project(C, L, b, mode) - project(C, L, a, mode);
    if (dl <= 1e-6) return 1;
    let rate = 0;
    for (const F of bridges) rate = Math.max(rate, (project(C, F, b, mode) - project(C, F, a, mode)) / dl);
    return rate;
  }

  alignNow() {
    this.refresh();
    const record = this.records.get(this.workspace.activeLeaf) || this.leader;
    if (!record || !record.peers.length) return false;
    this.claim(record, false);
    this.leader = record;
    for (const r of this.records.values()) r.offset = 0;
    this.scheduleTick();
    return true;
  }

  dispose() {
    this.cancelAnim();
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    if (this.refreshFrame) this.win.cancelAnimationFrame(this.refreshFrame);
    for (const record of [...this.records.values()]) this.detach(record);
    this.observer.disconnect();
    if (this.settleTimer) this.win.clearTimeout(this.settleTimer);
    this.restorePreview?.();
  }
}

// ----------------- 分栏控制器 (PaneController) -----------------
class PaneController {
  constructor(workspace, FileView, notice = () => {}) {
    this.workspace = workspace;
    this.FileView = FileView;
    this.notice = notice;
    this.lastDocument = null;
    this.created = [];
    this.busy = false;
  }

  documents() {
    const leaves = [];
    this.workspace.iterateRootLeaves(leaf => {
      const state = leaf.getViewState();
      if (leaf.view instanceof this.FileView || (leaf.isDeferred && state.state?.file)) {
        leaves.push(leaf);
      }
    });
    return leaves;
  }

  remember(leaf) {
    if (this.documents().includes(leaf)) this.lastDocument = leaf;
  }

  target() {
    const leaves = this.documents();
    return [this.workspace.activeLeaf, this.lastDocument, this.workspace.getMostRecentLeaf(), ...leaves]
      .find(leaf => leaves.includes(leaf)) || null;
  }

  async split(direction) {
    const source = this.target();
    if (!source || this.busy) return false;
    this.busy = true;
    let added = null;
    try {
      await source.loadIfDeferred();
      if (!this.documents().includes(source)) return false;
      const state = JSON.parse(JSON.stringify(source.getViewState()));
      state.active = true;
      state.pinned = false;
      const ephemeral = source.getEphemeralState();
      added = this.workspace.createLeafBySplit(source, direction, false);
      await added.setViewState(state, ephemeral);
      this.created.push({ leaf: added, source });
      this.workspace.setActiveLeaf(added, { focus: true });
      this.lastDocument = added;
      this.workspace.requestSaveLayout();
      return true;
    } catch (error) {
      if (added) added.detach();
      if (this.documents().includes(source)) this.workspace.setActiveLeaf(source, { focus: true });
      console.error("Better Obsidian: split failed", error);
      this.notice("分割失败，已恢复原文档面板。");
      return false;
    } finally {
      this.busy = false;
    }
  }

  opposite() {
    const source = this.target();
    if (!source) return null;
    const rect = source.view.containerEl.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return this.documents()
      .filter(leaf => leaf !== source && leaf.parent !== source.parent)
      .map(leaf => ({ leaf, rect: leaf.view.containerEl.getBoundingClientRect() }))
      .filter(item => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => {
        const distance = item => Math.hypot(item.rect.x + item.rect.width / 2 - center.x,
          item.rect.y + item.rect.height / 2 - center.y);
        return distance(a) - distance(b);
      })[0]?.leaf || null;
  }

  focusOpposite() {
    const leaf = this.opposite();
    if (!leaf) return false;
    this.workspace.setActiveLeaf(leaf, { focus: true });
    this.lastDocument = leaf;
    return true;
  }

  latestCreated() {
    const leaves = [];
    this.workspace.iterateRootLeaves(leaf => { leaves.push(leaf); });
    this.created = this.created.filter(item => leaves.includes(item.leaf));
    return this.created.at(-1) || null;
  }

  closeLatest() {
    if (this.busy) return false;
    const item = this.latestCreated();
    if (!item) return false;
    this.created = this.created.filter(candidate => candidate !== item);
    item.leaf.detach();
    if (this.documents().includes(item.source)) {
      this.workspace.setActiveLeaf(item.source, { focus: true });
      this.lastDocument = item.source;
    }
    return true;
  }
}

// ----------------- 二次确认弹窗 -----------------
class ConfirmDeleteModal extends Modal {
  constructor(app, file, onConfirm) {
    super(app);
    this.file = file;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "移至回收站" });
    const p = contentEl.createEl("p");
    p.createSpan({ text: "确定要将文档 " });
    p.createEl("strong", { text: `「${this.file.name}」` });
    p.createSpan({ text: " 移至回收站吗？" });

    const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnContainer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());

    const confirmBtn = btnContainer.createEl("button", {
      cls: "mod-warning",
      text: "删除"
    });
    confirmBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    confirmBtn.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ----------------- Better Obsidian 主插件 -----------------
module.exports = class BetterObsidianPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());

    // 0. 重置并锁定缩放比例为 100% (zoom = 0)
    if (this.settings.lockDefaultZoom !== false) {
      this.resetZoomLevel();
    }

    // 1. 同步滚动与双栏控制器
    this.sync = new SmoothScrollSync(this);
    this.register(() => this.sync.dispose());
    this.patchNative();

    // 2. 分割控制器 (来自 Codex)
    this.controller = new PaneController(this.app.workspace, FileView, msg => new Notice(msg));

    // 3. 事件注册
    for (const name of ["layout-change", "active-leaf-change", "file-open", "resize"]) {
      this.registerEvent(this.app.workspace.on(name, () => {
        this.sync.requestRefresh();
        this.scheduleExplorerUpdate();
      }));
    }

    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      this.controller.remember(leaf);
      if (this.controller.documents().includes(leaf)) this.clearFolderSelection();
      this.scheduleRibbonUpdate?.();
    }));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.scheduleRibbonUpdate?.();
    }));

    this.registerEvent(this.app.workspace.on("file-open", (file) => file && this.scheduleAutoDual()));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.layoutReady && file?.extension === "md") this.created = { path: file.path, at: Date.now() };
      this.scheduleExplorerUpdate();
    }));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleExplorerUpdate()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleExplorerUpdate()));

    this.register(() => window.clearTimeout(this.autoDualTimer));

    // 4. 注册命令
    this.registerCommands();

    // 5. 侧栏功能监听
    this.app.workspace.onLayoutReady(() => {
      this.sync.requestRefresh();
      this.layoutReady = true;
      this.controller.remember(this.app.workspace.activeLeaf);
      this.watchFileList();
      this.watchFolderSelection();
      this.watchFileExplorerKeys();
      this.scheduleExplorerUpdate();
    });

    // 6. 注册设置页
    this.addSettingTab(new BetterObsidianSettingsTab(this.app, this));
  }

  resetZoomLevel() {
    try {
      const { webFrame } = require("electron");
      if (webFrame) {
        webFrame.setZoomLevel(0);
      }
    } catch (e) {}
  }

  registerCommands() {
    // 重置缩放
    this.addCommand({
      id: "reset-zoom",
      name: "重置窗口缩放为 100%",
      callback: () => {
        this.resetZoomLevel();
        new Notice("窗口缩放已重置为 100%");
      }
    });

    // 双栏与同步
    const dualTitle = "对半分：源码 / 阅读";
    this.addRibbonIcon("columns-2", dualTitle, () => this.sync.guard("dual view", () => this.toggleDualView()));
    this.addCommand({
      id: "dual-view",
      name: `${dualTitle}（再次执行恢复单栏）`,
      icon: "columns-2",
      callback: () => this.sync.guard("dual view", () => this.toggleDualView())
    });

    this.addCommand({
      id: "toggle-sync",
      name: "切换平滑同步滚动",
      callback: async () => {
        await this.update({ enabled: !this.settings.enabled });
        new Notice(this.settings.enabled ? "平滑同步滚动已开启" : "平滑同步滚动已关闭");
      }
    });

    this.addCommand({
      id: "align-now",
      name: "以当前面板立即对齐",
      callback: () => this.sync.alignNow()
    });

    // 分割管理命令 (Codex 原命令保持)
    const splitCommands = [
      { id: "split-right", name: "向右分割当前文档", icon: "columns-2",
        modifiers: ["Mod", "Alt"], key: "\\", run: () => this.controller.split("vertical") },
      { id: "split-down", name: "向下分割当前文档", icon: "rows-2",
        modifiers: ["Mod", "Alt", "Shift"], key: "\\", run: () => this.controller.split("horizontal") },
      { id: "focus-opposite", name: "切换到对侧文档", icon: "arrow-right-left",
        modifiers: ["Mod", "Alt"], key: "]", available: () => !!this.controller.opposite(),
        run: () => this.controller.focusOpposite() },
      { id: "close-last-split", name: "关闭最近创建的分割", icon: "panel-right-close",
        modifiers: ["Mod", "Alt"], key: "[", available: () => !!this.controller.latestCreated(),
        run: () => this.controller.closeLatest() }
    ];

    for (const cmd of splitCommands) {
      this.addCommand({
        id: cmd.id, name: cmd.name, icon: cmd.icon,
        hotkeys: [{ modifiers: cmd.modifiers, key: cmd.key }],
        checkCallback: checking => {
          const available = !this.controller.busy && (cmd.available ? cmd.available() : !!this.controller.target());
          if (available && !checking) void cmd.run();
          return available;
        }
      });
    }

    // 快捷删除命令
    this.addCommand({
      id: "trash-current-file",
      name: "将当前或选中的文档移至回收站",
      icon: "trash-2",
      checkCallback: (checking) => {
        if (!this.settings.enableDelHotkey) return false;
        const target = this.resolveCurrentTargetFile();
        if (!target) return false;
        if (checking) return true;
        this.confirmTrashFile(target);
        return true;
      }
    });

    // 快捷重命名命令
    this.addCommand({
      id: "rename-file",
      name: "重命名当前文档或选中项",
      icon: "pencil",
      checkCallback: (checking) => {
        if (!this.settings.enableF2Rename) return false;
        const target = this.resolveCurrentTargetFile();
        if (!target) return false;
        if (checking) return true;
        this.startRenameTarget(target);
        return true;
      }
    });
  }

  // ----------------- 文件与回收站处理 -----------------
  resolveCurrentTargetFile() {
    const doc = activeDocument || document;
    const activeEl = doc.activeElement;
    const inExplorer = activeEl?.closest?.('.workspace-leaf-content[data-type="file-explorer"]');
    if (inExplorer && this.lastHoveredOrClickedFile) {
      return this.lastHoveredOrClickedFile;
    }
    const explorerView = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    const focused = explorerView?.tree?.focusedItem?.file || explorerView?.activeDom?.file;
    if (inExplorer && focused) return focused;

    return this.app.workspace.getActiveFile() || focused || this.lastHoveredOrClickedFile || null;
  }

  async confirmTrashFile(file) {
    if (!file) return;
    if (this.settings.confirmDelete !== false) {
      new ConfirmDeleteModal(this.app, file, async () => {
        await this.app.fileManager.trashFile(file);
        new Notice(`已将「${file.name}」移至回收站`);
      }).open();
    } else {
      await this.app.fileManager.trashFile(file);
      new Notice(`已将「${file.name}」移至回收站`);
    }
  }

  startRenameTarget(file) {
    if (!file) return;
    const explorerView = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    if (explorerView && typeof explorerView.startRenameFile === "function") {
      explorerView.startRenameFile(file);
    } else {
      this.app.fileManager.promptForFileRename(file);
    }
  }

  // ----------------- 文件列表垃圾桶注入 -----------------
  scheduleExplorerUpdate() {
    window.clearTimeout(this.explorerUpdateTimer);
    this.explorerUpdateTimer = window.setTimeout(() => this.updateFileExplorer(), 60);
  }

  updateFileExplorer() {
    if (this.disposed) return;
    const showTrash = this.settings.showTrashIcon !== false;

    if (!showTrash) {
      document.querySelectorAll(".better-obsidian-trash-btn").forEach(el => el.remove());
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view?.fileItems) continue;

      for (const [path, item] of Object.entries(view.fileItems)) {
        if (!item || !item.selfEl || !(item.file instanceof TFile)) continue;
        if (item.selfEl.querySelector(".better-obsidian-trash-btn")) continue;

        const btn = document.createElement("div");
        btn.className = "better-obsidian-trash-btn";
        btn.setAttribute("aria-label", "移至回收站");
        btn.setAttribute("title", "移至回收站");
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.confirmTrashFile(item.file);
        });

        item.selfEl.appendChild(btn);
      }
    }
  }

  watchFileExplorerKeys() {
    const doc = this.app.workspace.containerEl.ownerDocument;
    this.registerDomEvent(doc, "pointerover", (event) => {
      const target = event.target?.closest?.(".nav-file-title, .nav-folder-title");
      if (!target) return;
      const explorerView = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
      if (!explorerView?.fileItems) return;
      for (const [path, item] of Object.entries(explorerView.fileItems)) {
        if (item.selfEl === target) {
          this.lastHoveredOrClickedFile = item.file;
          break;
        }
      }
    });

    this.registerDomEvent(doc, "keydown", (event) => {
      const activeEl = doc.activeElement;
      const isInput = activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.isContentEditable ||
        activeEl.closest(".cm-content") ||
        activeEl.closest(".cm-editor")
      );

      // 自定义快捷重命名
      if (this.settings.enableF2Rename !== false && matchesHotkey(event, this.settings.renameHotkey || "F2")) {
        if (!isInput || activeEl?.closest?.('.workspace-leaf-content[data-type="file-explorer"]')) {
          const target = this.resolveCurrentTargetFile();
          if (target) {
            event.preventDefault();
            event.stopPropagation();
            this.startRenameTarget(target);
          }
        }
        return;
      }

      // 自定义快捷删除文档
      if (this.settings.enableDelHotkey !== false && matchesHotkey(event, this.settings.delHotkey || "Delete")) {
        const inExplorer = activeEl?.closest?.('.workspace-leaf-content[data-type="file-explorer"]');
        if (inExplorer && !isInput) {
          const target = this.resolveCurrentTargetFile();
          if (target instanceof TFile) {
            event.preventDefault();
            event.stopPropagation();
            this.confirmTrashFile(target);
          }
        }
      }
    });
  }

  // ----------------- 侧栏与文件夹样式联动 (Codex) -----------------
  clearFolderSelection() {
    this.currentFolderTitle?.classList.remove("openai-ui-folder-current");
    this.currentFolderTitle = null;
  }

  watchFolderSelection() {
    const workspaceEl = this.app.workspace.containerEl;
    this.registerDomEvent(workspaceEl, "pointerdown", event => {
      if (event.button !== 0) return;
      const target = event.target?.closest?.(".nav-file-title, .nav-folder-title");
      if (!target?.closest('.workspace-leaf-content[data-type="file-explorer"]')) return;
      this.clearFolderSelection();
      if (target.classList.contains("nav-folder-title") && !target.parentElement?.classList.contains("mod-root")) {
        this.currentFolderTitle = target;
        target.classList.add("openai-ui-folder-current");
      }
    });
    this.register(() => this.clearFolderSelection());
  }

  watchFileList() {
    const workspaceEl = this.app.workspace.containerEl;
    const doc = workspaceEl.ownerDocument;
    const win = doc.defaultView;
    let frame = 0;
    workspaceEl.classList.add("codex-pane-tools-active", "better-obsidian-active");

    const update = () => {
      frame = 0;
      const sidebarOpen = workspaceEl.classList.contains("is-left-sidedock-open");
      const fileListVisible = sidebarOpen && this.app.workspace.getLeavesOfType("file-explorer").some(leaf => {
        const el = leaf.view.containerEl;
        if (!workspaceEl.contains(el) || !el.closest(".mod-left-split")) return false;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        for (let node = el; node && node !== workspaceEl; node = node.parentElement) {
          const style = win.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      });
      if (workspaceEl.classList.contains("codex-file-list-open") !== fileListVisible) {
        workspaceEl.classList.toggle("codex-file-list-open", fileListVisible);
      }
    };

    this.scheduleRibbonUpdate = () => {
      if (!frame && !this.disposed) frame = win.requestAnimationFrame(update);
    };

    const observer = new win.MutationObserver(this.scheduleRibbonUpdate);
    observer.observe(workspaceEl, { attributes: true, attributeFilter: ["class"] });
    const sidebarEl = workspaceEl.querySelector(".mod-left-split");
    if (sidebarEl) observer.observe(sidebarEl, {
      attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: true
    });
    this.registerDomEvent(win, "resize", this.scheduleRibbonUpdate);
    this.register(() => {
      observer.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      workspaceEl.classList.remove("codex-file-list-open", "codex-pane-tools-active", "better-obsidian-active");
    });
    update();
  }

  // ----------------- 双栏与同步管理 -----------------
  targetLeaf() {
    const ws = this.app.workspace;
    const active = ws.getActiveViewOfType(MarkdownView)?.leaf;
    if (active) return active;
    const recent = ws.getMostRecentLeaf();
    return recent?.view instanceof MarkdownView ? recent : null;
  }

  groupPartners(leaf) {
    const list = [];
    if (!leaf?.group) return list;
    this.app.workspace.iterateRootLeaves((other) => {
      if (other !== leaf && other.group === leaf.group && other.parent !== leaf.parent) list.push(other);
    });
    return list;
  }

  async toggleDualView() {
    const ws = this.app.workspace;
    const source = this.targetLeaf();
    const file = source?.view.file;
    if (!file) {
      new Notice("请先打开一篇 Markdown 笔记");
      return;
    }
    const paired = this.groupPartners(source).find((leaf) => leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview");
    if (paired) {
      paired.detach();
      source.setGroup(null);
      this.dualDeclined = { leaf: source, file };
      ws.setActiveLeaf(source, { focus: true });
      return;
    }
    await this.ensureDual(source);
  }

  takeCreated(file) {
    const created = this.created;
    if (!created || created.path !== file?.path || Date.now() - created.at > 3000) return false;
    this.created = null;
    return true;
  }

  async normalizeDual(leaves) {
    const md = leaves.filter((leaf) => leaf.view instanceof MarkdownView && leaf.view.file);
    if (md.length < 2) return;
    md.sort((a, b) => a.view.containerEl.getBoundingClientRect().left - b.view.containerEl.getBoundingClientRect().left);
    const file = md[0].view.file;
    this.dualBusy = true;
    try {
      const [source, ...readers] = md;
      const state = source.getViewState();
      if (state.state?.mode !== "source" || state.state?.source !== true) {
        await source.setViewState({ ...state, state: { ...state.state, file: file.path, mode: "source", source: true } });
      }
      for (const leaf of readers) {
        if (leaf.view.file !== file || leaf.view.getMode() !== "preview") {
          await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview", source: false }, active: false });
        }
      }
      this.app.workspace.setActiveLeaf(source, { focus: true });
      this.sync.alignNow();
    } finally {
      this.dualBusy = false;
    }
  }

  async autoDual() {
    const ws = this.app.workspace;
    if (!this.settings.autoDual || this.dualBusy) return;
    const leaf = ws.getActiveViewOfType(MarkdownView)?.leaf;
    if (!leaf?.view.file || leaf.view.file.extension !== "md") return;
    if (typeof leaf.getRoot === "function" && leaf.getRoot() !== ws.rootSplit) return;
    const partners = this.groupPartners(leaf);
    if (partners.length) {
      if (this.takeCreated(leaf.view.file)) await this.normalizeDual([leaf, ...partners]);
      return;
    }
    if (await this.replaceWithNewNote(leaf)) return;
    if (this.dualDeclined?.leaf === leaf && this.dualDeclined.file === leaf.view.file) return;
    this.dualDeclined = null;
    await this.ensureDual(leaf);
  }

  async ensureDual(source) {
    const ws = this.app.workspace;
    const file = source.view.file;
    if (this.dualBusy || !file) return;
    this.dualBusy = true;
    try {
      let reading = null, previous = null;
      ws.iterateRootLeaves((leaf) => {
        if (leaf === source || leaf.parent === source.parent || !(leaf.view instanceof MarkdownView)) return;
        if (!reading && leaf.view.file === file) reading = leaf;
        if (!previous && leaf.group && leaf.view.getMode() === "preview" && source.parent?.children?.some((tab) => tab !== source && tab.group === leaf.group)) previous = leaf;
      });
      if (!reading && previous) {
        for (const tab of source.parent.children) if (tab !== source && tab.group === previous.group) tab.setGroup(null);
        reading = previous;
      }
      const created = !reading;

      const state = source.getViewState();
      if (state.state?.mode !== "source" || state.state?.source !== true) {
        await source.setViewState({ ...state, state: { ...state.state, mode: "source", source: true } });
      }
      if (created) reading = ws.createLeafBySplit(source, "vertical");
      await reading.setViewState({ type: "markdown", state: { file: file.path, mode: "preview", source: false }, active: false });
      if (!created && typeof ws.revealLeaf === "function") await ws.revealLeaf(reading);

      const group = source.group || reading.group || `dual-${Date.now().toString(36)}`;
      source.setGroup(group);
      reading.setGroup(group);

      const a = source.parent, b = reading.parent;
      if (created && a && b && a !== b && a.parent === b.parent && a.parent?.children?.length === 2 && typeof a.setDimension === "function") {
        a.setDimension(50);
        b.setDimension(50);
      }
      ws.setActiveLeaf(source, { focus: true });
      ws.requestSaveLayout?.();
      this.sync.alignNow();
    } finally {
      this.dualBusy = false;
    }
  }

  scheduleAutoDual() {
    if (!this.settings.autoDual || !this.layoutReady) return;
    window.clearTimeout(this.autoDualTimer);
    this.autoDualTimer = window.setTimeout(() => this.sync.guard("auto dual", () => this.autoDual()), 80);
  }

  async replaceWithNewNote(leaf) {
    const file = leaf.view.file;
    if (!this.takeCreated(file)) return false;
    const host = leaf.parent?.children?.find((tab) => tab !== leaf && tab.view instanceof MarkdownView &&
      this.groupPartners(tab).some((partner) => partner.view instanceof MarkdownView && partner.view.getMode() === "preview"));
    if (!host) return false;
    this.dualBusy = true;
    try {
      await host.openFile(file, { active: true, state: { mode: "source", source: true }, eState: { rename: "all" } });
      leaf.detach();
      for (const partner of this.groupPartners(host)) {
        if (!(partner.view instanceof MarkdownView)) continue;
        if (partner.view.file !== file || partner.view.getMode() !== "preview") {
          await partner.setViewState({ type: "markdown", state: { file: file.path, mode: "preview", source: false }, active: false });
        }
      }
      this.app.workspace.setActiveLeaf(host, { focus: true });
      this.sync.alignNow();
    } finally {
      this.dualBusy = false;
    }
    return true;
  }

  patchNative() {
    const proto = MarkdownView.prototype;
    const sync = this.sync;
    const restore = [];
    const receive = proto.receiveSyncState;
    if (typeof receive === "function") {
      const patched = function (source, ...rest) {
        if (sync.managedPair(source, this)) return;
        return receive.call(this, source, ...rest);
      };
      proto.receiveSyncState = patched;
      restore.push(() => proto.receiveSyncState === patched && (proto.receiveSyncState = receive));
    }
    const syncScroll = proto.syncScroll;
    if (typeof syncScroll === "function") {
      const timers = new Map();
      const patched = function (...args) {
        if (!sync.isSynced(this)) return syncScroll.apply(this, args);
        clearTimeout(timers.get(this));
        timers.set(this, setTimeout(() => {
          timers.delete(this);
          sync.guard("syncScroll", () => syncScroll.apply(this, args));
        }, 120));
      };
      proto.syncScroll = patched;
      restore.push(() => {
        for (const t of timers.values()) clearTimeout(t);
        if (proto.syncScroll === patched) proto.syncScroll = syncScroll;
      });
    }
    this.register(() => restore.forEach((fn) => fn()));
  }

  async update(patch) {
    Object.assign(this.settings, patch);
    await this.saveData(this.settings);
    if (!this.settings.enabled) this.sync.cancelAnim();
    this.sync.peersDirty = true;
    this.sync.refresh();
    this.scheduleExplorerUpdate();
  }

  onunload() {
    this.disposed = true;
    document.querySelectorAll(".better-obsidian-trash-btn").forEach(el => el.remove());
    this.clearFolderSelection();
  }
};

// ----------------- 设置面板 -----------------
class BetterObsidianSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Better Obsidian 设置" });

    // --- 界面缩放控制 ---
    new Setting(containerEl).setName("界面缩放控制").setHeading();

    new Setting(containerEl)
      .setName("启动时锁定并重置缩放比例为 100%")
      .setDesc("开启后，每次进入或重启 Obsidian 都会确保窗口缩放保持标准的 100%（0级缩放），防止误放大至 120%。")
      .addToggle((t) => t.setValue(s.lockDefaultZoom !== false).onChange((v) => this.plugin.update({ lockDefaultZoom: v })))
      .addButton((b) => b.setButtonText("立即恢复 100% 缩放").onClick(() => {
        this.plugin.resetZoomLevel();
        new Notice("窗口缩放已重置为 100%");
      }));

    // --- 文件管理与快捷键 ---
    new Setting(containerEl).setName("文件列表增强与快捷键").setHeading();

    new Setting(containerEl)
      .setName("文件列表快捷删除图标（垃圾桶）")
      .setDesc("鼠标悬停在文件项时在最右侧显示垃圾桶图标（当前打开的文件不常驻显示），点击可移至回收站。")
      .addToggle((t) => t.setValue(s.showTrashIcon !== false).onChange((v) => this.plugin.update({ showTrashIcon: v })));

    new Setting(containerEl)
      .setName("删除文档二次确认")
      .setDesc("开启后，点击垃圾桶或按快捷键删除文件时会弹出确认对话框，防止误删。")
      .addToggle((t) => t.setValue(s.confirmDelete !== false).onChange((v) => this.plugin.update({ confirmDelete: v })));

    // 自定义 Del 快捷键
    this.addCustomHotkeySetting(
      containerEl,
      "删除文档快捷键",
      "在文件列表中选中某文档时，按下该快捷键触发删除回收（文本编辑区打字时光标正常删除字符，不触发文档删除）。",
      s.delHotkey || "Delete",
      s.enableDelHotkey !== false,
      (newKey) => this.plugin.update({ delHotkey: newKey }),
      (enabled) => this.plugin.update({ enableDelHotkey: enabled }),
      "Delete"
    );

    // 自定义 F2 快捷键
    this.addCustomHotkeySetting(
      containerEl,
      "重命名文件/文件夹快捷键",
      "在文件列表中点击选中文件或文件夹后，按下该快捷键直接触发原地重命名。",
      s.renameHotkey || "F2",
      s.enableF2Rename !== false,
      (newKey) => this.plugin.update({ renameHotkey: newKey }),
      (enabled) => this.plugin.update({ enableF2Rename: enabled }),
      "F2"
    );

    // --- 双栏与平滑同步滚动 ---
    new Setting(containerEl).setName("双栏排版与平滑同步滚动").setHeading();

    new Setting(containerEl)
      .setName("同文件面板同步滚动")
      .setDesc("中央区域同时打开同一篇笔记时，按内容块位置逐帧对齐滚动。")
      .addToggle((t) => t.setValue(s.enabled).onChange((v) => this.plugin.update({ enabled: v })));

    new Setting(containerEl)
      .setName("打开或新建笔记时自动对半分")
      .setDesc("打开或新建笔记时，自动拆分为左侧源码编辑、右侧阅读视图的双栏联动界面。")
      .addToggle((t) => t.setValue(s.autoDual).onChange((v) => this.plugin.update({ autoDual: v })));

    new Setting(containerEl)
      .setName("仅同步已链接的标签")
      .setDesc("开启后，只有通过「链接标签」连在一起的面板才同步。")
      .addToggle((t) => t.setValue(s.linkedOnly).onChange((v) => this.plugin.update({ linkedOnly: v })));

    new Setting(containerEl)
      .setName("高度差处理")
      .setDesc("同一段内容两侧高度不同时（如源码一行对应阅读视图一张大图）。按比例：较矮的一侧放慢匀速移动；速度匹配：较矮的一侧同速移动后静止等待。")
      .addDropdown((d) => d
        .addOption("stretch", "按比例放慢")
        .addOption("match", "速度匹配 + 静止等待")
        .setValue(s.heightMode)
        .onChange((v) => this.plugin.update({ heightMode: v })));

    new Setting(containerEl)
      .setName("接管滚轮平滑滚动")
      .setDesc("由插件统一驱动滚轮滚动，主导与跟随面板在同一帧平滑移动。")
      .addToggle((t) => t.setValue(s.smoothWheel).onChange((v) => this.plugin.update({ smoothWheel: v })));

    new Setting(containerEl)
      .setName("滚轮以较快的一侧为准")
      .setDesc("在源码视图滚动经过大图时，源码自身放慢，让阅读视图的大图保持正常滚轮速度。")
      .addToggle((t) => t.setValue(s.wheelByFaster).onChange((v) => this.plugin.update({ wheelByFaster: v })));

    new Setting(containerEl)
      .setName("滚轮缓动时间")
      .setDesc("鼠标滚轮的平滑程度（毫秒，0 为不缓动，触控板始终直接跟手）。")
      .addSlider((sl) => sl.setLimits(0, 200, 10).setValue(s.smoothness).setDynamicTooltip().onChange((v) => this.plugin.update({ smoothness: v })));

    // --- 文档分割管理 ---
    new Setting(containerEl).setName("文档分割与窗口管理 (快捷键)").setHeading();
    const info = containerEl.createEl("div", { cls: "setting-item-description" });
    info.innerHTML = `
      <ul style="margin: 0; padding-inline-start: 20px; line-height: 1.8;">
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>\\</kbd> ：向右分割当前文档</li>
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>\\</kbd> ：向下分割当前文档</li>
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>]</kbd> ：切换到对侧文档</li>
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>[</kbd> ：关闭最近创建的分割</li>
      </ul>
      <p style="margin-top: 8px; color: var(--text-muted);">可在 Obsidian「设置 → 快捷键」中搜索「Better Obsidian」自定义以上任意分割快捷键。</p>
    `;
  }

  addCustomHotkeySetting(containerEl, name, desc, currentKey, isEnabled, onSaveKey, onToggleEnabled, defaultKey) {
    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(desc);

    // 开关
    setting.addToggle(toggle => {
      toggle.setValue(isEnabled).onChange(onToggleEnabled);
    });

    // 当前按键徽标
    const kbdEl = setting.controlEl.createEl("kbd", {
      text: currentKey || defaultKey,
      cls: "better-obsidian-kbd"
    });

    // 录制按钮
    const recordBtn = setting.controlEl.createEl("button", {
      text: "更改按键"
    });

    // 重置按钮
    const resetBtn = setting.controlEl.createEl("button", {
      text: "重置"
    });

    resetBtn.addEventListener("click", () => {
      kbdEl.setText(defaultKey);
      onSaveKey(defaultKey);
      new Notice(`已重置为默认按键：${defaultKey}`);
    });

    recordBtn.addEventListener("click", () => {
      recordBtn.setText("请按下按键...");
      recordBtn.addClass("mod-cta");
      kbdEl.setText("...");

      const handleKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Meta");

        let key = e.key;
        if (key === " ") key = "Space";
        else if (key === "Delete") key = "Delete";
        else if (key.length === 1) key = key.toUpperCase();

        parts.push(key);
        const hotkeyStr = parts.join("+");

        kbdEl.setText(hotkeyStr);
        recordBtn.setText("更改按键");
        recordBtn.removeClass("mod-cta");
        window.removeEventListener("keydown", handleKeyDown, true);

        onSaveKey(hotkeyStr);
        new Notice(`已保存快捷键：${hotkeyStr}`);
      };

      window.addEventListener("keydown", handleKeyDown, { capture: true, once: true });
    });
  }
}
