/**
 * 时间银行面板（惊喜机制）。
 *
 * 机制说明刻意写得"像是在描述一个你已经拥有的东西"，而不是教程口吻 ——
 * 惊喜机制不该被教程剧透。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData } from '../../core/types.ts';
import { timeBankView, withdrawTimeBank } from '../../core/meta/timebank.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { celebrate, showModal } from './modal.ts';

export interface TimeBankPanelCallbacks {
  getState: () => GameState;
  getData: () => GameData;
  commit: (next: GameState) => void;
  reopen: () => void;
  notice: (msg: string) => void;
}

function fmtDuration(sec: number): string {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh} 时 ${mm} 分` : mm > 0 ? `${mm} 分 ${ss} 秒` : `${ss} 秒`;
}

export function openTimeBankPanel(cb: TimeBankPanelCallbacks): void {
  const state = cb.getState();
  const data = cb.getData();
  const view = timeBankView(state, data);

  const body = h('div', { style: { maxHeight: '60vh', overflowY: 'auto' } });

  if (!view.unlocked) {
    body.append(
      h(
        'div',
        { style: { fontSize: '12px', lineHeight: '1.9', color: THEME.textDim } },
        h('div', {
          text: '你还没学会怎么把时间折叠起来。',
        }),
        h('div', {
          style: { marginTop: '8px', color: THEME.text },
          text: '线索：科技树的「时间」分支里有一条关于储存的路线。',
        }),
      ),
    );
    showModal('时间银行', body, [{ label: '关闭', primary: true }]);
    return;
  }

  body.append(
    h(
      'div',
      { style: { fontSize: '12px', lineHeight: '1.8', color: THEME.textDim, marginBottom: '10px' } },
      h('div', { text: '网络每秒把一小部分时间折起来存好，你随时可以把它展开。' }),
      h('div', { text: `展开时会有 ${Math.round(view.loss * 100)}% 的损耗 —— 折痕抹不平。` }),
    ),
  );

  // 进度条
  body.append(
    h(
      'div',
      { style: { marginBottom: '10px' } },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: THEME.text } },
        h('span', { text: `已储存：${fmtDuration(view.storedSec)}` }),
        h('span', { style: { color: THEME.textDim }, text: `上限 ${fmtDuration(view.capSec)}` }),
      ),
      h(
        'div',
        { style: { height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden', marginTop: '4px' } },
        h('div', { style: { width: `${Math.round(view.fill * 100)}%`, height: '100%', background: THEME.accent } }),
      ),
    ),
  );

  // 取出预览
  if (view.preview.length === 0) {
    body.append(h('div', { style: { fontSize: '12px', color: THEME.textDim }, text: '现在展开什么也拿不到（网络没有正产出）。' }));
  } else {
    body.append(
      h('div', { style: { fontSize: '12px', color: THEME.text, marginBottom: '4px' }, text: '现在展开可以拿到：' }),
    );
    for (const p of view.preview.slice(0, 8)) {
      const res = data.resources.get(p.res);
      body.append(
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', lineHeight: '1.8' } },
          h('span', { style: { color: res?.def.color ?? THEME.text }, text: res?.def.name ?? p.res }),
          h('span', { style: { color: THEME.accent }, text: `+${SciNum.format(p.amount)}` }),
        ),
      );
    }
  }

  const canWithdraw = view.storedSec > 0 && view.preview.length > 0;
  body.append(
    h(
      'div',
      { style: { marginTop: '12px' } },
      h('button', {
        text: canWithdraw ? '展开时间' : '暂无可展开的时间',
        ...(canWithdraw ? {} : { disabled: true }),
        style: {
          padding: '8px 18px',
          borderRadius: '8px',
          border: `1px solid ${canWithdraw ? THEME.accent : THEME.border}`,
          background: canWithdraw ? 'rgba(74,222,128,0.14)' : 'transparent',
          color: canWithdraw ? THEME.accent : THEME.textDim,
          cursor: canWithdraw ? 'pointer' : 'not-allowed',
          fontSize: '13px',
          opacity: canWithdraw ? '1' : '0.6',
        },
        onclick: canWithdraw
          ? () => {
              const r = withdrawTimeBank(state, data);
              if (!r.ok || !r.state) {
                cb.notice(r.reason);
                return;
              }
              cb.commit(r.state);
              const top = r.gained[0];
              celebrate('时间展开', top ? `+${SciNum.format(top.amount)} ${data.resources.get(top.res)?.def.name ?? top.res}` : '已结算', 'quest');
              cb.reopen();
            }
          : undefined,
      }),
    ),
  );

  body.append(
    h('div', {
      style: { fontSize: '11px', color: THEME.textDim, marginTop: '10px' },
      text: `已展开 ${state.stats.timeBankWithdraws ?? 0} 次。储存速率：每秒存入 ${(data.config.timeBank.depositRatePerSec * 100).toFixed(0)}% 的时间。`,
    }),
  );

  showModal('时间银行', body, [{ label: '关闭', primary: true }]);
}
