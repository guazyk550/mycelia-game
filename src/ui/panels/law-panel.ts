/**
 * 法则面板（Meta 层）。
 *
 * 设计要点：**改写前 / 改写后对照**。法则改的是公式，玩家必须能一眼看到
 * "现在是多少 → 应用后变成多少"，否则它只是一段看不懂的描述文字。
 */

import { SciNum } from '../../core/math/scinum.ts';
import type { GameState } from '../../core/state.ts';
import type { GameData, LawDef } from '../../core/types.ts';
import { applyLaw, lawBonuses, listLaws } from '../../core/meta/laws.ts';
import { h } from '../dom.ts';
import { THEME } from '../theme.ts';
import { celebrate, showModal } from './modal.ts';

export interface LawPanelCallbacks {
  getState: () => GameState;
  getData: () => GameData;
  commit: (next: GameState) => void;
  reopen: () => void;
  notice: (msg: string) => void;
}

/** 法则效果的"当前值 → 应用后值"预览（这是本面板存在的核心价值） */
function preview(def: LawDef, bonuses: ReturnType<typeof lawBonuses>, data: GameData, target: string | null): [string, string] {
  const v = typeof def.effect.value === 'number' ? def.effect.value : 0;
  switch (def.effect.kind) {
    case 'recipeRateMul': {
      const cur = Math.round((bonuses.byRes[target ?? ''] ?? 0) * 100);
      return [`目标资源产出 +${cur}%`, `目标资源产出 +${cur + Math.round(v * 100)}%`];
    }
    case 'costGrowthCut':
      return [
        `成本增长率 -${bonuses.costGrowthCut.toFixed(2)}`,
        `成本增长率 -${(bonuses.costGrowthCut + v).toFixed(2)}`,
      ];
    case 'catalystBonus':
      return [
        `催化加成 +${Math.round(bonuses.catalystBonus * 100)}%`,
        `催化加成 +${Math.round((bonuses.catalystBonus + v) * 100)}%`,
      ];
    case 'offlineHoursAdd':
      return [
        `离线上限 ${data.config.offline.hardCapHours + bonuses.offlineHoursAdd} 小时`,
        `离线上限 ${data.config.offline.hardCapHours + bonuses.offlineHoursAdd + v} 小时`,
      ];
    case 'maturityFloorAdd':
      return [
        `成熟度下限 ${(0.2 + bonuses.maturityFloorAdd).toFixed(2)}`,
        `成熟度下限 ${(0.2 + bonuses.maturityFloorAdd + v).toFixed(2)}`,
      ];
    case 'richnessRepair':
      return [
        `土壤恢复 ${bonuses.richnessRepair.toFixed(2)}/秒`,
        `土壤恢复 ${(bonuses.richnessRepair + v).toFixed(2)}/秒`,
      ];
    case 'eventRateCut':
      return [
        `事件频率 ${Math.round((1 - bonuses.eventRateCut) * 100)}%`,
        `事件频率 ${Math.round((1 - Math.min(0.8, bonuses.eventRateCut + v)) * 100)}%`,
      ];
    case 'marketDepthMul':
      return [
        `市场深度 ${Math.round((1 + bonuses.marketDepthMul) * 100)}%`,
        `市场深度 ${Math.round((1 + bonuses.marketDepthMul + v) * 100)}%`,
      ];
    case 'matrixOverride': {
      const key = target ?? '';
      const cur = data.catalystIndex.get(key)?.rateMul ?? 1;
      return [`该规则倍率 ×${cur}`, `该规则倍率 ×${v}`];
    }
    default:
      return ['—', '—'];
  }
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

export function openLawPanel(cb: LawPanelCallbacks): void {
  const state = cb.getState();
  const data = cb.getData();
  const bonuses = lawBonuses(state, data);
  const list = listLaws(state, data);
  const shards = state.resources['law'] ?? SciNum.ZERO;

  const body = h('div', { style: { maxHeight: '64vh', overflowY: 'auto' } });

  body.append(
    h('div', {
      style: { fontSize: '12px', color: THEME.textDim, marginBottom: '10px', lineHeight: '1.7' },
      text:
        `持有生态法则碎片：${SciNum.format(shards)}｜已应用法则 ${state.laws.length} 条\n` +
        '法则改的是**公式本身**（成本曲线、离线上限、成熟度下限、事件频率、市场深度、催化矩阵），不是叠加一个倍率。',
    }),
  );

  if (list.length === 0) {
    body.append(h('div', { text: '（法则表为空）' }));
  }

  for (const opt of list) {
    const def = opt.def;
    const target = opt.targets[0]?.id ?? null;
    const [before, after] = preview(def, bonuses, data, target);

    const card = h(
      'div',
      {
        style: {
          border: `1px solid ${opt.maxed ? THEME.accent : THEME.border}`,
          borderRadius: '9px',
          padding: '10px 12px',
          marginBottom: '8px',
          opacity: opt.maxed && opt.stacks >= def.maxStacks ? '0.75' : '1',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '13px', color: THEME.text }, text: def.name }),
        h('span', {
          style: { fontSize: '11px', color: THEME.textDim },
          text: `${opt.stacks}/${def.maxStacks} 层`,
        }),
        h('span', {
          style: { fontSize: '11px', color: opt.affordable ? THEME.textDim : THEME.danger, marginLeft: 'auto' },
          text: `消耗 ${SciNum.format(opt.cost)} 碎片`,
        }),
      ),
      h('div', { style: { fontSize: '11px', color: THEME.textDim, marginTop: '3px' }, text: def.desc }),
      h(
        'div',
        {
          style: {
            marginTop: '6px',
            fontSize: '12px',
            color: THEME.text,
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '6px',
            padding: '6px 8px',
          },
        },
        h('div', { text: `当前：${before}` }),
        h('div', { style: { color: THEME.accent }, text: `应用后：${after}` }),
      ),
    );

    // 需要目标的法则：给出目标选择（矩阵律列出矩阵规则，滋养律列出资源）
    if (def.needsTarget && opt.targets.length > 0 && !opt.maxed) {
      const select = h('select', {
        style: {
          marginTop: '8px',
          width: '100%',
          padding: '6px 8px',
          borderRadius: '6px',
          background: THEME.panel,
          color: THEME.text,
          border: `1px solid ${THEME.border}`,
          fontSize: '12px',
        },
      });
      for (const t of opt.targets.slice(0, 60)) {
        select.append(h('option', { value: t.id, text: t.name }));
      }
      card.append(select);

      card.append(
        h(
          'div',
          { style: { marginTop: '8px' } },
          button(
            opt.affordable ? '应用法则' : '碎片不足',
            opt.affordable,
            () => {
              const chosen = select.value;
              const r = applyLaw(state, data, def.id, chosen);
              if (!r.ok || !r.state) {
                cb.notice(r.reason);
                return;
              }
              cb.commit(r.state);
              celebrate('法则改写', `${def.name} —— ${after}`, 'prestige');
              cb.reopen();
            },
            true,
          ),
        ),
      );
    } else {
      card.append(
        h(
          'div',
          { style: { marginTop: '8px' } },
          opt.maxed
            ? h('span', { style: { fontSize: '11px', color: THEME.accent }, text: '已叠满' })
            : button(
                opt.affordable ? '应用法则' : '碎片不足',
                opt.affordable,
                () => {
                  const r = applyLaw(state, data, def.id, null);
                  if (!r.ok || !r.state) {
                    cb.notice(r.reason);
                    return;
                  }
                  cb.commit(r.state);
                  celebrate('法则改写', `${def.name} —— ${after}`, 'prestige');
                  cb.reopen();
                },
                true,
              ),
        ),
      );
    }

    body.append(card);
  }

  showModal('生态法则', body, [{ label: '关闭', primary: true }]);
}
