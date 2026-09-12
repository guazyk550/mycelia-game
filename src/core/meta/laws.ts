/**
 * 生态法则（Meta 层）—— 用「生态法则碎片」永久改写一条**公式**。
 *
 * 与升级/科技的区别（这是 Meta 层存在的理由）：
 *   · 升级：给同一个公式乘一个更大的系数；
 *   · 科技：解锁一个新东西；
 *   · 法则：**改公式本身** —— 成本曲线更平、离线能更久、成熟度不再从 0.2 起算、
 *     事件变稀疏、市场不再一卖就崩。
 *
 * 由于法则改的是曲线，它们必须在**读取配置/计算派生值的位置**生效，而不是
 * 简单往 ModifierSet 里加一个数。本模块提供两类接口：
 *   · `lawBonuses(state, data)` —— 汇总成结构化加成，供 engine / market / offline / prestige 读取；
 *   · `lawModifierCap()`  —— 叠加上限由数据表 maxStacks 保证，这里只做查询。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameData, LawDef } from '../types.ts';
import type { GameState, LawInstance } from '../state.ts';

export type { LawInstance };

export interface LawBonuses {
  /** 资源 → 产出倍率加成 */
  byRes: Record<string, number>;
  costGrowthCut: number;
  catalystBonus: number;
  offlineHoursAdd: number;
  maturityFloorAdd: number;
  richnessRepair: number;
  eventRateCut: number;
  marketDepthMul: number;
  /** 催化矩阵覆盖：key = "上游标签>下游类"，值 = 新的 rateMul */
  matrixOverrides: Record<string, number>;
}

const EMPTY: LawBonuses = {
  byRes: {},
  costGrowthCut: 0,
  catalystBonus: 0,
  offlineHoursAdd: 0,
  maturityFloorAdd: 0,
  richnessRepair: 0,
  eventRateCut: 0,
  marketDepthMul: 0,
  matrixOverrides: {},
};

/** 已应用的法则（默认空数组；旧存档迁移时补上） */
export function lawsOf(state: GameState): LawInstance[] {
  return state.laws ?? [];
}

/** 汇总全部法则加成 */
export function lawBonuses(state: GameState, data: GameData): LawBonuses {
  const laws = lawsOf(state);
  if (laws.length === 0) return { ...EMPTY, byRes: {} };

  const out: LawBonuses = { ...EMPTY, byRes: {}, matrixOverrides: {} };
  for (const inst of laws) {
    const def = data.laws.get(inst.id);
    if (!def) continue;
    const v = typeof def.effect.value === 'number' ? def.effect.value : 0;
    const times = Math.min(Math.max(1, inst.stacks), def.maxStacks);
    switch (def.effect.kind) {
      case 'recipeRateMul':
        if (inst.target) out.byRes[inst.target] = (out.byRes[inst.target] ?? 0) + v * times;
        break;
      case 'costGrowthCut':
        out.costGrowthCut += v * times;
        break;
      case 'catalystBonus':
        out.catalystBonus += v * times;
        break;
      case 'offlineHoursAdd':
        out.offlineHoursAdd += v * times;
        break;
      case 'maturityFloorAdd':
        out.maturityFloorAdd += v * times;
        break;
      case 'richnessRepair':
        out.richnessRepair += v * times;
        break;
      case 'eventRateCut':
        out.eventRateCut += v * times;
        break;
      case 'marketDepthMul':
        out.marketDepthMul += v * times;
        break;
      case 'matrixOverride':
        // 改写矩阵里的某一条规则：派生索引（catalystIndex）在下一 tick 读取时
        // 通过本覆盖生效 —— 不改全局数据表，避免多存档之间互相污染。
        if (inst.target) out.matrixOverrides[inst.target] = v;
        break;
      default:
        // 数据表校验会拦住未声明的 kind；这里不静默吞掉而是保持可诊断
        break;
    }
  }
  return out;
}

export interface LawOption {
  def: LawDef;
  /** 已应用的次数 */
  stacks: number;
  /** 是否已达上限 */
  maxed: boolean;
  /** 目标列表（needsTarget 时为候选资源） */
  targets: { id: string; name: string }[];
  /** 碎片是否够付 */
  affordable: boolean;
  cost: SciNum;
}

/** 列出全部法则及其当前状态（UI 用） */
export function listLaws(state: GameState, data: GameData): LawOption[] {
  const laws = lawsOf(state);
  const have = state.resources['law'] ?? SciNum.ZERO;
  const out: LawOption[] = [];

  for (const [id, def] of data.laws) {
    const applied = laws.filter((l) => l.id === id);
    const stacks = applied.reduce((s, l) => s + l.stacks, 0);
    const cost = SciNum.from(def.cost);
    const targets =
      def.targetKind === 'catalystRule'
        ? [...data.catalystIndex.entries()].map(([key, rule]) => ({
            id: key,
            name: `${rule.upstreamTag} → ${rule.downstreamClass}（当前 ×${rule.rateMul}）`,
          }))
        : def.needsTarget
          ? [...data.resources.values()]
              .filter((r) => !r.def.hidden && r.def.tier <= 3)
              .map((r) => ({ id: r.def.id, name: r.def.name }))
          : [];
    out.push({
      def,
      stacks,
      maxed: stacks >= def.maxStacks,
      targets,
      affordable: SciNum.gte(have, cost),
      cost,
    });
  }
  return out.sort((a, b) => Number(a.maxed) - Number(b.maxed) || a.def.id.localeCompare(b.def.id));
}

export interface ApplyLawResult {
  ok: boolean;
  reason: string;
  state?: GameState;
}

/**
 * 应用一条法则。**不修改传入的 state**。
 * 同一法则同一目标重复应用时叠加 stacks（受 maxStacks 限制）。
 */
export function applyLaw(state: GameState, data: GameData, lawId: string, target: string | null): ApplyLawResult {
  const def = data.laws.get(lawId);
  if (!def) return { ok: false, reason: `未知法则：${lawId}` };
  if (def.needsTarget && !target) return { ok: false, reason: '这条法则需要选择一个目标' };
  if (!def.needsTarget && target) return { ok: false, reason: '这条法则不接受目标' };
  if (def.needsTarget && target) {
    const valid = def.targetKind === 'catalystRule' ? data.catalystIndex.has(target) : data.resources.has(target);
    if (!valid) return { ok: false, reason: `未知目标：${target}` };
  }

  const laws = [...lawsOf(state)];
  const key = `${lawId}|${target ?? ''}`;
  const idx = laws.findIndex((l) => `${l.id}|${l.target ?? ''}` === key);
  const stacks = idx >= 0 ? laws[idx]!.stacks : 0;
  if (stacks >= def.maxStacks) return { ok: false, reason: `「${def.name}」已达叠加上限 ${def.maxStacks}` };

  const cost = SciNum.from(def.cost);
  const have = state.resources['law'] ?? SciNum.ZERO;
  if (SciNum.lt(have, cost)) return { ok: false, reason: `需要 ${SciNum.format(cost)} 生态法则碎片` };

  const next = { ...state } as GameState;
  next.resources = { ...state.resources };
  next.stats = { ...state.stats };
  const after = SciNum.sub(have, cost);
  next.resources['law'] = after.isNegative() ? SciNum.ZERO : after;

  if (idx >= 0) laws[idx] = { ...laws[idx]!, stacks: stacks + 1 };
  else laws.push({ id: lawId, target, stacks: 1 });
  next.laws = laws;
  next.stats.lawsApplied = (state.stats.lawsApplied ?? 0) + 1;

  return { ok: true, reason: '', state: next };
}

/** 法则对某资源的产出加成（engine 在算产出时叠加） */
export function lawResBonus(bonuses: LawBonuses, resId: string): number {
  return 1 + (bonuses.byRes[resId] ?? 0);
}

// ---------------------------------------------------------------- 惊喜机制：规则碎片

/**
 * 玩家自定义催化规则（「规则碎片」）。
 *
 * 机制：玩家可以亲手往催化矩阵里写一条规则（上游标签 × 下游类 → 倍率）。
 * **总量守恒**是它的核心约束 —— 所有自定义规则的加成之和（Σ(倍率−1)）不得超过预算，
 * 想写更多就必须先把已有的调弱。这样它不是"免费变强"，而是一次取舍。
 */

/** 总量守恒预算（Σ(倍率−1) 的上限） */
export const CUSTOM_RULE_BUDGET = 1.0;

export interface CustomRule {
  upstreamTag: string;
  downstreamClass: string;
  rateMul: number;
}

export function customRulesOf(state: GameState): CustomRule[] {
  return state.customRules ?? [];
}

/** 已用预算 */
export function customRuleBudgetUsed(state: GameState): number {
  return customRulesOf(state).reduce((sum, r) => sum + Math.max(0, r.rateMul - 1), 0);
}

export interface AddCustomRuleResult {
  ok: boolean;
  reason: string;
  state?: GameState;
}

/**
 * 写入一条自定义催化规则。**不修改传入的 state**。
 * 同一组合重复写入时改为覆盖（而不是叠加），这样玩家可以自由调整分配。
 */
export function addCustomRule(
  state: GameState,
  data: GameData,
  upstreamTag: string,
  downstreamClass: string,
  rateMul: number,
): AddCustomRuleResult {
  if (!Number.isFinite(rateMul) || rateMul < 1) return { ok: false, reason: '倍率必须 ≥ 1（自定义规则只能增强，不能削弱）' };
  const validTags = new Set([...data.nodes.values()].map((n) => n.def.catalystTag));
  if (!validTags.has(upstreamTag)) return { ok: false, reason: `未知的上游标签：${upstreamTag}` };
  const validClasses = new Set<string>([...data.nodes.values()].map((n) => n.def.class as string));
  if (downstreamClass !== '*' && !validClasses.has(downstreamClass)) {
    return { ok: false, reason: `未知的下游类：${downstreamClass}` };
  }

  const rules = customRulesOf(state).filter(
    (r) => !(r.upstreamTag === upstreamTag && r.downstreamClass === downstreamClass),
  );
  const usedOthers = rules.reduce((sum, r) => sum + Math.max(0, r.rateMul - 1), 0);
  const need = rateMul - 1;
  if (usedOthers + need > CUSTOM_RULE_BUDGET + 1e-9) {
    return {
      ok: false,
      reason: `总量守恒：预算 ${CUSTOM_RULE_BUDGET.toFixed(2)}，已用 ${usedOthers.toFixed(2)}，这条需要 ${need.toFixed(2)}`,
    };
  }

  const next = { ...state } as GameState;
  next.stats = { ...state.stats };
  next.customRules = [...rules, { upstreamTag, downstreamClass, rateMul }];
  next.stats.customRulesMade = (state.stats.customRulesMade ?? 0) + 1;
  return { ok: true, reason: '', state: next };
}

/** 删除一条自定义规则（预算随之释放） */
export function removeCustomRule(state: GameState, upstreamTag: string, downstreamClass: string): GameState {
  const next = { ...state } as GameState;
  next.customRules = customRulesOf(state).filter(
    (r) => !(r.upstreamTag === upstreamTag && r.downstreamClass === downstreamClass),
  );
  return next;
}

/** 查询某条组合的自定义倍率（没有则 null） */
export function customRuleFor(state: GameState, upstreamTag: string, downstreamClass: string): number | null {
  for (const r of customRulesOf(state)) {
    if (r.upstreamTag === upstreamTag && r.downstreamClass === downstreamClass) return r.rateMul;
    if (r.upstreamTag === upstreamTag && r.downstreamClass === '*') return r.rateMul;
  }
  return null;
}
