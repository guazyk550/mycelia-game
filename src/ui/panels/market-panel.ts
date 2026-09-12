/**
 * 菌市面板：价格、涨跌幅、囤货/抛售。
 *
 * 信息层级刻意做成"一眼看出该不该卖"：
 *   价格 vs 基准价（颜色）→ 净产出速率 → 手续费 → 一键卖出的实际入账。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import { buy, ensureMarket, priceDelta, sell } from '../../core/market/market.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { showModal } from './modal.ts';

const SELL_FRACTIONS: { label: string; frac: number }[] = [
  { label: '25%', frac: 0.25 },
  { label: '50%', frac: 0.5 },
  { label: '全部', frac: 1 },
];

export class MarketPanel {
  private data: GameData;
  private getState: () => GameState;
  private onNotice: (msg: string) => void;

  constructor(data: GameData, getState: () => GameState, onNotice: (msg: string) => void) {
    this.data = data;
    this.getState = getState;
    this.onNotice = onNotice;
  }

  open(): void {
    const state = this.getState();
    const market = ensureMarket(state, this.data);

    const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
    for (const [resId, entry] of Object.entries(market.entries)) {
      const def = this.data.resources.get(resId);
      if (!def) continue;
      const delta = priceDelta(entry);
      const color = delta > 0.02 ? THEME.accent : delta < -0.02 ? THEME.danger : THEME.textDim;
      const have = state.resources[resId] ?? SciNum.ZERO;
      const rate = state.ratePerSec[resId] ?? 0;

      const actions = h('div', { style: { display: 'flex', gap: '3px' } });
      for (const f of SELL_FRACTIONS) {
        actions.append(
          h('button', {
            text: `卖${f.label}`,
            style: btnStyle(),
            onclick: () => {
              const amount = SciNum.mul(have, f.frac);
              if (!SciNum.gt(amount, SciNum.ZERO)) {
                this.onNotice('没有可卖出的数量');
                return;
              }
              const r = sell(state, this.data, resId, amount);
              this.onNotice(r.ok ? `卖出 ${def.def.name} → 蜜露 +${SciNum.format(r.honeydew)}（手续费 ${(r.fee * 100).toFixed(1)}%）` : `卖出失败：${r.reason}`);
              if (r.ok) {
                this.open();
                return;
              }
            },
          }),
        );
      }
      actions.append(
        h('button', {
          text: '买 10%',
          style: btnStyle(),
          onclick: () => {
            const honey = state.resources.honeydew ?? SciNum.ZERO;
            const budget = SciNum.mul(honey, 0.1);
            const amount = SciNum.from(budget.toNumber() / Math.max(1e-9, entry.price));
            if (!SciNum.gt(amount, SciNum.ZERO)) {
              this.onNotice('蜜露不足');
              return;
            }
            const r = buy(state, this.data, resId, amount);
            this.onNotice(r.ok ? `买入 ${def.def.name} → 蜜露 −${SciNum.format(r.honeydew)}` : `买入失败：${r.reason}`);
            if (r.ok) {
              this.open();
              return;
            }
          },
        }),
      );

      rows.append(
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '96px 92px 70px 1fr auto',
              gap: '8px',
              alignItems: 'center',
              padding: '5px 8px',
              border: `1px solid ${THEME.border}`,
              borderRadius: '5px',
              background: THEME.panelAlt,
            },
          },
          h('span', { style: { fontSize: '12px', color: def.def.color }, text: def.def.name }),
          h('span', { style: { fontSize: '12px', fontVariantNumeric: 'tabular-nums' }, text: `${SciNum.format(SciNum.from(entry.price))} 蜜露` }),
          h('span', {
            style: { fontSize: '11px', color, fontVariantNumeric: 'tabular-nums' },
            text: `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`,
          }),
          h('span', {
            style: { fontSize: '11px', color: THEME.textFaint, fontVariantNumeric: 'tabular-nums' },
            text: `持有 ${SciNum.format(have)}${rate !== 0 ? `｜${rate > 0 ? '+' : ''}${SciNum.format(SciNum.from(rate))}/s` : ''}`,
          }),
          actions,
        ),
      );
    }

    showModal(
      '菌市',
      h(
        'div',
        { style: { minWidth: '620px', maxWidth: '720px' } },
        h('div', { style: { fontSize: '12px', color: THEME.textDim, marginBottom: '8px' } },
          `蜜露 ${SciNum.format(state.resources.honeydew ?? SciNum.ZERO)}｜累计成交 ${SciNum.format(market.volume)}｜` +
            '你卖得越多，价格越低 —— 囤货、加工、等待都是策略'),
        rows,
      ),
      [{ label: '关闭', primary: true }],
    );
  }
}

function btnStyle(): Record<string, string> {
  return {
    padding: '3px 8px',
    fontSize: '11px',
    background: THEME.panel,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    borderRadius: '4px',
    cursor: 'pointer',
  };
}
