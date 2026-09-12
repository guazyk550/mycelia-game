/**
 * 顶部资源条 —— 回答玩家的前两个问题（GDD §21 信息优先级）：
 *   1. 我现在有多少资源？（最显眼）
 *   2. 我每秒获得多少？（带趋势与瓶颈标记）
 * 第三、四个问题（能做什么 / 下一步做什么）由左右面板与任务提示回答。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import { clear, h, setText, bump } from '../dom.ts';
import { THEME } from '../theme.ts';

interface Row {
  root: HTMLElement;
  amount: HTMLElement;
  rate: HTMLElement;
  dot: HTMLElement;
}

export class TopBar {
  readonly el: HTMLElement;
  private rows = new Map<string, Row>();
  private tracked: string[];
  private prestigeEl: HTMLElement;
  private data: GameData;

  constructor(data: GameData) {
    this.data = data;
    // 只显示"已经出现过"的资源，避免开局一屏 22 个 0
    this.tracked = data.raw.resources.resources.filter((r) => !r.hidden).map((r) => r.id);

    const strip = h('div', {
      style: {
        display: 'flex',
        gap: '14px',
        alignItems: 'center',
        overflowX: 'auto',
        padding: '0 14px',
        height: '100%',
      },
    });

    for (const id of this.tracked) {
      const def = data.resources.get(id);
      if (!def) continue;
      const amount = h('span', {
        style: { fontWeight: '600', fontSize: '15px', color: def.def.color, fontVariantNumeric: 'tabular-nums' },
        text: '0',
      });
      const rate = h('span', {
        style: { fontSize: '11px', color: THEME.textDim, fontVariantNumeric: 'tabular-nums' },
        text: '',
      });
      const dot = h('span', {
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: def.def.color,
          opacity: '0.35',
          display: 'inline-block',
        },
      });
      const root = h(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '72px', opacity: '0' },
          title: `${def.def.name}｜${def.def.desc}`,
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } }, dot, amount),
        rate,
      );
      strip.append(root);
      this.rows.set(id, { root, amount, rate, dot });
    }

    this.prestigeEl = h('div', {
      style: {
        marginLeft: 'auto',
        paddingLeft: '14px',
        borderLeft: `1px solid ${THEME.border}`,
        fontSize: '12px',
        color: THEME.textDim,
        whiteSpace: 'nowrap',
      },
      text: '',
    });

    this.el = h(
      'header',
      {
        style: {
          height: `${THEME.topbarHeight}px`,
          background: THEME.panel,
          borderBottom: `1px solid ${THEME.border}`,
          display: 'flex',
          alignItems: 'center',
        },
      },
      strip,
      this.prestigeEl,
    );
  }

  update(state: GameState): void {
    for (const [id, row] of this.rows) {
      const amount = state.resources[id] ?? SciNum.ZERO;
      const rate = state.ratePerSec[id] ?? 0;

      // 资源一旦出现就常驻显示（避免布局跳动），但未解锁的保持淡出
      const everProduced = amount.isPositive() || (state.totalProduced[id]?.isPositive() ?? false);
      const shown = everProduced || id === 'spore' || id === 'humus';
      row.root.style.opacity = shown ? '1' : '0';
      row.root.style.width = shown ? '' : '0px';
      if (!shown) continue;

      // 数值变化时轻微跳动（反馈 #2：让"资源在增长"看得见）
      const next = SciNum.format(amount);
      if (row.amount.textContent !== next && row.amount.textContent !== '0') bump(row.amount);
      setText(row.amount, next);

      if (rate > 0) {
        setText(row.rate, `+${SciNum.format(SciNum.from(rate))}/s`);
        row.rate.style.color = THEME.textDim;
      } else if (rate < 0) {
        setText(row.rate, `−${SciNum.format(SciNum.from(-rate))}/s`);
        row.rate.style.color = THEME.danger;
      } else {
        setText(row.rate, '—');
      }
      row.dot.style.opacity = rate > 0 ? '1' : '0.3';
    }

    const p = state.prestige;
    setText(
      this.prestigeEl,
      p.count > 0 || p.sporogene.isPositive()
        ? `世代 ${state.prestige.count}｜孢子基因 ${SciNum.format(p.sporogene)}`
        : `世代 0｜首次孢子化未达成`,
    );
  }

  /** 购买成功时让所有已显示的资源数字跳一下（反馈 #2 的购买反馈） */
  flashAll(): void {
    for (const row of this.rows.values()) {
      if (row.root.style.opacity !== '0') bump(row.amount);
    }
  }
}
