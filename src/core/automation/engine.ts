/**
 * 六级自动化执行器。
 *
 *   tier 1 自动采集   —— 生产本来就自动化，这一级提升离线效率（数据表：tech_auto_1）
 *   tier 2 自动购买   —— 自动买入"明显划算"的升级（花费不超过库存的 25%）
 *   tier 3 自动扩建   —— 自动建造能补足当前瓶颈的节点
 *   tier 4 自动优化   —— 自动重连，提升低效节点的催化倍率
 *   tier 5 自动孢子化 —— 达到阈值自动重置
 *   tier 6 规则引擎   —— 执行玩家自定义规则（优先级高于内置逻辑）
 *
 * 所有动作都走 core/economy 的公开函数，与手动操作完全同一条代码路径。
 */

import { SciNum } from '../math/scinum.ts';
import { TILE_SIZE } from '../network/occupancy.ts';
import type { GameState } from '../state.ts';
import type { GameData, ParsedNode } from '../types.ts';
import {
  buildLink,
  buildNode,
  buyTech,
  buyUpgrade,
  canAfford,
  computeModifiers,
  isNodeUnlocked,
  nodeCatalyst,
  nodeCost,
  removeLink,
  upgradeCost,
  type ModifierSet,
} from '../economy/engine.ts';
import { checkPrestige, doPrestige, type PrestigeReport } from '../prestige/prestige.ts';
import { evaluateCondition, isReady, validateRule } from './rules.ts';
import { challengeEffects } from '../challenges/challenge-engine.ts'; // challenge-effects-import

export interface AutomationReport {
  tier: number;
  /** 本步执行的动作描述（供 UI 日志） */
  actions: string[];
  firedRules: string[];
  prestige?: PrestigeReport;
  /** 发生孢子化时返回新状态，调用方需要替换 */
  nextState?: GameState;
}

const EMPTY: AutomationReport = { tier: 0, actions: [], firedRules: [] };

/** 每步最多执行的动作数（避免自动购买把资源瞬间抽干） */
const MAX_ACTIONS_PER_STEP = 2;

export function runAutomation(
  state: GameState,
  data: GameData,
  mods: ModifierSet,
  elapsed: number,
): AutomationReport {
  const tier = mods.autoTier;
  if (tier <= 0) return { ...EMPTY };
  // 挑战 noAutomation：自动化全部失效（这是该挑战的核心压力来源）
  if (challengeEffects(state, data).noAutomation) return { ...EMPTY };

  const actions: string[] = [];
  const firedRules: string[] = [];

  // 自动化 6 级：每一级接手**一件玩家原本手动做的事**，且彼此不重叠。
  //   ① 买升级（手动点升级）
  //   ② 扩建（手动找瓶颈→摆节点）—— 建完**不连线**（孤立的节点不产出，这是可观测的代价）
  //   ③ 自动连线（手动拉线）—— 把尚未连线的节点接到最优上游
  //   ④ 自动优化（手动调拓扑）—— 重连**已连线**的节点，搜索更优催化
  //   ⑤ 自动孢子化（手动重置）
  //   ⑥ 规则引擎（手动写 IF/THEN）
  // 早期版本 tier 1 在引擎里什么都不做，而科技却叫“自动采集”（这个游戏从来没有手动采集）——
  // 名称、描述、行为三者互不相符，是这次重做的直接起因。

  // ---- tier 6：规则引擎优先（玩家的显式意图高于内置启发式）
  if (tier >= 6 && mods.unlocks.has('rule_engine')) {
    for (const rule of state.autoRules) {
      if (!rule.enabled) continue;
      if (!isReady(rule, elapsed)) continue;
      if (validateRule(rule, data) !== null) continue;
      if (!evaluateCondition(rule, state, data)) continue;

      const result = applyRuleAction(state, data, mods, rule.act);
      rule.lastFiredAt = elapsed;
      if (result.kind === 'prestige') {
        const p = doPrestige(state, data);
        firedRules.push(rule.name);
        return { tier, actions, firedRules, prestige: p.report, nextState: p.state };
      }
      if (result.ok) firedRules.push(`${rule.name}：${result.detail}`);
      else continue;
      if (firedRules.length >= MAX_ACTIONS_PER_STEP) break;
    }
  }

  // ---- tier 1：自动购买升级
  if (tier >= 1 && actions.length < MAX_ACTIONS_PER_STEP) {
    const picked = pickAffordableUpgrade(state, data, mods);
    if (picked) {
      const r = buyUpgrade(state, data, picked, mods);
      if (r.ok) actions.push(`自动购买升级：${data.upgrades.get(picked)?.def.name ?? picked}`);
    }
  }

  // ---- tier 2：自动扩建（补瓶颈节点；建完不连线 —— 连线是 tier 3 的事）
  if (tier >= 2 && actions.length < MAX_ACTIONS_PER_STEP) {
    const picked = pickBottleneckNode(state, data, mods);
    if (picked) {
      const def = data.nodes.get(picked.typeId)!;
      // 落点：优先靠近"会用它的下游节点"，让画布上的连线短、可读
      const spot = suggestSpot(state, data, picked.typeId, picked.layerId);
      const r = buildNode(state, data, picked.typeId, picked.layerId, spot.x, spot.y, mods);
      if (r.ok) {
        const inst = state.graph.nodes.get(r.nodeId!);
        if (inst) {
          inst.built = true;
          delete state.buildQueue[inst.id];
        }
        const layerName = data.layers.get(picked.layerId)?.name ?? picked.layerId;
        actions.push(`自动扩建：${def.def.name}（${layerName}，待连线）`);
      }
    }
  }

  // ---- tier 3：自动连线（给尚未连线的节点找最优上游）
  if (tier >= 3 && actions.length < MAX_ACTIONS_PER_STEP) {
    const linked = autoLinkUnlinked(state, data);
    if (linked) actions.push(`自动连线：${linked}`);
  }

  // ---- tier 4：自动优化（重连**已连线**的节点，提升催化）
  if (tier >= 4 && actions.length < MAX_ACTIONS_PER_STEP) {
    const improved = autoReconnect(state, data);
    if (improved) actions.push(`自动优化：重连 ${improved}`);
  }

  // ---- tier 5：自动孢子化
  if (tier >= 5) {
    const threshold = SciNum.from(state.autoConfig.autoPrestigeThreshold);
    const check = checkPrestige(state, data);
    if (check.allowed && !threshold.isNaN() && SciNum.gte(check.gain, threshold)) {
      const p = doPrestige(state, data);
      return { tier, actions, firedRules, prestige: p.report, nextState: p.state };
    }
  }

  return { tier, actions, firedRules };
}

// ---------------------------------------------------------------- 内置启发式

/** 挑选"花费不超过库存 25%、且效果倍率最大"的升级 */
function pickAffordableUpgrade(state: GameState, data: GameData, mods: ModifierSet): string | null {
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const [id] of data.upgrades) {
    const cost = upgradeCost(state, data, id, mods);
    if (!cost || !canAfford(state, cost)) continue;
    // 保守：单次自动购买最多花掉库存的 25%，避免自动逻辑抢走玩家的操作空间
    let tooExpensive = false;
    for (const c of cost) {
      const have = state.resources[c.res] ?? SciNum.ZERO;
      if (have.isZero() || SciNum.gt(SciNum.mul(c.amount, 4), have)) {
        tooExpensive = true;
        break;
      }
    }
    if (tooExpensive) continue;
    const def = data.upgrades.get(id)!.def;
    const magnitude = typeof def.effect.value === 'number' ? Math.abs(def.effect.value) : 0.05;
    const score = Math.log10(0.05 + magnitude) * 3 - Math.log10(Math.max(1, cost[0]!.amount.toNumber())) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

/** 找出"入库速率最低的必需资源"，并返回一个能产它的可建造节点类型 */
/**
 * 为新节点挑一个落点：靠近"会用它的下游节点"，或靠近"能喂它的上游节点"。
 *
 * 为什么在意距离：画布上的连线长度直接影响可读性 —— 把节点随手丢在 (0,0) 会让
 * 连线横跨整个画面。靠近相关节点还能让玩家的手动调整更容易。
 */
function suggestSpot(
  state: GameState,
  data: GameData,
  typeId: string,
  layerId: string,
): { x: number; y: number } {
  const def = data.nodes.get(typeId);
  if (!def) return { x: 0, y: 0 };
  const inputs = new Set(def.recipe.inputs.map((i) => i.res));
  const outputs = new Set(def.recipe.outputs.map((o) => o.res));

  let anchor: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (const node of state.graph.nodes.values()) {
    if (!node.built) continue;
    const other = data.nodes.get(node.typeId);
    if (!other) continue;
    // 它能喂我（产出是我要的输入）
    const feedsMe = other.recipe.outputs.filter((o) => inputs.has(o.res)).length;
    // 我能喂它（我的产出是它要的输入）
    const iFeed = other.recipe.inputs.filter((i) => outputs.has(i.res)).length;
    // 同层优先（同层连线看着更整齐）
    const sameLayer = node.layerId === layerId ? 0.5 : 0;
    const score = feedsMe * 2 + iFeed * 1.5 + sameLayer;
    if (score > bestScore) {
      bestScore = score;
      anchor = { x: node.x, y: node.y };
    }
  }

  if (!anchor || bestScore <= 0) return { x: 0, y: 0 };
  // 落在锚点旁边一格半的位置：够近，但不会撞上占位
  return { x: anchor.x + TILE_SIZE * 1.5, y: anchor.y + TILE_SIZE * 1.5 };
}

function pickBottleneckNode(
  state: GameState,
  data: GameData,
  mods: ModifierSet,
): { typeId: string; layerId: string } | null {
  const produced = new Set<string>();
  for (const node of state.graph.nodes.values()) {
    const def = data.nodes.get(node.typeId);
    if (def) for (const o of def.recipe.outputs) produced.add(o.res);
  }

  // 遍历"节点类型 × 可建层"的组合，而不是"节点类型"。
  //
  // 这里修掉一个明显退化：旧版本写死 `parsed.def.layer`，于是自动扩建永远把节点
  // 堆在它自己的层上 —— 而层倍率是本作最大的收益杠杆（表土层 ×1 → 深菌地幔 ×400）。
  // 玩家手动能在建造面板里选层，自动扩建却对此一无所知。
  const candidates: { typeId: string; layerId: string; score: number }[] = [];

  for (const [typeId, parsed] of data.nodes) {
    if (!isNodeUnlocked(state, data, typeId)) continue;

    // 该节点类型的基础产出强度（用于估算"建它值不值"）
    let outputWeight = 0;
    for (const out of parsed.recipe.outputs) {
      const missing = !produced.has(out.res);
      const scarcity = state.resources[out.res]?.isZero() ? 1 : 0.3;
      outputWeight += (missing ? 2 : 0.4) * scarcity;
    }
    if (parsed.recipe.outputs.length === 0) outputWeight += 0.2; // 结构节点（枢纽/镜像）

    // 同类重复惩罚：同一种节点建太多，边际收益递减
    let same = 0;
    for (const n of state.graph.nodes.values()) if (n.typeId === typeId) same++;
    outputWeight -= same * 0.5;
    if (outputWeight <= 0) continue;

    const cost = nodeCost(state, data, typeId, mods);
    if (!canAfford(state, cost)) continue;
    const costNum = cost.reduce((sum, c) => sum + c.amount.toNumber(), 0);

    // 逐个可建层评估
    for (const layer of data.layerOrder) {
      if (!state.unlockedLayers.includes(layer.id)) continue;
      if (state.graph.countByLayer(layer.id) >= layer.nodeCap) continue;
      const depthMul = Number(layer.depthMul) || 1;

      // 评分：稀缺度 × 层倍率 ÷ 成本，全部取对数以免极端值支配
      const layerBonus = 1 + Math.log10(Math.max(1, depthMul));
      const costPenalty = 1 + Math.log10(Math.max(1, costNum));
      const score = (outputWeight * layerBonus) / costPenalty;
      candidates.push({ typeId, layerId: layer.id, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best ? { typeId: best.typeId, layerId: best.layerId } : null;
}

/** 给新节点连一个最优上游（复用与模拟器一致的判据） */
/**
 * 自动连线的评分：决定"这个新节点该接谁"。
 *
 * 旧版只看 `催化倍率 + 资源匹配×0.6 + 同层×0.25`，于是会出现几种蠢事：
 *   · 把一个节点接到"催化很高但根本不产它要的原料"的上游；
 *   · 接到已经很困的节点上（上游自己都缺料）；
 *   · 接到画面另一头，连线横跨整个画布；
 *   · 接出一条环（引擎能算环，但环内的输入只能用 tick 起始快照，效率更低）。
 *
 * 新版把这些都算进去，并且**过滤掉会成环或出度已满的候选**。
 */
function scoreUpstream(
  state: GameState,
  data: GameData,
  targetId: string,
  targetDef: ParsedNode,
  candidateId: string,
): number | null {
  const cand = state.graph.nodes.get(candidateId);
  const target = state.graph.nodes.get(targetId);
  if (!cand || !target || !cand.built) return null;

  const up = data.nodes.get(cand.typeId);
  if (!up) return null;

  // ① 会成环的候选直接淘汰：环内输入只能用 tick 起始快照，等于降速
  if (wouldCreateCycle(state, candidateId, targetId)) return null;

  // ② 上游出度余量：接到已经接满的节点上只是堆线
  const outDegree = state.graph.outLinkIds(candidateId).length;
  if (outDegree >= 6) return null;

  // ③ 资源匹配：上游产出里有多少是目标要的原料
  const inputs = new Set(targetDef.recipe.inputs.map((i: { res: string }) => i.res));
  const matches = up.recipe.outputs.filter((o: { res: string }) => inputs.has(o.res)).length;

  // ④ 上游是否真的有余力（自己被停工了就别接了）
  const upstreamStalled = (state.ratePerSec[up.recipe.outputs[0]?.res ?? ''] ?? 0) <= 0 && outDegree > 0;

  // ⑤ 催化倍率
  const rule = data.catalystIndex.get(`${up.def.catalystTag}>${targetDef.def.class}`);
  const catalyst = rule?.rateMul ?? 1;

  // ⑥ 距离惩罚：同样条件下优先就近，连线短则画面可读、玩家也好手动调
  const dist = Math.hypot(cand.x - target.x, cand.y - target.y);

  const sameLayer = cand.layerId === target.layerId ? 0.3 : 0;

  const score =
    catalyst * 1.2 +
    matches * 1.5 +
    sameLayer -
    (upstreamStalled ? 0.8 : 0) -
    Math.min(1.5, dist / 600);

  return score;
}

/** candidate → target 这条边会不会形成环（target 已经能到达 candidate） */
function wouldCreateCycle(state: GameState, candidateId: string, targetId: string): boolean {
  if (candidateId === targetId) return true;
  const seen = new Set<string>();
  // 从 candidate 出发向上游/下游两向搜索是否已经能到 target
  const stack = [candidateId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const lid of state.graph.inLinkIds(cur)) {
      const l = state.graph.links.get(lid);
      if (l) stack.push(l.from);
    }
  }
  return false;
}

/** 给尚未连线的节点接上最优上游 */
function autoLinkNewNode(state: GameState, data: GameData, nodeId: string): void {
  const target = state.graph.nodes.get(nodeId);
  const targetDef = target ? data.nodes.get(target.typeId) : undefined;
  if (!target || !targetDef) return;

  let best: { id: string; score: number } | null = null;
  for (const other of state.graph.nodes.values()) {
    if (other.id === nodeId || !other.built) continue;
    const score = scoreUpstream(state, data, nodeId, targetDef, other.id);
    if (score === null) continue;
    if (!best || score > best.score) best = { id: other.id, score };
  }
  if (best) buildLink(state, data, best.id, nodeId);
}

/** 自动连线：给尚未连线的节点接上最优上游。返回被接线的节点名（无可做则 null） */
function autoLinkUnlinked(state: GameState, data: GameData): string | null {
  for (const node of state.graph.nodes.values()) {
    if (!node.built) continue;
    // 已经有入边的跳过 —— 那些属于「自动优化」的职责
    if (state.graph.inLinkIds(node.id).length > 0) continue;
    const def = data.nodes.get(node.typeId);
    if (!def) continue;
    const before = state.graph.links.size;
    autoLinkNewNode(state, data, node.id);
    if (state.graph.links.size > before) return def.def.name;
  }
  return null;
}

/** 自动重连：找出催化倍率最低的节点，尝试换一个更好的上游 */
/**
 * 自动优化：重连催化最低的节点，换一个更好的上游。
 *
 * 相比旧版的三点改进：
 *   ① **候选也走同一套评分**（复用 scoreUpstream）——旧版只比 rateMul，
 *      会挑到一个"催化高但完全不产原料"的上游，结果产量反而下降；
 *   ② **换线前后用真实催化值验收**：不是"新倍率 > 旧倍率"就动手，而是先试着换、
 *      算完新的 nodeCatalyst 再决定保留还是回滚。只在真的变好时才留下；
 *   ③ 成环与出度检查同样适用（不再把线接到已满的节点上）。
 */
function autoReconnect(state: GameState, data: GameData): string | null {
  // 找出当前催化最差的若干候选（不是只有一个），逐个尝试改进
  const ranked: { id: string; rate: number }[] = [];
  for (const node of state.graph.nodes.values()) {
    if (!node.built) continue;
    const def = data.nodes.get(node.typeId);
    if (!def || def.def.class === 'extractor') continue;
    if (state.graph.inDegree(node.id) === 0) continue;
    const cat = nodeCatalyst(state, data, node.id);
    ranked.push({ id: node.id, rate: cat.rateMul });
  }
  ranked.sort((a, b) => a.rate - b.rate);

  for (const worst of ranked.slice(0, 5)) {
    const target = state.graph.nodes.get(worst.id)!;
    const targetDef = data.nodes.get(target.typeId)!;
    const currentUpstreams = new Set(
      state.graph.inLinkIds(worst.id).map((lid) => state.graph.links.get(lid)!.from),
    );

    let best: { id: string; score: number } | null = null;
    for (const other of state.graph.nodes.values()) {
      if (other.id === worst.id || !other.built || currentUpstreams.has(other.id)) continue;
      const score = scoreUpstream(state, data, worst.id, targetDef, other.id);
      if (score === null) continue;
      if (!best || score > best.score) best = { id: other.id, score };
    }
    if (!best) continue;

    // 试着换：先记下旧入边，换完用真实催化值验收
    const oldLinks = state.graph.inLinkIds(worst.id).map((lid) => state.graph.links.get(lid)!);
    const before = nodeCatalyst(state, data, worst.id).rateMul;

    // 去掉一条现有入边再加新的，保持入边数不膨胀（否则只是在堆连线）
    if (oldLinks.length >= 4) removeLink(state, oldLinks[0]!.id);
    const r = buildLink(state, data, best.id, worst.id);
    if (!r.ok) continue;

    const after = nodeCatalyst(state, data, worst.id).rateMul;
    if (after <= before + 0.005) {
      // 没变好 → 回滚（这正是旧版缺的那一步：它只比较候选的 rateMul 就动手）
      if (r.nodeId) removeLink(state, r.nodeId);
      if (oldLinks.length >= 4 && oldLinks[0]) {
        buildLink(state, data, oldLinks[0].from, worst.id);
      }
      continue;
    }
    return `${targetDef.def.name} 催化 ${before.toFixed(2)} → ${after.toFixed(2)}`;
  }
  return null;
}

// ---------------------------------------------------------------- 规则动作

function applyRuleAction(
  state: GameState,
  data: GameData,
  mods: ModifierSet,
  act: { kind: string; target?: string; active?: boolean },
): { ok: boolean; detail: string; kind: string } {
  switch (act.kind) {
    case 'build': {
      const def = data.nodes.get(act.target ?? '');
      if (!def) return { ok: false, detail: '未知节点', kind: act.kind };
      const r = buildNode(state, data, def.def.id, def.def.layer, 0, 0, mods);
      if (!r.ok) return { ok: false, detail: r.reason ?? '', kind: act.kind };
      const inst = state.graph.nodes.get(r.nodeId!);
      if (inst) {
        inst.built = true;
        delete state.buildQueue[inst.id];
        autoLinkNewNode(state, data, inst.id);
      }
      return { ok: true, detail: `建造 ${def.def.name}`, kind: act.kind };
    }
    case 'upgrade': {
      const r = buyUpgrade(state, data, act.target ?? '', mods);
      return { ok: r.ok, detail: `升级 ${data.upgrades.get(act.target ?? '')?.def.name ?? act.target}`, kind: act.kind };
    }
    case 'tech': {
      const r = buyTech(state, data, act.target ?? '', mods);
      return { ok: r.ok, detail: `科技 ${data.techs.get(act.target ?? '')?.def.name ?? act.target}`, kind: act.kind };
    }
    case 'prestige':
      return { ok: true, detail: '孢子化', kind: 'prestige' };
    case 'setNodeActive': {
      // 停用/启用最缺料的节点（用于"缺某资源时暂停消耗"的规则）
      let target: string | null = null;
      for (const node of state.graph.nodes.values()) {
        if (node.built && node.active) {
          target = node.id;
          break;
        }
      }
      if (!target) return { ok: false, detail: '没有可操作的节点', kind: act.kind };
      const inst = state.graph.nodes.get(target)!;
      inst.active = act.active !== false;
      return { ok: true, detail: `${inst.active ? '启用' : '停用'} ${data.nodes.get(inst.typeId)?.def.name ?? inst.typeId}`, kind: act.kind };
    }
    default:
      return { ok: false, detail: '未知动作', kind: act.kind };
  }
}

/** 计算当前实际生效的自动化层级（供 UI 展示） */
export function effectiveTier(mods: ModifierSet): number {
  return Math.max(0, Math.floor(mods.autoTier));
}

export { computeModifiers };
