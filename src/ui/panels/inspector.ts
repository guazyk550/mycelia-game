/**
 * 右侧检查器：回答「我为什么变强 / 我下一步该做什么」。
 *   上：选中节点的详情（配方、催化倍率、运行状态、土壤）
 *   下：可购买升级（按类别分组，标出性价比与是否买得起）
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import {
  buyTech,
  buyUpgrade,
  nodeCatalyst,
  upgradeCost,
  type ModifierSet,
} from '../../core/economy/engine.ts';
import { h, pulse, setText } from '../dom.ts';
import { CLASS_COLORS, THEME } from '../theme.ts';

const CAT_NAMES: Record<string, string> = {
  node: '节点强化',
  global: '全局',
  mechanic: '机制',
  hidden: '隐藏',
};

export class Inspector {
  readonly el: HTMLElement;
  private detail: HTMLElement;
  private upgradeList: HTMLElement;
  private upgradeRows = new Map<string, { root: HTMLElement; bar: HTMLElement; nameEl: HTMLElement; costEl: HTMLElement; levelEl: HTMLElement }>();
  private tab: 'upgrade' | 'tech' = 'upgrade';
  private onlyAffordable = false;
  private techBranch: string | null = null;
  private controlsEl!: HTMLElement;
  onNotice: (msg: string) => void = () => {};
  /** 购买/解锁成功后的回调（用于资源条跳动等反馈） */
  onPurchase: () => void = () => {};
  private data: GameData;
  private getState: () => GameState;
  private getMods: () => ModifierSet;

  constructor(
    data: GameData,
    getState: () => GameState,
    getMods: () => ModifierSet,
  ) {
    this.data = data;
    this.getState = getState;
    this.getMods = getMods;
    this.detail = h('div', { style: { fontSize: '12px', color: THEME.textDim, lineHeight: '1.6' } });
    this.upgradeList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });

    const tabBtn = (id: 'upgrade' | 'tech', label: string): HTMLElement =>
      h('button', {
        text: label,
        style: {
          flex: '1',
          padding: '4px 0',
          fontSize: '12px',
          background: this.tab === id ? THEME.panelAlt : 'transparent',
          border: `1px solid ${this.tab === id ? THEME.borderHover : 'transparent'}`,
          borderRadius: '4px',
          cursor: 'pointer',
        },
        onclick: () => {
          this.tab = id;
          this.renderTabs();
        },
      });

    this.tabsEl = h('div', { style: { display: 'flex', gap: '4px', marginBottom: '6px' } }, tabBtn('upgrade', '升级'), tabBtn('tech', '科技'));
    this.controlsEl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' } });

    this.el = h(
      'aside',
      {
        style: {
          width: `${THEME.rightWidth}px`,
          background: THEME.panel,
          borderLeft: `1px solid ${THEME.border}`,
          overflowY: 'auto',
          padding: '10px 12px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        },
      },
      h('section', {}, h('div', { style: { fontSize: '13px', marginBottom: '6px' }, text: '选中' }), this.detail),
      h(
        'section',
        { style: { flex: '1' } },
        h('div', { style: { fontSize: '13px', marginBottom: '6px' }, text: '强化' }),
        this.tabsEl,
        this.controlsEl,
        this.upgradeList,
      ),
    );
  }

  private tabsEl!: HTMLElement;

  private renderTabs(): void {
    const kids = Array.from(this.tabsEl.children) as HTMLElement[];
    const labels = ['升级', '科技'];
    kids.forEach((el, i) => {
      const active = (i === 0 && this.tab === 'upgrade') || (i === 1 && this.tab === 'tech');
      el.style.background = active ? THEME.panelAlt : 'transparent';
      el.style.borderColor = active ? THEME.borderHover : 'transparent';
      el.textContent = labels[i] ?? '';
    });
    this.rebuildList();
  }

  /** 控制条：只看买得起 / 科技分支筛选（反馈 #7：列表太长、找不到该买什么） */
  private renderControls(): void {
    this.controlsEl.innerHTML = '';
    if (this.tab === 'upgrade') {
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = this.onlyAffordable;
      box.addEventListener('change', () => {
        this.onlyAffordable = box.checked;
      });
      this.controlsEl.append(
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: THEME.textDim, cursor: 'pointer' } }, box, '只看买得起'),
      );
    } else {
      const branches = [...new Set([...this.data.techs.values()].map((t) => t.def.branch))];
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1;background:#161a21;color:#d8dee9;border:1px solid #232a35;border-radius:4px;padding:3px 6px;font-size:11px';
      for (const [v, label] of [['', '全部分支'], ...branches.map((b) => [b, b] as [string, string])] as [string, string][]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        sel.append(o);
      }
      sel.value = this.techBranch ?? '';
      sel.addEventListener('change', () => {
        this.techBranch = sel.value || null;
        this.rebuildList();
      });
      this.controlsEl.append(sel);
    }
  }

  private rebuildList(): void {
    this.renderControls();
    this.upgradeList.innerHTML = '';
    this.upgradeRows.clear();

    if (this.tab === 'upgrade') {
      const cats = ['mechanic', 'global', 'node', 'hidden'];
      for (const cat of cats) {
        const items = [...this.data.upgrades.values()].filter((u) => u.def.cat === cat);
        if (items.length === 0) continue;
        this.upgradeList.append(
          h('div', {
            style: { fontSize: '11px', color: THEME.textFaint, margin: '8px 0 2px' },
            text: CAT_NAMES[cat] ?? cat,
          }),
        );
        for (const u of items) {
          // 反馈 #2：升级名/成本字号与对比度上调，且可负担项用左侧色条 + 背景提亮区分
          const bar = h('span', {
            style: {
              position: 'absolute',
              left: '0',
              top: '0',
              bottom: '0',
              width: '3px',
              borderRadius: '4px 0 0 4px',
              background: 'transparent',
            },
          });
          const nameEl = h('span', { style: { fontSize: '14px', color: THEME.text, fontWeight: '500' }, text: u.def.name });
          const costEl = h('span', { style: { fontSize: '12px', color: THEME.textDim } });
          const levelEl = h('span', { style: { fontSize: '11px', color: THEME.textDim } });
          const root = h(
            'button',
            {
              'data-upgrade-id': u.def.id,
              style: {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '2px',
                width: '100%',
                textAlign: 'left',
                padding: '6px 9px 6px 12px',
                border: `1px solid ${THEME.border}`,
                borderRadius: '5px',
                background: THEME.panelAlt,
                cursor: 'pointer',
              },
              title: u.def.desc,
              onclick: () => {
                const state = this.getState();
                const r = buyUpgrade(state, this.data, u.def.id, this.getMods());
                pulse(root, r.ok);
                if (r.ok) {
                  this.onNotice(`已购买：${u.def.name}`);
                  this.onPurchase();
                } else {
                  const why: Record<string, string> = { cost: '资源不足', maxed: '已满级' };
                  this.onNotice(`购买失败：${why[r.reason ?? ''] ?? r.reason}`);
                }
              },
            },
            bar,
            nameEl,
            costEl,
            levelEl,
          );
          this.upgradeList.append(root);
          this.upgradeRows.set(u.def.id, { root, bar, nameEl, costEl, levelEl });
        }
      }
    } else {
      const branches = new Map<string, typeof this.data.techs extends Map<string, infer V> ? V[] : never[]>();
      for (const t of this.data.techs.values()) {
        if (!branches.has(t.def.branch)) branches.set(t.def.branch, []);
        branches.get(t.def.branch)!.push(t);
      }
      for (const [branch, list] of branches) {
        if (this.techBranch && branch !== this.techBranch) continue;
        this.upgradeList.append(
          h('div', { style: { fontSize: '11px', color: THEME.textFaint, margin: '8px 0 2px' }, text: branch }),
        );
        for (const t of list) {
          const bar = h('span', {
            style: {
              position: 'absolute',
              left: '0',
              top: '0',
              bottom: '0',
              width: '3px',
              borderRadius: '4px 0 0 4px',
              background: 'transparent',
            },
          });
          const nameEl = h('span', { style: { fontSize: '14px', color: THEME.text, fontWeight: '500' }, text: t.def.name });
          const costEl = h('span', { style: { fontSize: '12px', color: THEME.textDim } });
          const levelEl = h('span', { style: { fontSize: '11px', color: THEME.textDim } });
          const root = h(
            'button',
            {
              'data-tech-id': t.def.id,
              style: {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '2px',
                width: '100%',
                textAlign: 'left',
                padding: '6px 9px 6px 12px',
                border: `1px solid ${THEME.border}`,
                borderRadius: '5px',
                background: THEME.panelAlt,
                cursor: 'pointer',
              },
              title: t.def.desc,
              onclick: () => {
                const state = this.getState();
                const owned = state.techs[t.def.id] === true;
                if (owned) {
                  pulse(root, false);
                  this.onNotice('已拥有该科技');
                  return;
                }
                const prereqOk = t.def.requires.every((r) => state.techs[r]);
                if (!prereqOk) {
                  pulse(root, false);
                  this.onNotice('前置科技未完成');
                  return;
                }
                const r = buyTech(state, this.data, t.def.id, this.getMods());
                pulse(root, r.ok);
                if (r.ok) {
                  this.onNotice(`已解锁：${t.def.name}`);
                  this.onPurchase();
                } else {
                  this.onNotice(`解锁失败：${r.reason === 'cost' ? '资源不足' : r.reason}`);
                }
              },
            },
            nameEl,
            costEl,
            levelEl,
          );
          this.upgradeList.append(root);
          this.upgradeRows.set(t.def.id, { root, bar, nameEl, costEl, levelEl });
        }
      }
    }
  }

  update(selectedNodeId: string | null): void {
    const state = this.getState();
    const mods = this.getMods();

    // ---- 选中详情
    this.detail.innerHTML = '';
    const node = selectedNodeId ? state.graph.nodes.get(selectedNodeId) : null;
    if (!node) {
      this.detail.append(
        h('div', { style: { color: THEME.textFaint }, text: '点击画布中的节点查看详情；从节点拖拽到另一个节点即可连线。' }),
      );
    } else {
      const def = this.data.nodes.get(node.typeId)!;
      const layer = this.data.layers.get(node.layerId);
      const cat = nodeCatalyst(state, this.data, node.id);
      const rows: [string, string][] = [
        ['类型', `${def.def.name}（${def.def.class} / ${def.def.catalystTag}）`],
        ['所在层', `${layer?.name ?? node.layerId}｜深度倍率 ×${layer?.depthMul ?? '1'}`],
        ['配方', formatRecipe(this.data, def)],
        [
          '催化',
          cat.bestRule
            ? `×${cat.rateMul.toFixed(3)}（${cat.bestRule.upstreamTag} → ${cat.bestRule.downstreamClass}）`
            : `无入边（×${(1 + mods.catalystBonus).toFixed(2)}）`,
        ],
        ['土壤', `${node.richness.toFixed(1)} / ${layer?.richnessBase ?? 100}`],
        ['状态', node.built ? '运行中' : '建造中'],
      ];
      for (const [k, v] of rows) {
        this.detail.append(
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h('span', { style: { color: THEME.textFaint, minWidth: '52px' }, text: k }),
            h('span', { style: { color: THEME.text }, text: v }),
          ),
        );
      }
      if (cat.bestRule) {
        this.detail.append(
          h('div', { style: { color: THEME.textFaint, fontSize: '11px', marginTop: '4px' }, text: cat.bestRule.note }),
        );
      }
      this.detail.append(
        h('div', {
          style: { color: THEME.textDim, fontSize: '11px', marginTop: '6px' },
          text: def.def.desc,
        }),
      );
    }

    // ---- 升级 / 科技列表状态：可负担项高亮，买不起项**不隐藏**而是灰显并显示缺口
    for (const [id, row] of this.upgradeRows) {
      const up = this.data.upgrades.get(id);
      const tech = this.data.techs.get(id);
      if (up) {
        const level = state.upgrades[id] ?? 0;
        const max = up.def.maxLevel;
        const cost = upgradeCost(state, this.data, id, mods);
        if (level >= max || !cost) {
          row.root.style.display = 'none';
          continue;
        }
        row.root.style.display = '';
        const afford = canAffordable(state, cost);
        // 反馈 #7：只看买得起（默认关闭 —— 买不起的项显示缺口比直接消失更有用）
        if (this.onlyAffordable && !afford) {
          row.root.style.display = 'none';
          continue;
        }
        setText(row.costEl, cost.map((c) => `${nameOf(this.data, c.res)} ${SciNum.format(c.amount)}`).join('  '));
        setText(
          row.levelEl,
          afford ? `Lv ${level}/${max} · 可购买` : `Lv ${level}/${max} · 缺 ${(worstGap(state, cost) * 100).toFixed(0)}%`,
        );
        row.root.style.opacity = afford ? '1' : '0.55';
        row.root.style.background = afford ? '#152019' : THEME.panelAlt;
        row.root.style.borderColor = afford ? '#2c4a38' : THEME.border;
        row.bar.style.background = afford ? THEME.accent : 'transparent';
        row.nameEl.style.color = afford ? '#e8f5ec' : THEME.text;
      } else if (tech) {
        const owned = state.techs[id] === true;
        const prereqOk = tech.def.requires.every((r) => state.techs[r]);
        const cost = tech.cost.map((c) => ({ res: c.res, amount: c.amount }));
        const afford = canAffordable(state, cost) && prereqOk;
        row.root.style.display = owned ? 'none' : '';
        setText(row.costEl, tech.cost.map((c) => `${nameOf(this.data, c.res)} ${SciNum.format(c.amount)}`).join('  '));
        setText(
          row.levelEl,
          !prereqOk ? '前置科技未完成' : afford ? '可解锁' : `缺 ${(worstGap(state, cost) * 100).toFixed(0)}%`,
        );
        row.root.style.opacity = afford ? '1' : '0.55';
        row.root.style.background = afford ? '#152019' : THEME.panelAlt;
        row.root.style.borderColor = afford ? '#2c4a38' : THEME.border;
        row.bar.style.background = afford ? THEME.accent : 'transparent';
      }
    }
  }
}

/** 最紧的一项资源缺口（0 = 全部够，1 = 完全没有） */
function worstGap(state: GameState, cost: { res: string; amount: SciNum }[]): number {
  let worst = 0;
  for (const c of cost) {
    if (SciNum.gte(state.resources[c.res] ?? SciNum.ZERO, c.amount)) continue;
    const need = c.amount.toNumber();
    if (need <= 0) continue;
    const got = (state.resources[c.res] ?? SciNum.ZERO).toNumber();
    worst = Math.max(worst, Math.min(1, 1 - got / need));
  }
  return worst;
}

function nameOf(data: GameData, resId: string): string {
  return data.resources.get(resId)?.def.name ?? resId;
}

function formatRecipe(
  data: GameData,
  def: { recipe: { inputs: { res: string; rate: SciNum }[]; outputs: { res: string; rate: SciNum }[]; enzymePerSec: SciNum } },
): string {
  const ins = def.recipe.inputs.map((i) => `${nameOf(data, i.res)} ${i.rate.toString()}`).join(' + ') || '∅';
  const outs = def.recipe.outputs.map((o) => `${nameOf(data, o.res)} ${o.rate.toString()}`).join(' + ') || '∅';
  const enzyme = def.recipe.enzymePerSec.isZero() ? '' : ` ｜酶 ${def.recipe.enzymePerSec.toString()}/s`;
  return `${ins} → ${outs}${enzyme}`;
}

function canAffordable(state: GameState, cost: { res: string; amount: SciNum }[]): boolean {
  for (const c of cost) if (SciNum.lt(state.resources[c.res] ?? SciNum.ZERO, c.amount)) return false;
  return true;
}

export { CLASS_COLORS };
