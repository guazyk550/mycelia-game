/**
 * 无头经济模拟器 —— 玩家策略机器人。
 *
 * 对应设计文档第三十九条的六类玩家：
 *   A 积极点击 / B 挂机 / C Prestige 狂 / D 科研 / E 自动化 / F 共生与市场
 * 每类玩家 = 一套偏好权重 + 同一个通用决策器（保证"所有路线都能合理成长，但走法不同"）。
 */

import { SciNum as S } from '../core/math/scinum.ts';
import type { GameState } from '../core/state.ts';
import type { GameData, NodeDef } from '../core/types.ts';
import {
  buildLink,
  buildNode,
  buyTech,
  buyUpgrade,
  canAfford,
  computeModifiers,
  getRes,
  nodeCost,
  sporogeneGain,
  upgradeCost,
  isNodeUnlocked,
  type ModifierSet,
} from '../core/economy/engine.ts';

export type SimAction =
  | { kind: 'buildNode'; typeId: string; layerId: string; autoLink: boolean }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'upgrade'; id: string }
  | { kind: 'tech'; id: string }
  | { kind: 'prestige' };

export interface Preferences {
  /** 节点类偏好权重（默认 1） */
  nodeClassWeight: Record<string, number>;
  /** 科技分支偏好权重（默认 1） */
  techBranchWeight: Record<string, number>;
  /** 全局倾向：升级 / 科技 / 扩张 */
  upgradeBias: number;
  techBias: number;
  nodeBias: number;
  /** 孢子基因达到该值即孢子化；<= 0 表示从不主动孢子化 */
  prestigeThreshold: number;
  /** 每次决策最多执行的动作数 */
  actionsPerStep: number;
  /** 开局表达的菌株（null = 不表达，作为基线对照） */
  strain?: string | null;
}

export interface Strategy {
  id: string;
  name: string;
  desc: string;
  prefs: Preferences;
}

/** 六种玩家原型 */
export const STRATEGIES: Strategy[] = [
  {
    id: 'A-aggressive',
    name: 'A 积极点击',
    desc: '每一步都追求当下最高的产出/成本比，主动扩张与升级。',
    prefs: { nodeClassWeight: {}, techBranchWeight: {}, upgradeBias: 1.0, techBias: 1.4, nodeBias: 1.2, prestigeThreshold: 6, actionsPerStep: 6 },
  },
  {
    id: 'B-idle',
    name: 'B 挂机',
    desc: '极少操作，只买最便宜的东西，主要依赖被动积累。',
    prefs: { nodeClassWeight: {}, techBranchWeight: {}, upgradeBias: 0.4, techBias: 0.3, nodeBias: 0.5, prestigeThreshold: 8, actionsPerStep: 2 },
  },
  {
    id: 'C-prestige',
    name: 'C Prestige 狂',
    desc: '全力冲孢子化门槛，收益一到手就重置。',
    prefs: { nodeClassWeight: {}, techBranchWeight: {}, upgradeBias: 0.6, techBias: 0.6, nodeBias: 1.5, prestigeThreshold: 3, actionsPerStep: 6 },
  },
  {
    id: 'D-research',
    name: 'D 科研',
    desc: '优先点科技树，愿意为机制型科技牺牲短期产量。',
    prefs: { nodeClassWeight: {}, techBranchWeight: {}, upgradeBias: 0.9, techBias: 3.0, nodeBias: 1.0, prestigeThreshold: 8, actionsPerStep: 6 },
  },
  {
    id: 'E-automation',
    name: 'E 自动化',
    desc: '优先自动驾驶分支与自动化升级，追求无人值守增长。',
    prefs: { nodeClassWeight: {}, techBranchWeight: { auto: 3.0 }, upgradeBias: 1.4, techBias: 1.8, nodeBias: 1.0, prestigeThreshold: 6, actionsPerStep: 6 },
  },
  {
    id: 'F-symbiosis',
    name: 'F 共生与市场',
    desc: '押注共生链与契约经济：藻类、蜜露、契约点优先。',
    prefs: {
      nodeClassWeight: { symbiont: 3.0, sporifier: 1.4, extractor: 0.8 },
      techBranchWeight: { symbiosis: 3.0 },
      upgradeBias: 0.9,
      techBias: 1.4,
      nodeBias: 1.1,
      prestigeThreshold: 6,
      actionsPerStep: 6,
    },
  },
];

// ---------------------------------------------------------------- 评分启发式

/**
 * 策略的"经济嗅觉"由三个信号组成（这是模拟器的关键，不是游戏逻辑）：
 *   1. 稀缺度  —— 产出的资源越紧缺，越值得建；
 *   2. 补链奖励 —— 某个必需资源当前**没有任何生产者**时，产出它的节点获得重奖
 *                  （人类玩家会说"我得先造个能产孢子的东西"，纯性价比评分不会）；
 *   3. 成本压力与过剩惩罚 —— 花掉大半库存、或产出已经堆积如山的资源，都要扣分。
 */

function log10Cost(cost: { amount: S }[]): number {
  let total = S.ZERO;
  for (const c of cost) total = S.add(total, c.amount);
  if (total.isZero()) return 0;
  return S.log10(total);
}

function affordable(state: GameState, cost: { res: string; amount: S }[]): boolean {
  return canAfford(state, cost);
}

/** 0 = 充足，1 = 极度紧缺 */
function scarcityOf(state: GameState, res: string): number {
  const have = getRes(state, res);
  const rate = state.ratePerSec[res] ?? 0;
  if (rate < 0) {
    const secondsLeft = have.toNumber() / -rate;
    if (secondsLeft < 60) return 1;
    if (secondsLeft < 600) return 0.7;
    return 0.3;
  }
  if (have.isZero()) return 1;
  if (S.lt(have, S.from(50))) return 0.6;
  if (S.lt(have, S.from(5000))) return 0.3;
  return 0.1;
}

/** 产出过剩惩罚：库存够用 1 小时以上说明这条链已经饱和 */
function surplusOf(state: GameState, res: string): number {
  const have = getRes(state, res);
  const rate = state.ratePerSec[res] ?? 0;
  if (rate <= 0) return 0;
  const secondsOfStock = have.toNumber() / rate;
  return secondsOfStock > 3600 ? 0.6 : 0;
}

/** 选择最优上游：优先同层、能供料、催化倍率最高 */
function bestUpstream(state: GameState, data: GameData, nodeId: string): string | null {
  const target = state.graph.nodes.get(nodeId);
  if (!target) return null;
  const targetParsed = data.nodes.get(target.typeId);
  if (!targetParsed) return null;
  const inputs = new Set(targetParsed.recipe.inputs.map((i) => i.res));

  let best: string | null = null;
  let bestScore = -Infinity;
  for (const other of state.graph.nodes.values()) {
    if (other.id === nodeId || !other.built) continue;
    const up = data.nodes.get(other.typeId);
    if (!up) continue;
    const sameLayer = other.layerId === target.layerId;
    const rule = data.catalystIndex.get(`${up.def.catalystTag}>${targetParsed.def.class}`);
    const matches = up.recipe.outputs.filter((o) => inputs.has(o.res)).length;
    const score = (rule?.rateMul ?? 1) + matches * 0.6 + (sameLayer ? 0.25 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = other.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 决策器

export interface StrategyContext {
  state: GameState;
  data: GameData;
  mods: ModifierSet;
  prestigeGain: S;
}

/**
 * 决策**并立即执行**（关键）：每一步都基于刚更新过的状态重新评估。
 * 早期版本先收集 N 个动作再统一执行，导致同一批次重复选同一个节点
 * （实测把 120 孢子全花在吸水菌丝上，然后永远造不出孢子囊 → 卡死）。
 */
export function decideAndAct(ctx: StrategyContext, prefs: Preferences): ActionResult[] {
  const results: ActionResult[] = [];

  // 1) 主动孢子化
  if (prefs.prestigeThreshold > 0 && S.gte(ctx.prestigeGain, S.from(prefs.prestigeThreshold))) {
    results.push({ action: { kind: 'prestige' }, ok: true });
    return results;
  }

  for (let i = 0; i < prefs.actionsPerStep; i++) {
    const action = pickOne(ctx, prefs);
    if (!action) break;
    const r = applyAction(ctx, action);
    results.push(r);
    if (!r.ok) break;
    if (action.kind === 'upgrade' || action.kind === 'tech') {
      ctx.mods = computeModifiers(ctx.state, ctx.data);
    }
  }
  return results;
}

/** 只规划不执行（调试与测试用） */
export function planOnly(ctx: StrategyContext, prefs: Preferences): SimAction[] {
  const out: SimAction[] = [];
  for (let i = 0; i < prefs.actionsPerStep; i++) {
    const a = pickOne(ctx, prefs);
    if (!a) break;
    out.push(a);
  }
  return out;
}

function costPressure(state: GameState, cost: { res: string; amount: S }[]): number {
  let pressure = 0;
  for (const c of cost) {
    const have = S.max(getRes(state, c.res), S.from(1e-9));
    const frac = Math.min(1, S.div(c.amount, have).toNumber());
    pressure += frac * frac * 2;
  }
  return pressure;
}

function countByType(state: GameState, typeId: string): number {
  let n = 0;
  for (const node of state.graph.nodes.values()) if (node.typeId === typeId) n++;
  return n;
}

export function pickOne(ctx: StrategyContext, prefs: Preferences): SimAction | null {
  const { state, data, mods } = ctx;

  // 当前已有生产者的资源集合（补链启发式）
  const producedRes = new Set<string>();
  for (const n of state.graph.nodes.values()) {
    const def = data.nodes.get(n.typeId);
    if (!def) continue;
    for (const o of def.recipe.outputs) producedRes.add(o.res);
  }

  // 战略储备（数据驱动）：某些不可再生资源必须留出"启动关键链"的预算。
  // 孢子是唯一不可再生的扩张货币，必须为「孢子囊 25 + 糖化腔 12」留余量，
  // 否则机器人会把孢子全花在采集节点上，孢子经济永远无法启动（实测卡死）。
  // 一旦该资源有了生产者，储备立即解除（不再需要保护）。
  const reserved: Record<string, S> = {};
  for (const [id, r] of data.resources) {
    if (!r.strategicReserve.isZero() && !producedRes.has(id)) reserved[id] = r.strategicReserve;
  }

  // 豁免：产出「Tier-1 补链节点所需成本资源」的节点可以动用储备。
  // 例：糖化腔产出糖，而孢子囊（孢子唯一生产者）需要糖 —— 它是在为储备目标铺路。
  const reserveTargetInputs = new Set<string>();
  for (const [, parsed] of data.nodes) {
    if (parsed.def.tier !== 1) continue;
    if (!state.unlockedLayers.includes(parsed.def.layer)) continue;
    const fixes = parsed.recipe.outputs.some((o) => !producedRes.has(o.res));
    if (!fixes) continue;
    for (const c of parsed.cost) reserveTargetInputs.add(c.res);
  }

  const invadesReserve = (cost: { res: string; amount: S }[]): boolean => {
    for (const c of cost) {
      const keep = reserved[c.res] ?? S.ZERO;
      const spendable = S.max(S.ZERO, S.sub(getRes(state, c.res), keep));
      if (S.lt(spendable, c.amount)) return true;
    }
    return false;
  };

  let bestScore = -Infinity;
  let bestAction: SimAction | null = null;

  // --- 候选 1：建造节点
  if (prefs.nodeBias > 0) {
    for (const [typeId, parsed] of data.nodes) {
      if (!isNodeUnlocked(state, data, typeId)) continue;
      const layerId = parsed.def.layer;
      if (!state.unlockedLayers.includes(layerId)) continue;
      const layer = data.layers.get(layerId);
      if (layer && state.graph.countByLayer(layerId) >= layer.nodeCap) continue;
      const cost = nodeCost(state, data, typeId, mods);
      if (!affordable(state, cost)) continue;

      const fixesChain = parsed.recipe.outputs.some((o) => !producedRes.has(o.res));
      const exempt = fixesChain && parsed.recipe.outputs.some((o) => reserveTargetInputs.has(o.res));
      // 非豁免节点不得侵占战略储备
      if (!exempt && invadesReserve(cost)) continue;

      let value = 0;
      let surplus = 0;
      let chainBonus = 0;
      for (const out of parsed.recipe.outputs) {
        const sc = scarcityOf(state, out.res);
        const magnitude = Math.log10(1 + Math.sqrt(Math.max(0, out.rate.toNumber())));
        value += (0.2 + sc * 2) * magnitude;
        surplus += surplusOf(state, out.res);
        // 必需的资源却没有任何生产者 → 这条链断了，重奖补链
        if (!producedRes.has(out.res) && sc >= 0.3) chainBonus += 2.5;
      }
      if (parsed.recipe.outputs.length === 0) value += 0.3; // 结构/枢纽节点的拓扑价值

      const classWeight = prefs.nodeClassWeight[parsed.def.class] ?? 1;
      // 重复惩罚：同类节点建得越多越不值得（避免把预算堆在同一种采集节点上）
      const repeatPenalty = countByType(state, typeId) * 0.8;
      const score =
        (value + chainBonus - costPressure(state, cost) - surplus + Math.log10(classWeight)) * prefs.nodeBias -
        repeatPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestAction = { kind: 'buildNode', typeId, layerId, autoLink: true };
      }
    }
  }

  // --- 候选 2：购买升级
  if (prefs.upgradeBias > 0) {
    for (const [id] of data.upgrades) {
      const cost = upgradeCost(state, data, id, mods);
      if (!cost || !affordable(state, cost)) continue;
      if (invadesReserve(cost)) continue;
      const def = data.upgrades.get(id)!.def;
      const magnitude = typeof def.effect.value === 'number' ? Math.abs(def.effect.value) : 0.05;
      const score =
        (Math.log10(0.05 + magnitude) * 2.5 - log10Cost(cost) * 0.45 - costPressure(state, cost) * 1.5) *
        prefs.upgradeBias;
      if (score > bestScore) {
        bestScore = score;
        bestAction = { kind: 'upgrade', id };
      }
    }
  }

  // --- 候选 3：购买科技
  if (prefs.techBias > 0) {
    for (const [id, parsed] of data.techs) {
      if (state.techs[id]) continue;
      if (parsed.def.requires.some((r) => !state.techs[r])) continue;
      const scale = Math.max(0, 1 - Math.min(0.9, mods.buildCostDiscount));
      const cost = parsed.cost.map((c) => ({ res: c.res, amount: S.mul(c.amount, scale) }));
      if (!affordable(state, cost)) continue;
      if (invadesReserve(cost)) continue;
      const branchWeight = prefs.techBranchWeight[parsed.def.branch] ?? 1;
      const score =
        (1.1 + Math.log10(branchWeight) * 1.5 - log10Cost(cost) * 0.3 - costPressure(state, cost) * 1.5) *
        prefs.techBias;
      if (score > bestScore) {
        bestScore = score;
        bestAction = { kind: 'tech', id };
      }
    }
  }

  return bestAction;
}

/** 调试：列出当前候选评分（exported 以便 sim/debug.ts 使用） */
export function scoreCandidates(
  ctx: StrategyContext,
  prefs: Preferences,
  topN = 6,
): { label: string; score: number; affordable: boolean }[] {
  const { state, data, mods } = ctx;
  const producedRes = new Set<string>();
  for (const n of state.graph.nodes.values()) {
    const def = data.nodes.get(n.typeId);
    if (def) for (const o of def.recipe.outputs) producedRes.add(o.res);
  }
  const rows: { label: string; score: number; affordable: boolean }[] = [];

  for (const [typeId, parsed] of data.nodes) {
    if (!isNodeUnlocked(state, data, typeId)) continue;
    if (!state.unlockedLayers.includes(parsed.def.layer)) continue;
    const cost = nodeCost(state, data, typeId, mods);
    const ok = affordable(state, cost);
    let value = 0;
    let chainBonus = 0;
    let surplus = 0;
    for (const out of parsed.recipe.outputs) {
      const sc = scarcityOf(state, out.res);
      value += (0.2 + sc * 2) * Math.log10(1 + Math.sqrt(Math.max(0, out.rate.toNumber())));
      surplus += surplusOf(state, out.res);
      if (!producedRes.has(out.res) && sc >= 0.3) chainBonus += 2.5;
    }
    if (parsed.recipe.outputs.length === 0) value += 0.3;
    const score =
      (value + chainBonus - costPressure(state, cost) - surplus + Math.log10(prefs.nodeClassWeight[parsed.def.class] ?? 1)) *
        prefs.nodeBias -
      countByType(state, typeId) * 0.8;
    rows.push({ label: `build ${typeId}`, score, affordable: ok });
  }
  for (const [id] of data.upgrades) {
    const cost = upgradeCost(state, data, id, mods);
    if (!cost) continue;
    const def = data.upgrades.get(id)!.def;
    const mag = typeof def.effect.value === 'number' ? Math.abs(def.effect.value) : 0.05;
    const score =
      (Math.log10(0.05 + mag) * 2.5 - log10Cost(cost) * 0.45 - costPressure(state, cost) * 1.5) * prefs.upgradeBias;
    rows.push({ label: `upgrade ${id}`, score, affordable: affordable(state, cost) });
  }

  return rows
    .filter((r) => r.affordable)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ---------------------------------------------------------------- 执行

export interface ActionResult {
  action: SimAction;
  ok: boolean;
  reason?: string;
}

export function applyAction(ctx: StrategyContext, action: SimAction): ActionResult {
  const { state, data, mods } = ctx;
  switch (action.kind) {
    case 'buildNode': {
      const r = buildNode(state, data, action.typeId, action.layerId, 0, 0, mods);
      if (!r.ok) return { action, ok: false, reason: r.reason };
      const inst = state.graph.nodes.get(r.nodeId!)!;
      inst.built = true;
      delete state.buildQueue[inst.id];
      if (action.autoLink) {
        const up = bestUpstream(state, data, inst.id);
        if (up) buildLink(state, data, up, inst.id);
      }
      return { action, ok: true };
    }
    case 'link': {
      const r = buildLink(state, data, action.from, action.to);
      return { action, ok: r.ok, reason: r.reason };
    }
    case 'upgrade': {
      const r = buyUpgrade(state, data, action.id, mods);
      return { action, ok: r.ok, reason: r.reason };
    }
    case 'tech': {
      const r = buyTech(state, data, action.id, mods);
      return { action, ok: r.ok, reason: r.reason };
    }
    case 'prestige':
      return { action, ok: true };
    default:
      return { action, ok: false, reason: 'unknown-action' };
  }
}

export { computeModifiers, sporogeneGain, getRes };
