/**
 * 挑战面板（GDD §30）。
 *
 * 设计要点：
 *   · 进行中的挑战排在最上方，并**逐条列出它改写了哪些规则** —— 玩家必须随时
 *     能看到"我现在的世界和平时有什么不同"，否则挑战就变成莫名其妙的难度；
 *   · 规则用人类可读的方式呈现（禁用什么/上限多少/每秒发生什么），而不是复述
 *     内部 kind 名；
 *   · 已完成的挑战折叠收起（30 条全展开会让面板无法使用）；
 *   · 未接入的规则会明示"不可开始"，而不是让玩家点进去玩一个假挑战。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { ChallengeDef, GameData, ModifierDef } from '../../core/types.ts';
import {
  abandonChallenge,
  challengeEffects,
  challengeTimedOut,
  listChallenges,
  settleChallenge,
  startChallenge,
  type ChallengeProgress,
} from '../../core/challenges/challenge-engine.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { celebrate, showModal } from './modal.ts';

export interface ChallengePanelCallbacks {
  getState: () => GameState;
  getData: () => GameData;
  /** 状态被替换后由 app 接手 */
  commit: (next: GameState) => void;
  reopen: () => void;
  notice: (msg: string) => void;
}

/** 把内部的 modifier 描述成玩家看得懂的一句话 */
function describeModifier(m: ModifierDef, data: GameData): string {
  const v = m.value;
  const resName = (id: string): string => data.resources.get(id)?.def.name ?? id;
  switch (m.kind) {
    case 'richnessCap':
      return `土壤富饶度上限压到 ${v}%`;
    case 'richnessFloorLow':
      return `枯竭下限降到 ${v}%`;
    case 'banClass':
      return `禁止建造「${String(v)}」类节点`;
    case 'banResource':
      return `禁用资源：${resName(String(v))}`;
    case 'noLight':
      return '微光消失，光照类节点失效';
    case 'nodeCapMax':
      return `节点总数上限 ${v}`;
    case 'linkCapMax':
      return `连线总数上限 ${v}`;
    case 'outDegreeMax':
      return `每个节点出度上限 ${v}`;
    case 'noAutomation':
      return '自动化全部失效';
    case 'noOffline':
      return '离线收益归零';
    case 'noPrestige':
      return '禁止孢子化';
    case 'costGrowthAdd':
      return `所有成本增长率 +${v}`;
    case 'depletionMul':
      return `土壤枯竭速度 ×${v}`;
    case 'outputPenalty':
      return `${m.res ? resName(m.res) : '某些资源'}产出 -${Math.round(Number(v) * 100)}%`;
    case 'buildSpeedMul':
      return `建造速度 ×${v}`;
    case 'eventRateMul':
      return `事件频率 ×${v}`;
    case 'marketClosed':
      return '菌市关闭';
    case 'layersOnly':
      return `只允许在「${data.layers.get(String(v))?.name ?? String(v)}」层建造`;
    case 'resourceZero':
      return `${resName(String(v))} 恒为 0 且不可生产`;
    case 'resourceTheft':
      return `每秒有 ${v}% 概率被偷走部分资源`;
    case 'nodeDecay':
      return `节点每秒有 ${v}% 概率凋亡`;
    case 'noCarryover':
      return '孢子化不保留科技与机制升级';
    case 'timeLimitSec':
      return `时限 ${Math.floor(Number(v) / 60)} 分钟，超时失败`;
    case 'reverseRecipes':
      return '所有配方的输入与输出对调';
    case 'randomRelink':
      return `每 ${v} 秒随机重连一条边`;
    case 'matrixShuffle':
      return `每 ${v} 秒随机改写一条催化规则`;
    case 'richnessSimmer':
      return '土壤富饶度每秒随机波动';
    case 'hostilityNoDecay':
      return '敌意永不衰减';
    case 'toxinSelfDamageMul':
      return `毒素反噬 ×${v}`;
    default:
      return `${m.kind}（未接入）`;
  }
}

function goalBar(p: ChallengeProgress): HTMLElement {
  const pct = Math.round(p.progress * 100);
  return h(
    'div',
    { style: { marginTop: '6px' } },
    h('div', { style: { fontSize: '11px', color: THEME.textDim, marginBottom: '3px' }, text: p.goalText }),
    h(
      'div',
      { style: { height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' } },
      h('div', {
        style: {
          width: `${Math.min(100, pct)}%`,
          height: '100%',
          background: p.completed ? THEME.accent : '#fbbf24',
        },
      }),
    ),
  );
}

function ruleList(def: ChallengeDef, data: GameData): HTMLElement {
  return h(
    'div',
    { style: { margin: '6px 0', display: 'flex', flexDirection: 'column', gap: '2px' } },
    ...def.modifiers.map((m) =>
      h('div', { style: { fontSize: '11px', color: '#fbbf24', lineHeight: '1.6' }, text: `· ${describeModifier(m, data)}` }),
    ),
  );
}

function button(label: string, enabled: boolean, onClick: () => void, primary = false): HTMLElement {
  return h('button', {
    text: label,
    ...(enabled ? {} : { disabled: true }),
    style: {
      padding: '6px 14px',
      borderRadius: '7px',
      border: `1px solid ${primary && enabled ? THEME.accent : THEME.border}`,
      background: primary && enabled ? 'rgba(74,222,128,0.14)' : 'transparent',
      color: enabled ? (primary ? THEME.accent : THEME.text) : THEME.textDim,
      cursor: enabled ? 'pointer' : 'not-allowed',
      fontSize: '12px',
      opacity: enabled ? '1' : '0.6',
    },
    onclick: enabled ? onClick : undefined,
  });
}

export function openChallengePanel(cb: ChallengePanelCallbacks): void {
  const state = cb.getState();
  const data = cb.getData();
  const list = listChallenges(state, data);
  const active = list.find((c) => c.active);
  const fx = challengeEffects(state, data);

  const body = h('div', { style: { maxHeight: '64vh', overflowY: 'auto' } });

  // ---------------------------------------------------------------- 进行中
  if (active) {
    const timedOut = challengeTimedOut(state, data);
    const card = h(
      'div',
      {
        style: {
          border: `1px solid #fbbf24`,
          borderRadius: '10px',
          padding: '12px 14px',
          marginBottom: '14px',
          background: 'rgba(251,191,36,0.06)',
        },
      },
      h('div', { style: { fontSize: '15px', color: '#fbbf24' }, text: `进行中：${active.def.name}` }),
      h('div', { style: { fontSize: '12px', color: THEME.textDim, marginTop: '2px' }, text: active.def.desc }),
      h('div', { style: { fontSize: '12px', color: THEME.text, marginTop: '8px' }, text: '这个世界被改写了：' }),
      ruleList(active.def, data),
      goalBar(active),
      active.secondsLeft !== null
        ? h('div', {
            style: { fontSize: '12px', color: timedOut ? THEME.danger : '#fbbf24', marginTop: '6px' },
            text: `剩余时间：${Math.floor(active.secondsLeft / 60)} 分 ${Math.floor(active.secondsLeft % 60)} 秒`,
          })
        : h('span', { text: '' }),
      h('div', {
        style: { fontSize: '11px', color: THEME.textDim, marginTop: '6px' },
        text: `奖励：${active.rewardText}`,
      }),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
        button('主动放弃（回滚进度）', true, () => {
          const res = abandonChallenge(state, data);
          if (!res.ok || !res.state) {
            cb.notice(res.reason);
            return;
          }
          cb.commit(res.state);
          cb.notice(res.reason || `已放弃「${active.def.name}」`);
          cb.reopen();
        }),
        timedOut
          ? button('结算（超时失败）', true, () => {
              const res = settleChallenge(state, data, true);
              if (res.state) cb.commit(res.state);
              cb.notice(res.reason);
              cb.reopen();
            })
          : button(
              '完成挑战',
              active.progress >= 1,
              () => {
                const res = settleChallenge(state, data);
                if (!res.ok || !res.state) {
                  cb.notice(res.reason);
                  return;
                }
                cb.commit(res.state);
                celebrate('挑战完成', `${active.def.name} —— ${active.rewardText}`, 'quest');
                cb.reopen();
              },
              true,
            ),
      ),
      h('div', {
        style: { fontSize: '11px', color: THEME.textDim, marginTop: '6px' },
        text: '提示：挑战期间关闭游戏会丢失回滚点，放弃时将退回干净开局。',
      }),
    );
    void fx;
    body.append(card);
  }

  // ---------------------------------------------------------------- 可挑战
  const available = list.filter((c) => !c.active && !c.completed);
  body.append(
    h('div', { style: { fontSize: '13px', color: THEME.text, margin: '4px 0 8px' }, text: `可挑战（${available.length}）` }),
  );
  for (const c of available) {
    body.append(
      h(
        'div',
        {
          style: {
            border: `1px solid ${c.blocked ? THEME.border : 'rgba(255,255,255,0.14)'}`,
            borderRadius: '9px',
            padding: '10px 12px',
            marginBottom: '8px',
            opacity: c.blocked ? '0.55' : '1',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { fontSize: '13px', color: THEME.text }, text: c.def.name }),
          h('span', { style: { fontSize: '11px', color: THEME.textDim }, text: c.def.cat }),
          c.blocked
            ? h('span', { style: { fontSize: '11px', color: THEME.danger, marginLeft: 'auto' }, text: c.blockedReason })
            : h('span', { text: '' }),
        ),
        h('div', { style: { fontSize: '11px', color: THEME.textDim, marginTop: '3px' }, text: c.def.desc }),
        ruleList(c.def, data),
        h('div', { style: { fontSize: '11px', color: THEME.accent }, text: `奖励：${c.rewardText}` }),
        h(
          'div',
          { style: { marginTop: '8px' } },
          button(
            active ? '先结束当前挑战' : '开始挑战',
            !active && !c.blocked,
            () => {
              const res = startChallenge(state, data, c.id);
              if (!res.ok || !res.challenge) {
                cb.notice(res.reason);
                return;
              }
              cb.commit({ ...state, challenges: res.challenge });
              cb.notice(`已开始「${c.def.name}」——世界规则已改写`);
              cb.reopen();
            },
            true,
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- 已完成
  const done = list.filter((c) => c.completed);
  if (done.length > 0) {
    body.append(
      h('div', { style: { fontSize: '13px', color: THEME.accent, margin: '10px 0 6px' }, text: `已完成（${done.length}/30）` }),
    );
    for (const c of done) {
      body.append(
        h(
          'div',
          { style: { fontSize: '11px', color: THEME.textDim, lineHeight: '1.8' } },
          h('span', { text: `✔ ${c.def.name} —— ${c.rewardText}` }),
        ),
      );
    }
  }

  const stats = h('div', {
    style: { fontSize: '11px', color: THEME.textDim, marginTop: '10px' },
    text: `累计失败/放弃：${state.challenges.failures} 次｜已完成奖励共 ${done.length} 条（永久生效）`,
  });
  body.append(stats);

  void SciNum;
  showModal('挑战', body, [{ label: '关闭', primary: true }]);
}
