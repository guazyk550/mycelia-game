/**
 * 自动化规则引擎（六级自动化的最高层，GDD §16 第六阶段）。
 *
 * 设计选择：**不做文本 DSL 解析**，而是结构化规则（条件 + 动作）。
 * 理由：文本解析会引入词法/语法错误面与注入风险，而结构化规则天然可校验、
 * 可序列化、可在 UI 里用下拉框编辑 —— 玩家仍然在"编写自己的生产 AI"。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { GameData } from '../types.ts';

export type RuleConditionKind = 'always' | 'resourceGte' | 'resourceLte' | 'rateLt' | 'nodesGte' | 'nodesLte' | 'upgradeBelowMax';
export type RuleActionKind = 'build' | 'upgrade' | 'tech' | 'prestige' | 'setNodeActive';

export interface AutoRule {
  id: string;
  name: string;
  enabled: boolean;
  cond: {
    kind: RuleConditionKind;
    res?: string;
    value?: string;
    /** nodesGte/nodesLte 用 */
    count?: number;
    /** upgradeBelowMax 用 */
    target?: string;
  };
  act: {
    kind: RuleActionKind;
    /** build 用节点类型；upgrade/tech 用其 id */
    target?: string;
    active?: boolean;
  };
  /** 冷却（游戏内秒），防止每 tick 重复触发 */
  cooldownSec: number;
  lastFiredAt: number;
}

export function makeRule(partial: Partial<AutoRule> & { id: string }): AutoRule {
  return {
    name: '新规则',
    enabled: true,
    cond: { kind: 'resourceGte', res: 'spore', value: '1000' },
    act: { kind: 'upgrade', target: '' },
    cooldownSec: 5,
    lastFiredAt: -1e9,
    ...partial,
  };
}

export function describeRule(rule: AutoRule, data: GameData): string {
  const name = (res?: string): string => (res ? (data.resources.get(res)?.def.name ?? res) : '?');
  const cond = ((): string => {
    switch (rule.cond.kind) {
      case 'always':
        return '总是';
      case 'resourceGte':
        return `${name(rule.cond.res)} ≥ ${rule.cond.value ?? '0'}`;
      case 'resourceLte':
        return `${name(rule.cond.res)} ≤ ${rule.cond.value ?? '0'}`;
      case 'rateLt':
        return `${name(rule.cond.res)} 净产出为负`;
      case 'nodesGte':
        return `节点数 ≥ ${rule.cond.count ?? 0}`;
      case 'nodesLte':
        return `节点数 ≤ ${rule.cond.count ?? 0}`;
      case 'upgradeBelowMax':
        return `${rule.cond.target ?? '?'} 未满级`;
      default:
        return '?';
    }
  })();
  const act = ((): string => {
    switch (rule.act.kind) {
      case 'build':
        return `建造 ${data.nodes.get(rule.act.target ?? '')?.def.name ?? rule.act.target ?? '?'}`;
      case 'upgrade':
        return `购买升级 ${data.upgrades.get(rule.act.target ?? '')?.def.name ?? rule.act.target ?? '?'}`;
      case 'tech':
        return `解锁科技 ${data.techs.get(rule.act.target ?? '')?.def.name ?? rule.act.target ?? '?'}`;
      case 'prestige':
        return '孢子化';
      case 'setNodeActive':
        return rule.act.active === false ? '停用节点' : '启用节点';
      default:
        return '?';
    }
  })();
  return `IF ${cond} THEN ${act}`;
}

/** 条件求值（纯函数，便于测试） */
export function evaluateCondition(rule: AutoRule, state: GameState, data: GameData): boolean {
  const c = rule.cond;
  switch (c.kind) {
    case 'always':
      return true;
    case 'resourceGte':
      return SciNum.gte(state.resources[c.res ?? ''] ?? SciNum.ZERO, SciNum.from(c.value ?? '0'));
    case 'resourceLte':
      return SciNum.lte(state.resources[c.res ?? ''] ?? SciNum.ZERO, SciNum.from(c.value ?? '0'));
    case 'rateLt':
      return (state.ratePerSec[c.res ?? ''] ?? 0) < 0;
    case 'nodesGte':
      return state.graph.size() >= (c.count ?? 0);
    case 'nodesLte':
      return state.graph.size() <= (c.count ?? 0);
    case 'upgradeBelowMax': {
      const up = data.upgrades.get(c.target ?? '');
      if (!up) return false;
      return (state.upgrades[c.target!] ?? 0) < up.def.maxLevel;
    }
    default:
      return false;
  }
}

/** 规则可用性预检：引用不存在的目标时直接判为无效（避免"看不见的坏规则"） */
export function validateRule(rule: AutoRule, data: GameData): string | null {
  const c = rule.cond;
  if (c.kind === 'resourceGte' || c.kind === 'resourceLte' || c.kind === 'rateLt') {
    if (!c.res || !data.resources.has(c.res)) return `条件引用了未知资源：${c.res ?? '(空)'}`;
    const v = SciNum.from(c.value ?? '0');
    if (v.isNaN()) return `条件阈值非法：${c.value}`;
  }
  if (c.kind === 'upgradeBelowMax' && (!c.target || !data.upgrades.has(c.target)))
    return `条件引用了未知升级：${c.target ?? '(空)'}`;

  const a = rule.act;
  if (a.kind === 'build' && (!a.target || !data.nodes.has(a.target)))
    return `动作引用了未知节点：${a.target ?? '(空)'}`;
  if (a.kind === 'upgrade' && (!a.target || !data.upgrades.has(a.target)))
    return `动作引用了未知升级：${a.target ?? '(空)'}`;
  if (a.kind === 'tech' && (!a.target || !data.techs.has(a.target)))
    return `动作引用了未知科技：${a.target ?? '(空)'}`;
  return null;
}

/** 冷却是否已过 */
export function isReady(rule: AutoRule, elapsed: number): boolean {
  return elapsed - rule.lastFiredAt >= rule.cooldownSec;
}
