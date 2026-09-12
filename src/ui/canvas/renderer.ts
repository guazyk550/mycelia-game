/**
 * Canvas 网络渲染器：节点 / 连线 / 流动粒子 / 选中与悬停。
 *
 * 性能约束（GDD §21）：节点 1000 时仍要 ≥30fps。
 * 因此这里是"无对象分配"的热路径 —— 每帧只读取状态、直接绘制，
 * 不做 sort/filter（顺序由图的插入序保证）。
 */

import type { GameData } from '../../core/types.ts';
import type { GameState } from '../../core/state.ts';
import type { NodeInstance } from '../../core/network/graph.ts';
import { TILE_SIZE, occupiedTiles, snapToTile, tileKeyOf } from '../../core/network/occupancy.ts';
import { CLASS_COLORS, CLASS_SHAPE, LAYER_TINTS, THEME, TIER_RADIUS, nodeColor, nodeGlyph, type NodeShape } from '../theme.ts';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface RendererHooks {
  /** 每帧返回当前高亮的节点 id（悬停/选中） */
  highlighted?: () => string | null;
  /** 每帧返回最近一次 tick 中各节点的运行比例（缺料时 < 1） */
  throttleOf?: (nodeId: string) => number | undefined;
}

const GRID_SIZE = 64;

export class NetworkRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  camera: Camera = { x: 0, y: 0, scale: 1 };
  hooks: RendererHooks = {};
  /** 拖拽连线的实时预览（由 app 每帧设置） */
  dragPreview: { from: NodeInstance | null; to: { x: number; y: number } } | null = null;
  /**
   * 建造模式的落点预览（反馈 #6）：
   *   cursor = 鼠标所在的格；target = 实际会被放置的格（可能因占用而发生移位）。
   * 光标格与落点分开表达，玩家才能确认"点下去会放到哪"。
   */
  buildPreview: { cursor: { x: number; y: number } | null; target: { x: number; y: number } | null; shifted: boolean } | null = null;
  /** 拖拽移动节点时的预览：被拖动的节点 + 目标格 */
  movePreview: { nodeId: string; cursor: { x: number; y: number }; target: { x: number; y: number } | null; shifted: boolean } | null = null;
  /** 资源飘字（反馈 #2：让“产出生效”看得见） */
  private floats: { x: number; y: number; text: string; color: string; born: number }[] = [];

  /** 从某个世界坐标飘出一个 +N 文本 */
  spawnFloat(x: number, y: number, text: string, color: string): void {
    this.floats.push({ x, y, text, color, born: performance.now() });
    if (this.floats.length > 48) this.floats.shift();
  }
  private canvas: HTMLCanvasElement;
  private data: GameData;

  /** 每帧统计，供性能面板显示 */
  /** 移动端标记（影响 dpr 上限与粒子密度） */
  private mobile = false;
  lastFrameMs = 0;
  lastNodeCount = 0;
  /** 单帧渲染耗时采样（供压力测试取中位数） */
  frameSamples: number[] = [];
  /** 建造脉冲动画（新节点出现时扩散一圈） */
  private pulses: { x: number; y: number; born: number }[] = [];
  private knownNodes = new Set<string>();

  constructor(canvas: HTMLCanvasElement, data: GameData) {
    this.canvas = canvas;
    this.data = data;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
  }

  /** 供布局自检使用的画布元素 */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * 只设置像素缓冲（buffer）尺寸，CSS 尺寸交给布局（width/height:100%）。
   * 早期版本用 style.width = `${cssWidth}px` 会与 grid 列宽互相拉扯：
   * canvas 撑大列 → 列宽变大 → 下一帧再撑大（实测 1280 宽下画布被撑到 1165px）。
   */
  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(cssWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(cssHeight * this.dpr));
  }

  /** 屏幕坐标 → 世界坐标 */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    return {
      x: (cx - rect.width / 2) / this.camera.scale + this.camera.x,
      y: (cy - rect.height / 2) / this.camera.scale + this.camera.y,
    };
  }

  render(state: GameState, now: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.camera.scale * this.dpr, this.camera.scale * this.dpr);
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawLayerBands(state);
    this.drawGrid(w, h, state);
    this.drawBuildPreview(state);
    this.drawMovePreview(state);
    this.drawFloats();

    const highlighted = this.hooks.highlighted?.() ?? null;

    // 连线
    ctx.lineWidth = 1.5;
    for (const link of state.graph.links.values()) {
      const a = state.graph.nodes.get(link.from);
      const b = state.graph.nodes.get(link.to);
      if (!a || !b) continue;
      const active = highlighted === a.id || highlighted === b.id;
      ctx.strokeStyle = active ? THEME.linkActive : THEME.link;
      ctx.globalAlpha = active ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 流动粒子（只画一部分，保持帧率）；移动端再降一档（粒子是纯装饰，帧率优先）
    const linkCount = state.graph.links.size;
    const baseStride = linkCount > 400 ? 4 : linkCount > 150 ? 2 : 1;
    const particleStride = this.mobile ? baseStride * 2 : baseStride;
    let li = 0;
    for (const link of state.graph.links.values()) {
      li++;
      if (li % particleStride !== 0) continue;
      const a = state.graph.nodes.get(link.from);
      const b = state.graph.nodes.get(link.to);
      if (!a || !b || !a.built) continue;
      const phase = ((now / 1400 + li * 0.137) % 1 + 1) % 1;
      const px = a.x + (b.x - a.x) * phase;
      const py = a.y + (b.y - a.y) * phase;
      ctx.fillStyle = CLASS_COLORS[this.data.nodes.get(a.typeId)?.def.class ?? 'extractor'] ?? THEME.accent;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 节点
    this.lastNodeCount = state.graph.nodes.size;
    for (const node of state.graph.nodes.values()) {
      const def = this.data.nodes.get(node.typeId);
      if (!def) continue;
      const r = TIER_RADIUS[def.def.tier] ?? 14;
      const color = nodeColor(node.typeId, def.def.class);
      const shape = CLASS_SHAPE[def.def.class] ?? 'circle';
      const throttle = this.hooks.throttleOf?.(node.id);
      const stalled = throttle !== undefined && throttle < 1;

      if (!node.built) {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = THEME.warn;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        continue;
      }

      // 富饶度环（只对采掘节点显示，枯竭会明显变色）
      if (def.def.class === 'extractor') {
        const layer = this.data.layers.get(node.layerId);
        const ratio = layer ? Math.min(1, node.richness / Math.max(1, layer.richnessBase)) : 1;
        ctx.strokeStyle = ratio > 0.6 ? '#4ade80' : ratio > 0.3 ? '#fbbf24' : '#fb7185';
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 本体：形状按类，颜色按类型（形状描边 + 深色填充）
      pathShape(ctx, shape, node.x, node.y, r);
      ctx.fillStyle = stalled ? '#33272a' : '#12161d';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = node.id === highlighted ? 3.5 : 2;
      ctx.stroke();

      // 类型标识字符（反馈 #4：让同类节点可区分）
      ctx.fillStyle = stalled ? '#8a7f83' : color;
      ctx.font = `${Math.max(9, r * 0.82)}px ${THEME.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(nodeGlyph(def.def.name), node.x, node.y + 0.5);

      // 运行状态点（右下角）：运行中 / 缺料降速 / 完全停工
      const dotR = 3.2;
      const dx = node.x + r * 0.62;
      const dy = node.y + r * 0.62;
      ctx.beginPath();
      ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = throttle === undefined ? THEME.accent : throttle <= 0 ? THEME.danger : THEME.warn;
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.restore();

    // 建造脉冲：检测新出现的节点（在 restore 之后，用世界变换重绘）
    const nowTs = performance.now();
    let hasNew = false;
    for (const node of state.graph.nodes.values()) {
      if (!this.knownNodes.has(node.id)) {
        this.knownNodes.add(node.id);
        if (this.knownNodes.size > 1) {
          this.pulses.push({ x: node.x, y: node.y, born: nowTs });
          hasNew = true;
        }
      }
    }
    void hasNew;
    if (this.pulses.length > 0) this.pulses = this.pulses.filter((p) => nowTs - p.born < 700);
    if (this.pulses.length > 0) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(this.camera.scale * this.dpr, this.camera.scale * this.dpr);
      ctx.translate(-this.camera.x, -this.camera.y);
      ctx.strokeStyle = THEME.accent;
      ctx.lineWidth = 2;
      for (const p of this.pulses) {
        const t = (nowTs - p.born) / 700;
        ctx.globalAlpha = Math.max(0, 1 - t) * 0.8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14 + t * 46, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // 拖拽连线预览（在屏幕空间之外绘制，仍用世界变换，所以放在 restore 前）
    if (this.dragPreview?.from) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(this.camera.scale * this.dpr, this.camera.scale * this.dpr);
      ctx.translate(-this.camera.x, -this.camera.y);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = THEME.selection;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.dragPreview.from.x, this.dragPreview.from.y);
      ctx.lineTo(this.dragPreview.to.x, this.dragPreview.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    this.lastFrameMs = performance.now() - t0;
    this.frameSamples.push(this.lastFrameMs);
    if (this.frameSamples.length > 120) this.frameSamples.shift();
  }

  /** 最近采样的中位帧时间（压力测试用） */
  medianFrameMs(): number {
    if (this.frameSamples.length === 0) return 0;
    const sorted = [...this.frameSamples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  /**
   * 网格：细线 + 占用状态点（反馈 #7："不知道哪里能放"）。
   * 占用点在缩放太小时自动关闭，避免上千个点塔掉帧。
   */
  private drawGrid(w: number, h: number, state: GameState): void {
    const ctx = this.ctx;
    const left = this.camera.x - w / 2 / this.camera.scale;
    const right = this.camera.x + w / 2 / this.camera.scale;
    const top = this.camera.y - h / 2 / this.camera.scale;
    const bottom = this.camera.y + h / 2 / this.camera.scale;
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(left / GRID_SIZE) * GRID_SIZE; x < right; x += GRID_SIZE) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / GRID_SIZE) * GRID_SIZE; y < bottom; y += GRID_SIZE) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    // 占用状态点：只在看得清的时候画，且限制数量
    if (this.camera.scale < 0.45) return;
    const occupied = occupiedTiles(state);
    const colMin = Math.floor(left / TILE_SIZE) - 1;
    const colMax = Math.ceil(right / TILE_SIZE) + 1;
    const rowMin = Math.floor(top / TILE_SIZE) - 1;
    const rowMax = Math.ceil(bottom / TILE_SIZE) + 1;
    const span = (colMax - colMin) * (rowMax - rowMin);
    if (span > 6000) return; // 视野太宽时不画点
    const r = Math.max(1.4, 2.2 / this.camera.scale);
    for (let col = colMin; col <= colMax; col++) {
      for (let row = rowMin; row <= rowMax; row++) {
        const busy = occupied.has(`${col},${row}`);
        ctx.fillStyle = busy ? 'rgba(251,113,133,0.5)' : 'rgba(74,222,128,0.16)';
        ctx.beginPath();
        ctx.arc(col * TILE_SIZE, row * TILE_SIZE, busy ? r * 1.4 : r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * 建造模式的落点可视化（反馈 #6）：
   *   附近格子按占用情况着色（绿=空、红=占用）→ 光标格轮廓 → 真实落点实心高亮（移位时用虚线）
   */
  private drawBuildPreview(state: GameState): void {
    const p = this.buildPreview;
    if (!p?.cursor) return;
    const ctx = this.ctx;
    const half = TILE_SIZE / 2;
    const cursorCol = Math.round(p.cursor.x / TILE_SIZE);
    const cursorRow = Math.round(p.cursor.y / TILE_SIZE);
    const occupied = occupiedTiles(state);

    // 周边 9×9 格的占用情况（半透明填充，不遮挡节点）
    for (let dc = -4; dc <= 4; dc++) {
      for (let dr = -4; dr <= 4; dr++) {
        const col = cursorCol + dc;
        const row = cursorRow + dr;
        const busy = occupied.has(`${col},${row}`);
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = busy ? THEME.danger : THEME.accent;
        ctx.fillRect(col * TILE_SIZE - half + 3, row * TILE_SIZE - half + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      }
    }
    ctx.globalAlpha = 1;

    // 光标所在格
    ctx.strokeStyle = THEME.textFaint;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(cursorCol * TILE_SIZE - half, cursorRow * TILE_SIZE - half, TILE_SIZE, TILE_SIZE);
    ctx.setLineDash([]);

    // 真实落点（占用时会移位，用虚线边框明确区分）
    if (p.target) {
      const x = p.target.x - half + 1;
      const y = p.target.y - half + 1;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = THEME.accent;
      ctx.fillRect(x, y, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = THEME.accent;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(p.shifted ? [6, 4] : []);
      ctx.strokeRect(x, y, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.setLineDash([]);
    }
  }

  /**
   * 拖拽移动的预览：与建造预览共用网格着色，额外画出「原位置残影 + 光标处实体预览」，
   * 让玩家知道节点从哪儿来、要落到哪儿。
   */
  private drawMovePreview(state: GameState): void {
    const mv = this.movePreview;
    if (!mv) return;
    const ctx = this.ctx;
    const node = state.graph.nodes.get(mv.nodeId);
    if (!node) return;
    const half = TILE_SIZE / 2;

    const occupied = occupiedTiles(state);
    const self = snapToTile(node.x, node.y);
    occupied.delete(tileKeyOf(self.x, self.y)); // 计算空位时排除自己

    const col = Math.round(mv.cursor.x / TILE_SIZE);
    const row = Math.round(mv.cursor.y / TILE_SIZE);
    for (let dc = -3; dc <= 3; dc++) {
      for (let dr = -3; dr <= 3; dr++) {
        const busy = occupied.has(`${col + dc},${row + dr}`);
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = busy ? THEME.danger : THEME.accent;
        ctx.fillRect((col + dc) * TILE_SIZE - half + 3, (row + dr) * TILE_SIZE - half + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      }
    }
    ctx.globalAlpha = 1;

    if (mv.target) {
      const x = mv.target.x - half + 1;
      const y = mv.target.y - half + 1;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = THEME.selection;
      ctx.fillRect(x, y, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = THEME.selection;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(mv.shifted ? [6, 4] : []);
      ctx.strokeRect(x, y, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.setLineDash([]);
    }

    // 原位置残影
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = THEME.selection;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(node.x, node.y, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 光标处的实体预览
    const def = this.data.nodes.get(node.typeId);
    if (def) {
      const r = TIER_RADIUS[def.def.tier] ?? 14;
      const shape = CLASS_SHAPE[def.def.class] ?? 'circle';
      ctx.globalAlpha = 0.9;
      pathShape(ctx, shape, mv.cursor.x, mv.cursor.y, r);
      ctx.fillStyle = '#12161d';
      ctx.fill();
      ctx.strokeStyle = THEME.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** 飘字：1.1 秒内向上飘并淡出，只保留最近 48 条 */
  private drawFloats(): void {
    if (this.floats.length === 0) return;
    const ctx = this.ctx;
    const now = performance.now();
    this.floats = this.floats.filter((f) => now - f.born < 1100);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      const t = (now - f.born) / 1100;
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      ctx.fillStyle = f.color;
      ctx.font = `600 ${13 - t * 2}px ${THEME.font}`;
      ctx.fillText(f.text, f.x, f.y - 18 - t * 30);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /** 层带：加清晰边界线 + 层名徒章，让"这是哪一层、能不能放节点"一目了然 */
  private drawLayerBands(state: GameState): void {
    const ctx = this.ctx;
    const bandHeight = 420;
    for (const layer of this.data.layerOrder) {
      const y0 = layer.order * bandHeight;
      const unlocked = state.unlockedLayers.includes(layer.id);
      ctx.fillStyle = unlocked ? (LAYER_TINTS[layer.id] ?? THEME.bg) : '#0a0b0e';
      ctx.fillRect(-4000, y0 - 12, 8000, bandHeight - 24);

      // 上下边界线
      ctx.strokeStyle = unlocked ? THEME.border : '#15181d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-4000, y0 - 12);
      ctx.lineTo(4000, y0 - 12);
      ctx.stroke();

      // 层名徒章
      const label = unlocked
        ? `${layer.name} · 富饶基准 ${layer.richnessBase} · 产出 ×${layer.depthMul}`
        : `${layer.name}（未解锁）`;
      ctx.font = `12px ${THEME.font}`;
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = unlocked ? 'rgba(16,19,24,0.9)' : 'rgba(12,14,18,0.9)';
      ctx.beginPath();
      ctx.roundRect(-1400, y0 + 2, textW + 20, 22, 6);
      ctx.fill();
      ctx.strokeStyle = unlocked ? THEME.borderHover : '#1b1f26';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = unlocked ? THEME.textDim : THEME.textFaint;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, -1390, y0 + 13);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

// ---------------------------------------------------------------- 形状绘制
// 形状是「这是什么节点类」的第一层编码；配合类型色相偏移与标识字符，
// 同类节点（如掘进菌柄 / 分解丝 / 吸水菌丝）在画布上一眼可分。

function polygon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  sides: number,
  rotation = 0,
): void {
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * Math.PI * 2) / sides;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

/** 四瓣花形（共生类）：半径按 cos(4θ) 起伏 */
function petalPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const steps = 56;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r * (0.72 + 0.28 * Math.cos(4 * t));
    const px = x + Math.cos(t) * rr;
    const py = y + Math.sin(t) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, points: number): void {
  const inner = r * 0.46;
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? r : inner;
    const a = (i * Math.PI) / points - Math.PI / 2;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

function pathShape(ctx: CanvasRenderingContext2D, shape: NodeShape, x: number, y: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case 'hexagon':
      polygon(ctx, x, y, r, 6, Math.PI / 6);
      break;
    case 'triangle':
      polygon(ctx, x, y, r * 1.12, 3, -Math.PI / 2);
      break;
    case 'square':
      polygon(ctx, x, y, r * 0.92, 4, -Math.PI / 4);
      break;
    case 'diamond':
      polygon(ctx, x, y, r * 1.1, 4, -Math.PI / 2);
      break;
    case 'petal':
      petalPath(ctx, x, y, r);
      break;
    case 'star':
      starPath(ctx, x, y, r * 1.12, 5);
      break;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
  }
  ctx.closePath();
}
