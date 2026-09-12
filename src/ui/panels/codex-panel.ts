/**
 * 合成表面板（需求 2）：按 Tier 顺序列出每种资源「谁产出它 / 谁消耗它 / 和谁能产生催化加成」。
 *
 * 设计取舍：
 *   · 用"展开式列表"而不是关系图 —— 图好看但信息密度低，而玩家真正要查的是
 *     "这个东西我还能拿它做什么"；
 *   · 显示催化互动而不只是配方 —— "连法不同产出差几倍"是本作核心，
 *     一张只列配方的表会把这一点藏起来；
 *   · 隐藏资源不出现在表里（保持发现感）。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import { buildCodex, summarizeEntry, type CodexEntry } from '../../core/progression/codex.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { showModal } from './modal.ts';

const TIER_NAMES: Record<number, string> = {
  0: 'T0 基质',
  1: 'T1 代谢',
  2: 'T2 共生',
  3: 'T3 特殊',
  4: 'T4 世代',
  5: 'T5 法则',
};

export class CodexPanel {
  private data: GameData;
  private getState: () => GameState;
  private query = '';
  private onlyUnlocked = false;
  private expanded = new Set<string>();

  constructor(data: GameData, getState: () => GameState) {
    this.data = data;
    this.getState = getState;
  }

  open(): void {
    const entries = buildCodex(this.data);
    const state = this.getState();

    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });

    const render = (): void => {
      listEl.replaceChildren(...this.renderList(entries, state));
    };

    const search = h('input', {
      type: 'text',
      placeholder: '搜索资源名…',
      value: this.query,
      style: {
        flex: '1',
        background: THEME.panelAlt,
        color: THEME.text,
        border: `1px solid ${THEME.border}`,
        borderRadius: '5px',
        padding: '5px 8px',
        fontSize: '12px',
      },
    }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      render();
    });

    const onlyToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
    onlyToggle.checked = this.onlyUnlocked;
    onlyToggle.addEventListener('change', () => {
      this.onlyUnlocked = onlyToggle.checked;
      render();
    });

    render();

    const header = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
      search,
      h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: THEME.textDim, cursor: 'pointer', whiteSpace: 'nowrap' } },
        onlyToggle,
        '只看已解锁',
      ),
    );

    showModal(
      '合成表',
      h(
        'div',
        { style: { minWidth: '640px', maxWidth: '760px' } },
        h('div', {
          style: { fontSize: '12px', color: THEME.textDim, marginBottom: '8px' },
          text: '每行展开可见：谁产出它、谁消耗它、以及它能带来哪些催化加成。催化是本作的核心——同样的节点，连法不同产出能差几倍。',
        }),
        header,
        listEl,
      ),
      [{ label: '关闭', primary: true }],
    );
  }

  private renderList(entries: CodexEntry[], state: GameState): HTMLElement[] {
    const out: HTMLElement[] = [];
    const q = this.query.toLowerCase();
    let lastTier = -1;

    for (const entry of entries) {
      const unlocked =
        (state.totalProduced[entry.resourceId]?.isPositive() ?? false) ||
        (state.resources[entry.resourceId]?.isPositive() ?? false);
      if (this.onlyUnlocked && !unlocked) continue;
      if (q && !entry.name.toLowerCase().includes(q) && !entry.resourceId.includes(q)) continue;

      if (entry.tier !== lastTier) {
        lastTier = entry.tier;
        out.push(
          h('div', {
            style: {
              marginTop: out.length === 0 ? '0' : '10px',
              marginBottom: '2px',
              fontSize: '11px',
              letterSpacing: '0.1em',
              color: THEME.textFaint,
            },
            text: TIER_NAMES[entry.tier] ?? `T${entry.tier}`,
          }),
        );
      }

      const open = this.expanded.has(entry.resourceId);
      const row = h(
        'div',
        {
          style: {
            border: `1px solid ${THEME.border}`,
            borderRadius: '6px',
            background: THEME.panelAlt,
            overflow: 'hidden',
          },
        },
        h(
          'button',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              color: THEME.text,
              fontSize: '13px',
            },
            onclick: () => {
              if (open) this.expanded.delete(entry.resourceId);
              else this.expanded.add(entry.resourceId);
              // 重新打开面板以刷新（简单可靠，避免维护增量更新）
              this.open();
            },
          },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: entry.color,
              flex: '0 0 8px',
              opacity: unlocked ? '1' : '0.4',
            },
          }),
          h('span', { style: { minWidth: '80px' }, text: entry.name }),
          h('span', {
            style: { fontSize: '11px', color: unlocked ? THEME.textDim : THEME.textFaint, flex: '1' },
            text: unlocked ? summarizeEntry(entry) : '尚未接触（先在生产中遇到它）',
          }),
          h('span', { style: { fontSize: '11px', color: THEME.textFaint }, text: open ? '▲' : '▼' }),
        ),
        open ? this.renderDetail(entry) : h('span', { style: { display: 'none' } }),
      );
      out.push(row);
    }

    if (out.length === 0) {
      out.push(h('div', { style: { fontSize: '12px', color: THEME.textFaint, padding: '10px 0' }, text: '没有匹配的资源。' }));
    }
    return out;
  }

  private renderDetail(entry: CodexEntry): HTMLElement {
    const nameOf = (id: string): string => this.data.resources.get(id)?.def.name ?? id;
    const block = (title: string, rows: HTMLElement[]): HTMLElement =>
      h(
        'div',
        { style: { padding: '6px 10px 8px 26px' } },
        h('div', { style: { fontSize: '10px', letterSpacing: '0.1em', color: THEME.textFaint, marginBottom: '3px' }, text: title }),
        ...(rows.length > 0 ? rows : [h('div', { style: { fontSize: '11px', color: THEME.textFaint }, text: '—' })]),
      );

    const line = (left: string, right: string, tone: 'normal' | 'good' | 'bad' | 'dim' = 'normal', note?: string): HTMLElement =>
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '12px' } },
        h('span', { style: { color: THEME.textDim, minWidth: '180px' }, text: left }),
        h('span', {
          style: {
            color: tone === 'good' ? THEME.accent : tone === 'bad' ? THEME.danger : tone === 'dim' ? THEME.textDim : THEME.text,
            fontVariantNumeric: 'tabular-nums',
          },
          text: right,
        }),
        note ? h('span', { style: { fontSize: '11px', color: THEME.textFaint }, text: note }) : null,
      );

    return h(
      'div',
      { style: { borderTop: `1px solid ${THEME.border}`, background: 'rgba(0,0,0,0.18)' } },
      block(
        '谁产出它',
        entry.producers.map((p) =>
          line(
            p.nodeName,
            `${SciNum.format(p.rate)}/s`,
            'good',
            `层：${this.data.layers.get(p.layer)?.name ?? p.layer}`,
          ),
        ),
      ),
      block(
        '谁消耗它（作为配方输入）',
        entry.consumers.map((c) => line(c.nodeName, `${SciNum.format(c.rate)}/s`, 'dim', `节点类：${c.nodeClass}`)),
      ),
      block(
        '产出它的节点作为上游 → 能给谁加成',
        entry.provides.map((p) =>
          line(
            `${p.tag} → ${p.targetClass === '*' ? '所有类' : p.targetClass}`,
            `×${p.rateMul.toFixed(2)}`,
            p.rateMul >= 1 ? 'good' : 'bad',
            p.note,
          ),
        ),
      ),
      block(
        '消耗它的节点作为下游 ← 会被谁加成',
        entry.receives.map((r) =>
          line(
            `${r.tag} → ${r.targetClass}`,
            `×${r.rateMul.toFixed(2)}`,
            r.rateMul >= 1 ? 'good' : 'bad',
            r.note,
          ),
        ),
      ),
      block(
        '说明',
        [line('资源 id', entry.resourceId, 'dim'), line('层级', TIER_NAMES[entry.tier] ?? `T${entry.tier}`, 'dim')],
      ),
    );
  }
}
