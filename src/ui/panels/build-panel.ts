/**
 * 左侧建造面板：列出当前可建造的节点，标出成本、缺料与锁定原因。
 * 对应 GDD §21 的第三个问题：「我现在能做什么？」
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData, ParsedNode } from '../../core/types.ts';
import { buildNode, canAfford, isNodeUnlocked, nodeCost, type ModifierSet } from '../../core/economy/engine.ts';
import { clear, h, setText } from '../dom.ts';
import { CLASS_COLORS, THEME, nodeColor } from '../theme.ts';
import { TooltipCard, type TooltipRow } from './tooltip-card.ts';

const CLASS_NAMES: Record<string, string> = {
  extractor: '采集',
  metabolizer: '代谢',
  sporifier: '繁殖',
  symbiont: '共生',
  transmitter: '信号',
  special: '特殊',
  meta: '法则',
};

interface Row {
  root: HTMLElement;
  costEl: HTMLElement;
  noteEl: HTMLElement;
}

export class BuildPanel {
  readonly el: HTMLElement;
  private rows = new Map<string, Row>();
  private selected: string | null = null;
  onSelect: (typeId: string | null) => void = () => {};
  private data: GameData;
  /** 建造项的悬停详情（需求 1）：所需材料 + 产出 + 解锁条件 */
  private tooltip = new TooltipCard();
  /**
   * 当前要把节点建到哪一层。
   *
   * 这是一个重要修复：早期版本写死了 `node.def.layer`，于是"把节点建到更深的层"
   * ——游戏里收益最大的决策（地幔层 ×400 是表土层的两个数量级）——**在 UI 上根本不存在**，
   * 玩家只能把它建在该节点"自己的层"，然后奇怪为什么放对了位置也没感觉。
   */
  targetLayerFor(state: GameState, typeId: string): string {
    const chosen = this.selectedLayer;
    if (chosen && state.unlockedLayers.includes(chosen)) {
      // 玩家手动选过就用它（但满了要挡住，避免"点了没反应"）
      const layer = this.data.layers.get(chosen);
      if (layer && state.graph.countByLayer(chosen) < layer.nodeCap) return chosen;
      return chosen; // 交给 buildNode 报 layer-cap，UI 会显示原因
    }

    // 未手动选择时：优先用节点自己的层；**该层满了就自动挪到倍率最高的可用层**。
    // 否则玩家会遇到"点了建造却没反应"，而原因（层容量满）藏在很深的提示里。
    const def = this.data.nodes.get(typeId)!.def.layer;
    const defLayer = this.data.layers.get(def);
    if (defLayer && state.unlockedLayers.includes(def) && state.graph.countByLayer(def) < defLayer.nodeCap) {
      return def;
    }
    const candidates = this.selectableLayers(state).filter((l) => !l.full);
    if (candidates.length === 0) return def;
    return candidates.reduce((best, l) => (l.mul > best.mul ? l : best)).id;
  }

  /** 已解锁、且有剩余容量的层（供层选择器与"最佳层"提示使用） */
  selectableLayers(state: GameState): { id: string; name: string; mul: number; used: number; cap: number; full: boolean; isDefault: boolean }[] {
    const out: { id: string; name: string; mul: number; used: number; cap: number; full: boolean; isDefault: boolean }[] = [];
    for (const layer of this.data.layerOrder) {
      if (!state.unlockedLayers.includes(layer.id)) continue;
      const used = state.graph.countByLayer(layer.id);
      out.push({
        id: layer.id,
        name: layer.name,
        mul: Number(layer.depthMul) || 1,
        used,
        cap: layer.nodeCap,
        full: used >= layer.nodeCap,
        isDefault: false,
      });
    }
    return out;
  }

  /** 设置目标层（建造时会用到），返回是否需要重绘 */
  setLayer(layerId: string | null): void {
    this.selectedLayer = layerId;
  }

  get layer(): string | null {
    return this.selectedLayer;
  }

  private lastState: GameState | null = null;
  private selectedLayer: string | null = null;
  private layerBar: HTMLElement;
  /** 层变化回调（由 app 注入，用于刷新落点预览） */
  onLayerChange: () => void = () => {};
  private renderLayerBar: (state: GameState) => void;
  private lastMods: ModifierSet | null = null;

  constructor(data: GameData) {
    this.data = data;
    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });

    // 层选择条：把"建到哪一层"变成可见的决策。
    // 层倍率是最重要的收益杠杆（表土层 ×1 → 深菌地幔 ×400），但早期版本把它锁死在
    // 节点自己的层上，玩家根本没有机会做出这个选择。
    let onLayerPick: (id: string | null) => void = () => {};
    this.layerBar = h('div', {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        margin: '6px 0 8px',
        padding: '6px',
        border: `1px solid ${THEME.border}`,
        borderRadius: '8px',
        background: 'rgba(255,255,255,0.02)',
      },
    });
    /** 由外部（app）注入"层变了要重绘"的回调 */
    this.onLayerChange = (): void => onLayerPick(this.selectedLayer);
    void onLayerPick;
    this.renderLayerBar = (state: GameState): void => {
      const layers = this.selectableLayers(state);
      if (layers.length <= 1) {
        clear(this.layerBar);
        return;
      }
      clear(this.layerBar);
      this.layerBar.append(
        h('div', {
          style: { width: '100%', fontSize: '11px', color: THEME.textDim, marginBottom: '2px' },
          text: '建造到哪一层？（越深产出越高）',
        }),
      );
      const best = Math.max(...layers.map((l) => l.mul));
      for (const l of layers) {
        const active = this.selectedLayer === l.id;
        const isBest = l.mul === best;
        const color = active ? THEME.accent : l.full ? THEME.danger : l.mul > 1 ? '#fbbf24' : THEME.textDim;
        this.layerBar.append(
          h('button', {
            text: `${l.name} ×${l.mul}${l.full ? ' 满' : ''}`,
            title: `${l.name}：产出倍率 ×${l.mul}，节点 ${l.used}/${l.cap}${isBest ? '（当前最佳）' : ''}`,
            style: {
              padding: '3px 7px',
              fontSize: '11px',
              borderRadius: '6px',
              border: `1px solid ${active ? THEME.accent : THEME.border}`,
              background: active ? 'rgba(74,222,128,0.14)' : 'transparent',
              color,
              cursor: 'pointer',
              opacity: l.full ? '0.5' : '1',
            },
            onclick: () => {
              if (l.full) return;
              this.selectedLayer = this.selectedLayer === l.id ? null : l.id;
              this.onLayerChange();
            },
          }),
        );
      }
    };

    const groups = new Map<string, ParsedNode[]>();
    for (const node of data.nodes.values()) {
      const key = node.def.class;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }

    for (const [cls, nodes] of groups) {
      const header = h('div', {
        style: {
          fontSize: '11px',
          letterSpacing: '0.08em',
          color: CLASS_COLORS[cls] ?? THEME.textDim,
          margin: '10px 0 3px',
          textTransform: 'uppercase',
        },
        text: `${CLASS_NAMES[cls] ?? cls}`,
      });
      list.append(header);
      nodes.sort((a, b) => a.def.tier - b.def.tier || a.def.id.localeCompare(b.def.id));
      for (const node of nodes) {
        const costEl = h('span', { style: { fontSize: '11px', color: THEME.textDim } });
        const noteEl = h('span', { style: { fontSize: '10px', color: THEME.textFaint } });
        const root = h(
          'button',
          {
            'data-node-type': node.def.id,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              alignItems: 'flex-start',
              textAlign: 'left',
              width: '100%',
              padding: '5px 8px',
              border: `1px solid ${THEME.border}`,
              borderRadius: '5px',
              background: THEME.panelAlt,
              cursor: 'pointer',
              transition: 'border-color 120ms',
            },
            title: node.def.desc,
            // 悬停/聚焦时显示完整详情（需求 1）：原来只有浏览器原生 title 的一句描述
            onmouseenter: (e: MouseEvent) => this.showBuildTooltip(node.def.id, e.clientX, e.clientY),
            onmousemove: (e: MouseEvent) => this.showBuildTooltip(node.def.id, e.clientX, e.clientY),
            onmouseleave: () => this.tooltip.hide(),
            onfocus: () => {
              const r = root.getBoundingClientRect();
              this.showBuildTooltip(node.def.id, r.right - 8, r.top + r.height / 2);
            },
            onblur: () => this.tooltip.hide(),
            onclick: () => {
              this.selected = this.selected === node.def.id ? null : node.def.id;
              this.onSelect(this.selected);
              this.refreshSelection();
            },
          },
          h('span', { style: { fontSize: '14px', fontWeight: '500', color: THEME.text }, text: node.def.name }),
          costEl,
          noteEl,
        );
        list.append(root);
        this.rows.set(node.def.id, { root, costEl, noteEl });
      }
    }

    this.el = h(
      'aside',
      {
        style: {
          width: `${THEME.sideWidth}px`,
          background: THEME.panel,
          borderRight: `1px solid ${THEME.border}`,
          overflowY: 'auto',
          padding: '10px 12px 24px',
        },
      },
      h('div', { style: { fontSize: '13px', color: THEME.text, marginBottom: '2px' }, text: '建造' }),
      this.layerBar,
      h('div', {
        style: { fontSize: '11px', color: THEME.textFaint, marginBottom: '4px' },
        text: '选中后在画布上点击放置（右键取消）',
      }),
      list,
    );
    // 悬停层用 position: fixed，挂在 body 上（不受面板 overflow 裁剪）
    document.body.append(this.tooltip.el);
  }

  get selectedType(): string | null {
    return this.selected;
  }

  /**
   * 建造项悬停详情（需求 1）：所需材料（持有/需要 + 缺口）、每秒产出与消耗、
   * 层倍率换算后的预期产出、解锁条件与已建数量。
   */
  private showBuildTooltip(typeId: string, clientX: number, clientY: number): void {
    const state = this.lastState;
    const mods = this.lastMods;
    if (!state || !mods) return;
    const parsed = this.data.nodes.get(typeId);
    if (!parsed) return;

    const nameOf = (id: string): string => this.data.resources.get(id)?.def.name ?? id;
    const colorOf = (id: string): string => this.data.resources.get(id)?.def.color ?? THEME.textDim;
    const fmt = (v: SciNum): string => SciNum.format(v);

    // 成本：逐项标注持有量，不够时给出缺口百分比
    const cost = nodeCost(state, this.data, typeId, mods);
    const costRows: TooltipRow[] = cost.map((c) => {
      const have = state.resources[c.res] ?? SciNum.ZERO;
      const enough = SciNum.gte(have, c.amount);
      const need = c.amount.toNumber();
      const got = have.toNumber();
      const gap = !enough && need > 0 ? Math.min(1, 1 - got / need) : 0;
      return {
        label: nameOf(c.res),
        value: `${fmt(have)} / ${fmt(c.amount)}`,
        dot: colorOf(c.res),
        tone: enough ? 'good' : 'bad',
        ...(enough ? {} : { note: `还差 ${(gap * 100).toFixed(0)}%` }),
      };
    });

    const layer = this.data.layers.get(parsed.def.layer);
    const depthMul = Number(layer?.depthMul ?? '1') || 1;

    // 产出：给出层倍率换算后的预期（这张图最有价值的信息之一）
    const outRows: TooltipRow[] = parsed.recipe.outputs.map((o) => {
      const expected = SciNum.mul(o.rate, depthMul);
      return {
        label: nameOf(o.res),
        value: depthMul === 1 ? `${fmt(o.rate)}/s` : `${fmt(o.rate)}/s ×${layer?.depthMul} = ${fmt(expected)}/s`,
        dot: colorOf(o.res),
        tone: 'good',
      };
    });

    const inRows: TooltipRow[] = parsed.recipe.inputs.map((i) => ({
      label: nameOf(i.res),
      value: `${fmt(i.rate)}/s`,
      dot: colorOf(i.res),
      tone: 'dim',
    }));
    if (!parsed.recipe.enzymePerSec.isZero()) {
      inRows.push({ label: '酶（催化开销）', value: `${fmt(parsed.recipe.enzymePerSec)}/s`, dot: colorOf('enzyme'), tone: 'dim' });
    }

    // 解锁条件（未解锁时才有信息量）
    const unlockText = ((): string => {
      const u = parsed.def.unlock;
      switch (u.type) {
        case 'start':
          return '开局即可建造';
        case 'resource':
          return `需曾产出 ${nameOf(u.resource ?? '')} ${u.amount ?? ''}`;
        case 'layer':
          return `需解锁 ${this.data.layers.get(u.layer ?? '')?.name ?? u.layer}`;
        case 'tech':
          return `需科技 ${this.data.techs.get(u.id ?? '')?.def.name ?? u.id}`;
        case 'prestige':
          return `需达到第 ${u.level ?? 1} 层 Prestige`;
        default:
          return '—';
      }
    })();

    let built = 0;
    for (const n of state.graph.nodes.values()) if (n.typeId === typeId) built++;

    const sections: { heading?: string; rows: TooltipRow[] }[] = [];
    sections.push({ heading: '建造所需', rows: costRows });
    if (outRows.length > 0) sections.push({ heading: depthMul === 1 ? '每秒产出' : `每秒产出（本层 ×${layer?.depthMul}）`, rows: outRows });
    if (inRows.length > 0) sections.push({ heading: '每秒消耗', rows: inRows });
    sections.push({
      heading: '信息',
      rows: [
        { label: '解锁条件', value: '', tone: 'dim', note: unlockText },
        { label: '已建造', value: `${built} 个`, tone: 'dim' },
        { label: '放置层', value: layer?.name ?? parsed.def.layer, tone: 'dim' },
      ],
    });

    this.tooltip.show(clientX, clientY, {
      title: parsed.def.name,
      subtitle: `${parsed.def.class} · ${parsed.def.catalystTag}`,
      accent: nodeColor(typeId, parsed.def.class),
      sections,
    });
  }

  /** 供外部（如模态框关闭时）隐藏悬停层 */
  hideTooltip(): void {
    this.tooltip.hide();
  }

  clearSelection(): void {
    this.selected = null;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    for (const [id, row] of this.rows) {
      const active = id === this.selected;
      row.root.style.borderColor = active ? THEME.accent : THEME.border;
      row.root.style.background = active ? '#16211a' : THEME.panelAlt;
    }
  }

  update(state: GameState, mods: ModifierSet): void {
    // 悬停详情需要最新的状态与修饰符（成本随已建数量与折扣变化）
    this.lastState = state;
    this.lastMods = mods;
    this.renderLayerBar(state);
    const counts = new Map<string, number>();
    for (const node of state.graph.nodes.values()) counts.set(node.typeId, (counts.get(node.typeId) ?? 0) + 1);

    for (const [id, row] of this.rows) {
      const parsed = this.data.nodes.get(id);
      if (!parsed) continue;
      const layerOk = state.unlockedLayers.includes(parsed.def.layer);
      const unlocked = isNodeUnlocked(state, this.data, id);
      if (!layerOk || !unlocked) {
        row.root.style.display = 'none';
        continue;
      }
      row.root.style.display = '';
      const cost = nodeCost(state, this.data, id, mods);
      const affordable = canAfford(state, cost);
      const layer = this.data.layers.get(parsed.def.layer);
      const atCap = layer ? state.graph.countByLayer(parsed.def.layer) >= layer.nodeCap : false;

      setText(
        row.costEl,
        cost.map((c) => `${this.data.resources.get(c.res)?.def.name ?? c.res} ${SciNum.format(c.amount)}`).join('  '),
      );
      const n = counts.get(id) ?? 0;
      if (atCap) setText(row.noteEl, `该层已达节点上限 ${layer?.nodeCap}`);
      else if (!affordable) setText(row.noteEl, `已建 ${n}｜资源不足`);
      else setText(row.noteEl, `已建 ${n}｜可建造`);

      row.root.style.opacity = affordable && !atCap ? '1' : '0.55';
      row.root.style.borderColor =
        id === this.selected ? THEME.accent : affordable && !atCap ? THEME.borderHover : THEME.border;
    }
  }

  /** 在指定世界坐标尝试建造；失败时返回原因（供 UI 提示） */
  tryBuild(state: GameState, mods: ModifierSet, typeId: string, x: number, y: number): string | null {
    const r = buildNode(state, this.data, typeId, this.targetLayerFor(state, typeId), x, y, mods);
    if (r.ok) return null;
    const reasons: Record<string, string> = {
      'unknown-type': '未知节点',
      'layer-locked': '该基质层尚未解锁',
      locked: '尚未解锁',
      'layer-cap': '该层已达节点上限',
      occupied: '周围没有空位（先把节点拖开或删除）',
      cost: '资源不足',
    };
    return reasons[r.reason ?? ''] ?? '无法建造';
  }
}

export { clear };
