/**
 * 经济引擎：修饰符聚合、网络 tick 结算、以及全部"花费资源"的操作。
 *
 * 结算契约（docs/balance-model.md §1、§3）：
 *   · 每 tick 按拓扑序处理节点，上游产出在同 tick 内对下游可见；
 *   · 环内节点改用 tick 起始快照判断输入，保证确定性；
 *   · 输入不足时按比例降速（ratio），不会出现"半消耗"或负库存；
 *   · 所有产出与消耗都走 SciNum，禁止裸 number 跨数量级累加。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { CatalystRule, EffectDef, GameData, ModifierDef, NodeDef, ParsedNode } from '../types.ts';
import { findNearestFreeTile, occupiedTiles, resolvePlacement, snapToTile, tileKeyOf } from '../network/occupancy.ts';
import { applyChallengeModifiers, challengeBlocksBuild, challengeBlocksLink, challengeEffects } from '../challenges/challenge-engine.ts';
import { customRuleFor, lawBonuses } from '../meta/laws.ts';
import { tickTimeBank } from '../meta/timebank.ts';

// ---------------------------------------------------------------- 修饰符

export interface ModifierSet {
  /** 节点类型 → 产出加成（0.25 = +25%） */
  byNode: Record<string, number>;
  /** 资源 → 产出加成 */
  byRes: Record<string, number>;
  /** 节点类 → 产出加成 */
  byClass: Record<string, number>;
  /** 全局产出加成 */
  globalOutput: number;
  catalystBonus: number;
  enzymeDiscount: number;
  depletionReduce: number;
  richnessRepair: number;
  richnessFloorAdd: number;
  richnessCapMul: number;
  buildCostDiscount: number;
  buildSpeed: number;
  offlineEfficiency: number;
  critChance: number;
  critMul: number;
  linkFlux: number;
  eventResist: number;
  prestigeGain: number;
  autoTier: number;
  ruleSlots: number;
  /** 土壤枯竭速度倍率加成（1.2 = 枯竭快 120%）—— 菌株用 */
  depletionMul: number;
  /** 手动操作（连击）收益修正，负值为惩罚 —— 菌株用 */
  manualMul: number;
  /** 节点成本增长率加值（0.03 = 增长率 +0.03）—— 菌株用 */
  costGrowthAdd: number;
  /**
   * 全局产出**乘性**倍率（默认 1）。
   * 与 globalOutput（加性）并存的原因：数据表里有 `global.allProductionMul` 这类
   * "整个网络×1.1"的结构性效果，乘法与加法在后期相差数个数量级。
   */
  globalOutputMul: number;
  /** 节点类型 → 额外产出加成（来自镜像节点这类"影响邻居"的结构性效果） */
  mirroredNodes: Record<string, number>;
  /** 解锁标记（upgrade / tech 的 unlock 值） */
  unlocks: Set<string>;
  /** 需要引擎特殊处理的菌株开关（见 strains.json 的 specialKinds） */
  specials: Set<string>;
}

function emptyModifiers(): ModifierSet {
  return {
    byNode: {},
    byRes: {},
    byClass: {},
    globalOutput: 0,
    catalystBonus: 0,
    enzymeDiscount: 0,
    depletionReduce: 0,
    richnessRepair: 0,
    richnessFloorAdd: 0,
    richnessCapMul: 0,
    buildCostDiscount: 0,
    buildSpeed: 0,
    offlineEfficiency: 0,
    critChance: 0,
    critMul: 0,
    linkFlux: 0,
    eventResist: 0,
    prestigeGain: 0,
    autoTier: 0,
    ruleSlots: 0,
    depletionMul: 0,
    manualMul: 0,
    costGrowthAdd: 0,
    globalOutputMul: 1,
    mirroredNodes: {},
    unlocks: new Set<string>(),
    specials: new Set<string>(),
  };
}

function applyEffect(m: ModifierSet, e: EffectDef, level: number): void {
  const v = typeof e.value === 'number' ? e.value : 0;
  switch (e.kind) {
    case 'outputMul':
      if (e.node) m.byNode[e.node] = (m.byNode[e.node] ?? 0) + v * level;
      else if (e.res) m.byRes[e.res] = (m.byRes[e.res] ?? 0) + v * level;
      else if (e.class) m.byClass[e.class] = (m.byClass[e.class] ?? 0) + v * level;
      else m.globalOutput += v * level;
      break;
    case 'catalystBonus':
      m.catalystBonus += v * level;
      break;
    case 'enzymeDiscount':
    case 'inputDiscount':
      m.enzymeDiscount += v * level;
      break;
    case 'depletionReduce':
      m.depletionReduce += v * level;
      break;
    case 'richnessRepair':
      m.richnessRepair += v * level;
      break;
    case 'richnessFloor':
      m.richnessFloorAdd += v * level;
      break;
    case 'richnessCap':
      m.richnessCapMul += v * level;
      break;
    case 'buildCostDiscount':
      m.buildCostDiscount += v * level;
      break;
    case 'buildSpeed':
      m.buildSpeed += v * level;
      break;
    case 'offlineEfficiency':
      m.offlineEfficiency += v * level;
      break;
    case 'critChance':
      m.critChance += v * level;
      break;
    case 'critMul':
      m.critMul += v * level;
      break;
    case 'linkFlux':
      m.linkFlux += v * level;
      break;
    case 'eventResist':
      m.eventResist += v * level;
      break;
    case 'prestigeGain':
      m.prestigeGain += v * level;
      break;
    case 'autoTier':
      m.autoTier = Math.max(m.autoTier, v);
      break;
    case 'ruleSlot':
      m.ruleSlots += v * level;
      break;
    case 'depletionMul':
      m.depletionMul += v * level;
      break;
    case 'manualMul':
      m.manualMul += v * level;
      break;
    case 'costGrowthAdd':
      m.costGrowthAdd += v * level;
      break;
    case 'unlock':
      if (typeof e.value === 'string') m.unlocks.add(e.value);
      break;
    default:
      // growth / eventResist 等未实现的效果保持静默，由校验器保证词表收敛
      break;
  }
}

/** 聚合升级 + 科技 + 成就 + 菌株带来的全部修饰符 */
export function computeModifiers(state: GameState, data: GameData): ModifierSet {
  const m = emptyModifiers();

  for (const [id, level] of Object.entries(state.upgrades)) {
    if (level <= 0) continue;
    const up = data.upgrades.get(id);
    if (!up) continue;
    applyEffect(m, up.def.effect, level);
  }
  for (const id of Object.keys(state.techs)) {
    const t = data.techs.get(id);
    if (!t) continue;
    applyEffect(m, t.def.effect, 1);
  }
  for (const id of Object.keys(state.achievements)) {
    const a = data.achievements.get(id);
    if (!a?.effect) continue;
    applyEffect(m, a.effect, 1);
  }
  // 任务奖励带来的永久加成
  for (const e of state.questBonuses) applyEffect(m, e, 1);

  // 菌株（PHASE 4 批次 C）：走数据表驱动，不再硬编码 if。
  // 顺序很重要：drawbacks 先应用，effects 后 —— 这样同名 kind 的正负会在
  // 同一累加器里相加（例如织网：effects 给 linkFlux +0.5，drawbacks 给
  // extractor -0.25），不会被后写入的那一方整体覆盖。
  const strainDef = state.prestige.strain ? data.strains.get(state.prestige.strain)?.def : undefined;
  if (strainDef) {
    for (const e of strainDef.drawbacks) applyEffect(m, e, 1);
    for (const e of strainDef.effects) applyEffect(m, e, 1);
    for (const sp of strainDef.specials) m.specials.add(sp);

    // specials 中需要改修饰符的部分在这里落地（其余在 engine 的行为分支里）
    if (m.specials.has('offline_cap_24h')) {
      // 离线上限翻倍由 offline 模块读 config 的副本实现，这里只标注开关；
      // 具体倍率通过 offlineEfficiency 与 offline 模块的 specials 检查生效。
    }
    if (m.specials.has('topology_bonus')) {
      // 织网：每 10 条连线全局 +8%（用连线数而非节点数，才能奖励“多连”而非“多造”）
      const links = state.graph.links.size;
      m.globalOutput += 0.08 * Math.floor(links / 10);
    }
  }

  // 孢子基因的全局加成。
  // PHASE 4 会用基因树（可点选的机制节点）取代它；在此之前，这是让「孢子化循环」
  // 成立的唯一增益来源 —— 没有它，重置后的第二局与第一局完全一样慢，Prestige 就是假机制。
  // 曲线刻意用对数：线性/幂次加成会让孢子基因指数膨胀，导致「重置→立刻再重置」的刷分循环。
  const sp = state.prestige.sporogene.toNumber();
  if (Number.isFinite(sp) && sp > 0) m.globalOutput += 0.6 * Math.log10(1 + sp);

  // Prestige 层级带来的机制性加成。
  // 层级不是"更大的数字"，而是"多一条可用的规则" —— P3 虫巢意识让网络第一次有了中心，
  // 表现就是自动化规则槽 +2（配合 hive 枢纽节点，玩家可以写出更复杂的 IF/THEN）。
  if (state.prestige.level >= 3) m.ruleSlots += 2;

  // 生态法则（Meta 层）：改的是曲线本身 —— 成本增长率、土壤恢复、催化放大。
  // 与升级的区别在于它们是"公式级"的，所以必须在这里并入同一套修饰符，
  // 再由各系统读取（这样模拟器与浏览器不会各算一套）。
  {
    const law = lawBonuses(state, data);
    for (const [res, v] of Object.entries(law.byRes)) m.byRes[res] = (m.byRes[res] ?? 0) + v;
    m.catalystBonus += law.catalystBonus;
    m.richnessRepair += law.richnessRepair;
    m.costGrowthAdd -= law.costGrowthCut;
  }

  // 结构性效果（数据表用 structural / global 描述"它影响的是网络结构，而不是它自己的产出"）。
  // mirror_node：「它不生产任何东西，只是让邻居的生产发生两次」—— 表现为邻居获得产出加成；
  // hive_hub：整张网络的乘性倍率。
  for (const node of state.graph.nodes.values()) {
    if (!node.built) continue;
    const def = data.nodes.get(node.typeId);
    if (!def) continue;

    const mirror = def.recipe.structural?.mirrorAdjacent;
    if (mirror && mirror > 0) {
      for (const linkId of state.graph.outLinkIds(node.id)) {
        const link = state.graph.links.get(linkId);
        if (!link) continue;
        const neighbour = state.graph.nodes.get(link.to);
        if (!neighbour) continue;
        m.mirroredNodes[neighbour.typeId] = (m.mirroredNodes[neighbour.typeId] ?? 0) + mirror;
      }
    }

    const globalAll = def.recipe.global?.allProductionMul;
    if (globalAll && globalAll > 0) m.globalOutputMul *= globalAll;
  }

  // 挑战对规则的改写（禁类/禁资源/成本曲线/枯竭速度/产出惩罚）。
  // 放在最后是有意的：挑战必须能压过升级与科技带来的加成，否则"限制"形同虚设。
  applyChallengeModifiers(state, data, m);

  // 事件修正（负值为惩罚）
  for (const ev of state.activeEvents) {
    const def = data.events.find((e) => e.id === ev.eventId);
    if (!def) continue;
    const resist = Math.min(0.6, m.eventResist);
    for (const mod of def.modifiers) applyEventModifier(m, mod, ev.strength * (1 - resist));
  }

  return m;
}

function applyEventModifier(m: ModifierSet, mod: ModifierDef, strength: number): void {
  const raw = typeof mod.value === 'number' ? mod.value : 0;
  const v = raw * strength;
  switch (mod.kind) {
    case 'outputMul':
      if (mod.res) m.byRes[mod.res] = (m.byRes[mod.res] ?? 0) + v;
      else if (mod.class) m.byClass[mod.class] = (m.byClass[mod.class] ?? 0) + v;
      else m.globalOutput += v;
      break;
    case 'catalystTempBonus':
      m.catalystBonus += v;
      break;
    case 'buildSpeedMul':
      m.buildSpeed -= v;
      break;
    case 'inputMul':
      m.enzymeDiscount -= v;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 催化

export interface NodeCatalyst {
  rateMul: number;
  enzymeMul: number;
  stability: number;
  inDegree: number;
  bestRule: CatalystRule | null;
}

/**
 * 查催化规则。**派生索引的重建点**：法则「矩阵律」改写了某条规则时，
 * 在这里叠加覆盖值 —— 不修改 data.catalystIndex 本身（那是全局共享的，
 * 改了会污染其它存档），而是每次读取时现算，等价于"读时重建派生索引"。
 */
function lookupRule(state: GameState, data: GameData, tag: string, cls: string): CatalystRule | null {
  const exact = data.catalystIndex.get(`${tag}>${cls}`);
  const rule = exact ?? data.catalystIndex.get(`${tag}>*`) ?? null;
  if (!rule) return null;

  // 玩家自定义的催化规则优先级最高：他亲手写的那条应该说了算
  const custom = customRuleFor(state, tag, cls);
  if (custom !== null) return { ...rule, rateMul: custom };

  const overrides = lawBonuses(state, data).matrixOverrides;
  for (const key of [`${tag}>${cls}`, `${tag}>*`]) {
    const v = overrides[key];
    if (typeof v === 'number') return { ...rule, rateMul: v };
  }
  return rule;
}

/** 计算某节点的催化修饰：取全部入边中最优规则，再叠加入边数边际收益 */
export function nodeCatalyst(state: GameState, data: GameData, nodeId: string): NodeCatalyst {
  const links = state.graph.inLinkIds(nodeId);
  const downstream = state.graph.nodes.get(nodeId);
  if (!downstream) return { rateMul: 1, enzymeMul: 1, stability: 0, inDegree: 0, bestRule: null };
  const downstreamClass = data.nodes.get(downstream.typeId)?.def.class ?? 'metabolizer';

  let best: CatalystRule | null = null;
  let bestDiscount = 0;
  let stability = 0;
  for (const lid of links) {
    const l = state.graph.links.get(lid)!;
    const up = state.graph.nodes.get(l.from);
    if (!up) continue;
    const upTag = data.nodes.get(up.typeId)?.def.catalystTag ?? '*';
    const rule = lookupRule(state, data, upTag, downstreamClass);
    if (!rule) continue;
    if (!best || rule.rateMul > best.rateMul) best = rule;
    bestDiscount = Math.max(bestDiscount, rule.enzymeDiscount);
    stability += rule.stability;
  }

  const inDegree = links.length;
  const degreeBonus = inDegree > 1 ? Math.min(1 + 0.02 * (inDegree - 1), 1.2) : 1;
  const rateMul = best ? best.rateMul * degreeBonus : 1;
  const enzymeMul = best && best.enzymeDiscount > 0 ? 1 - bestDiscount : 1;
  return { rateMul, enzymeMul, stability, inDegree, bestRule: best };
}

// ---------------------------------------------------------------- 资源辅助

export function getRes(state: GameState, id: string): SciNum {
  return state.resources[id] ?? SciNum.ZERO;
}

function addRes(state: GameState, data: GameData, id: string, amount: SciNum): void {
  if (amount.isZero()) return;
  if (!amount.isFinite()) throw new Error(`engine: 产出非法数值 res=${id} value=${amount.toString()}`);
  if (amount.isNegative()) throw new Error(`engine: 产出为负 res=${id} value=${amount.toString()}`);
  const cur = state.resources[id] ?? SciNum.ZERO;
  let next = SciNum.add(cur, amount);
  const cap = data.resources.get(id)?.cap ?? null;
  if (cap && SciNum.gt(next, cap)) next = cap;
  state.resources[id] = next;
  state.totalProduced[id] = SciNum.add(state.totalProduced[id] ?? SciNum.ZERO, amount);
}

export function canAfford(state: GameState, cost: { res: string; amount: SciNum }[]): boolean {
  for (const c of cost) if (SciNum.lt(state.resources[c.res] ?? SciNum.ZERO, c.amount)) return false;
  return true;
}

export function spendCost(state: GameState, cost: { res: string; amount: SciNum }[]): void {
  for (const c of cost) {
    const cur = state.resources[c.res] ?? SciNum.ZERO;
    const next = SciNum.sub(cur, c.amount);
    if (next.isNegative()) throw new Error(`engine: 扣费后为负 res=${c.res}`);
    state.resources[c.res] = next;
  }
}

// ---------------------------------------------------------------- 建造

function countBuiltOfType(state: GameState, typeId: string): number {
  let n = 0;
  for (const node of state.graph.nodes.values()) if (node.typeId === typeId) n++;
  return n;
}

/** 节点成本：baseCost × costGrowth^已建数量 × (1 - 折扣) */
export function nodeCost(state: GameState, data: GameData, typeId: string, mods: ModifierSet): { res: string; amount: SciNum }[] {
  const node = data.nodes.get(typeId);
  if (!node) throw new Error(`engine: 未知节点类型 ${typeId}`);
  const n = countBuiltOfType(state, typeId);
  const discount = Math.max(0.1, 1 - Math.min(0.9, mods.buildCostDiscount));
  // 菌株可以改写成本曲线本身（催化菌株：增长率 +0.03），而不是只给折扣
  const growth = Math.max(1.01, node.costGrowth + mods.costGrowthAdd);
  const scale = Math.pow(growth, n) * discount;
  return node.cost.map((c) => ({ res: c.res, amount: SciNum.mul(c.amount, scale) }));
}

export function isNodeUnlocked(state: GameState, data: GameData, typeId: string): boolean {
  const node = data.nodes.get(typeId);
  if (!node) return false;
  const u = node.def.unlock;
  switch (u.type) {
    case 'start':
      return true;
    case 'layer':
      return u.layer !== undefined && state.unlockedLayers.includes(u.layer);
    case 'resource':
      return u.resource !== undefined && SciNum.gte(state.totalProduced[u.resource] ?? SciNum.ZERO, SciNum.from(u.amount ?? '0'));
    case 'tech':
      return u.id !== undefined && state.techs[u.id] === true;
    case 'prestige':
      return state.prestige.level >= (u.level ?? 1);
    case 'quest':
      return true;
    default:
      return false;
  }
}

export interface BuildResult {
  ok: boolean;
  reason?: string;
  nodeId?: string;
  /** 人类可读的失败细节（挑战限制之类需要具体说明原因） */
  detail?: string;
}

export function buildNode(
  state: GameState,
  data: GameData,
  typeId: string,
  layerId: string,
  x: number,
  y: number,
  mods: ModifierSet,
): BuildResult {
  const node = data.nodes.get(typeId);
  if (!node) return { ok: false, reason: 'unknown-type' };
  if (!state.unlockedLayers.includes(layerId)) return { ok: false, reason: 'layer-locked' };
  if (!isNodeUnlocked(state, data, typeId)) return { ok: false, reason: 'locked' };  // 挑战限制（禁类 / 只允许某层 / 节点总数上限）
  {
    const blocked = challengeBlocksBuild(state, data, typeId, node.def.class, layerId);
    if (blocked) return { ok: false, reason: 'challenge', detail: blocked };
  }
  const layer = data.layers.get(layerId);
  if (layer && state.graph.countByLayer(layerId) >= layer.nodeCap) return { ok: false, reason: 'layer-cap' };

  const cost = nodeCost(state, data, typeId, mods);
  if (!canAfford(state, cost)) return { ok: false, reason: 'cost' };

  // 反馈 #6：节点吸附到网格且不重叠。落点被占用时自动移位到最近空格（UI 会预先高亮真实落点）
  const placement = resolvePlacement(state, x, y);
  if (!placement) return { ok: false, reason: 'occupied' };
  spendCost(state, cost);

  const id = `n${state.seq.node++}`;
  const richness = layer?.richnessBase ?? 60;
  state.graph.addNode({
    id,
    typeId,
    layerId,
    x: placement.tile.x,
    y: placement.tile.y,
    active: true,
    built: node.buildTime <= 0 || mods.buildSpeed >= 1,
    richness,
    rotationSwaps: 0,
  });
  if (!state.graph.nodes.get(id)!.built) {
    state.buildQueue[id] = state.elapsed + Math.max(0, node.buildTime * (1 - Math.min(0.95, mods.buildSpeed)));
  }
  state.stats.nodesBuilt++;
  state.topoDirty = true;
  return { ok: true, nodeId: id };
}

export function buildLink(state: GameState, data: GameData, from: string, to: string): BuildResult {
  if (!state.graph.nodes.has(from) || !state.graph.nodes.has(to)) return { ok: false, reason: 'missing-node' };
  if (from === to) return { ok: false, reason: 'self-link' };  // 挑战限制（连线总数 / 出度上限）
  {
    const blocked = challengeBlocksLink(state, data, from);
    if (blocked) return { ok: false, reason: 'challenge', detail: blocked };
  }
  for (const lid of state.graph.inLinkIds(to)) {
    if (state.graph.links.get(lid)!.from === from) return { ok: false, reason: 'duplicate' };
  }
  const id = `l${state.seq.link++}`;
  state.graph.addLink({ id, from, to, fluxCap: '0' });
  state.stats.linksBuilt++;
  state.topoDirty = true;
  return { ok: true, nodeId: id };
}

export function removeLink(state: GameState, linkId: string): void {
  state.graph.removeLink(linkId);
  state.topoDirty = true;
}

/**
 * 移动已有节点（反馈 #5：放置后要能挪位置）。
 * 与建造共用同一套占位规则：吸附到网格；目标格被占用时自动移位到最近空格。
 * 注意计算占位时要**先把自己排除**，否则节点会"占着自己的格子"而无法原地微调。
 */
export function moveNode(state: GameState, nodeId: string, x: number, y: number): { ok: boolean; reason?: string; shifted?: boolean } {
  const node = state.graph.nodes.get(nodeId);
  if (!node) return { ok: false, reason: 'missing-node' };

  const occupied = occupiedTiles(state);
  const selfTile = snapToTile(node.x, node.y);
  occupied.delete(tileKeyOf(selfTile.x, selfTile.y));

  const snapped = snapToTile(x, y);
  const targetKey = tileKeyOf(snapped.x, snapped.y);
  if (!occupied.has(targetKey)) {
    node.x = snapped.x;
    node.y = snapped.y;
    state.topoDirty = true;
    return { ok: true, shifted: false };
  }
  const free = findNearestFreeTile(occupied, snapped.x, snapped.y);
  if (!free) return { ok: false, reason: 'occupied' };
  node.x = free.x;
  node.y = free.y;
  state.topoDirty = true;
  return { ok: true, shifted: true };
}

export function removeNode(state: GameState, nodeId: string): void {
  state.graph.removeNode(nodeId);
  delete state.buildQueue[nodeId];
  state.topoDirty = true;
}

/**
 * 拆除节点（反馈 #5）：返还**基础成本**的 50%，并连带断开所有连线。
 *
 * 为什么返还基础成本而不是"当前递增成本"：成本按已建数量递增（base × growth^n）。
 * 若按当前成本返还，玩家可以"建到很贵 → 拆掉 → 拿回大笔资源"，
 * 而拆除会让 n 变小、重建更便宜 —— 这会变成刷资源漏洞。
 * 按基础成本的 50% 返还，配合"拆除后重建仍需付全额递增成本"，全程净亏，无法套利。
 */
export function demolishNode(
  state: GameState,
  data: GameData,
  nodeId: string,
): { ok: boolean; refund: { res: string; amount: SciNum }[]; reason?: string } {
  const node = state.graph.nodes.get(nodeId);
  if (!node) return { ok: false, refund: [], reason: 'missing-node' };
  const def = data.nodes.get(node.typeId);
  const refund = def
    ? def.cost.map((c) => ({ res: c.res, amount: SciNum.mul(c.amount, 0.5) }))
    : [];
  for (const r of refund) {
    state.resources[r.res] = SciNum.add(state.resources[r.res] ?? SciNum.ZERO, r.amount);
  }
  removeNode(state, nodeId);
  return { ok: true, refund };
}

/** 断开某条连线（UI 删除连线用） */
export function demolishLink(state: GameState, linkId: string): boolean {
  if (!state.graph.links.has(linkId)) return false;
  removeLink(state, linkId);
  return true;
}

// ---------------------------------------------------------------- 购买

export function upgradeCost(state: GameState, data: GameData, id: string, mods: ModifierSet): { res: string; amount: SciNum }[] | null {
  const up = data.upgrades.get(id);
  if (!up) return null;
  const level = state.upgrades[id] ?? 0;
  if (level >= up.def.maxLevel) return null;
  const scale = Math.pow(up.def.growth, level) * Math.max(0, 1 - Math.min(0.9, mods.buildCostDiscount));
  return up.cost.map((c) => ({ res: c.res, amount: SciNum.mul(c.amount, scale) }));
}

export function buyUpgrade(state: GameState, data: GameData, id: string, mods: ModifierSet): BuildResult {
  const cost = upgradeCost(state, data, id, mods);
  if (!cost) return { ok: false, reason: 'maxed' };
  if (!canAfford(state, cost)) return { ok: false, reason: 'cost' };
  spendCost(state, cost);
  state.upgrades[id] = (state.upgrades[id] ?? 0) + 1;
  state.stats.upgradesBought++;
  return { ok: true };
}

export function buyTech(state: GameState, data: GameData, id: string, mods: ModifierSet): BuildResult {
  const tech = data.techs.get(id);
  if (!tech) return { ok: false, reason: 'unknown' };
  if (state.techs[id]) return { ok: false, reason: 'owned' };
  for (const req of tech.def.requires) if (!state.techs[req]) return { ok: false, reason: 'prereq' };
  const scale = Math.max(0, 1 - Math.min(0.9, mods.buildCostDiscount));
  const cost = tech.cost.map((c) => ({ res: c.res, amount: SciNum.mul(c.amount, scale) }));
  if (!canAfford(state, cost)) return { ok: false, reason: 'cost' };
  spendCost(state, cost);
  state.techs[id] = true;
  state.stats.techsUnlocked++;
  return { ok: true };
}

// ---------------------------------------------------------------- tick 结算

export interface TickReport {
  dt: number;
  /** 本 tick 各资源的净产出（UI 增量显示） */
  produced: Record<string, SciNum>;
  /** 节点 ID → 运行比例（< 1 表示缺料降速，0 表示完全停工） */
  throttled: Record<string, number>;
  activeNodes: number;
  unlockedLayers: string[];
}

export interface TickOptions {
  /** 提供时进行真实暴击判定（可复现）；不提供则使用期望值 */
  rng?: () => number;
  /** 使用外部修饰符集合（避免每次重算） */
  mods?: ModifierSet;
}

export function tick(state: GameState, data: GameData, dt: number, opts: TickOptions = {}): TickReport {
  if (!Number.isFinite(dt) || dt <= 0) throw new Error(`engine: 非法 dt ${dt}`);
  const m = opts.mods ?? computeModifiers(state, data);
  const sdt = SciNum.from(dt);
  const cfg = data.config;
  // 挑战效果在 tick 开头取一次：整帧内保持一致，避免中途状态变化导致"半帧两套规则"
  const fx = challengeEffects(state, data);

  state.elapsed += dt;
  state.tick++;

  // 建造队列
  for (const [nodeId, readyAt] of Object.entries(state.buildQueue)) {
    if (state.elapsed >= readyAt) {
      const inst = state.graph.nodes.get(nodeId);
      if (inst) inst.built = true;
      delete state.buildQueue[nodeId];
    }
  }

  // 事件过期
  if (state.activeEvents.length > 0) {
    state.activeEvents = state.activeEvents.filter((e) => e.endsAt > state.elapsed);
  }

  // soil：修复与富饶度上下限
  for (const node of state.graph.nodes.values()) {
    const layer = data.layers.get(node.layerId);
    if (!layer) continue;
    const cap = layer.richnessBase * (1 + m.richnessCapMul);
    const floor = layer.richnessFloor * (1 + m.richnessFloorAdd / 100);
    if (m.richnessRepair > 0) node.richness = Math.min(cap, node.richness + m.richnessRepair * dt);
    if (node.richness > cap) node.richness = cap;
    if (node.richness < floor) node.richness = floor;
  }

  // ---- 挑战的每 tick 效果（GDD §30：挑战改写的是规则本身）
  {
    if (fx.activeId) {
      // 用 tick 数与挑战种子派生确定性随机：同一存档重放结果一致
      const seedBase = (state.challenges.runtime?.seed ?? 1) ^ (state.tick * 2654435761);
      let s = seedBase >>> 0;
      const rand = (): number => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // 土壤上限/下限被改写
      if (fx.richnessCapMul !== null || fx.richnessFloorMul !== null) {
        for (const node of state.graph.nodes.values()) {
          const layer = data.layers.get(node.layerId);
          if (!layer) continue;
          const cap = fx.richnessCapMul !== null ? layer.richnessBase * fx.richnessCapMul : layer.richnessBase;
          const floor = fx.richnessFloorMul !== null ? layer.richnessBase * fx.richnessFloorMul : layer.richnessFloor;
          if (node.richness > cap) node.richness = cap;
          if (node.richness < floor) node.richness = floor;
        }
      }

      // 富饶度波动：让"土壤是活的"这条感受在挑战里被放大
      if (fx.richnessSimmer) {
        for (const node of state.graph.nodes.values()) {
          node.richness += (rand() - 0.5) * 2 * dt;
        }
      }

      // 节点凋亡：每秒 N% 概率（按 dt 折算成期望次数，避免高 dt 下概率失真）
      if (fx.nodeDecayPerSec > 0) {
        const expected = fx.nodeDecayPerSec * dt;
        const whole = Math.floor(expected + (rand() < expected % 1 ? 1 : 0));
        for (let i = 0; i < whole; i++) {
          const list = [...state.graph.nodes.values()].filter((n) => n.built);
          if (list.length === 0) break;
          const victim = list[Math.floor(rand() * list.length)]!;
          state.graph.nodes.delete(victim.id);
        }
      }

      // 资源被偷：每秒概率，偷走当前持有的一定比例
      if (fx.theftChancePerSec > 0) {
        const expected = fx.theftChancePerSec * dt;
        if (rand() < expected) {
          const rt = state.challenges.runtime;
          for (const key of ['sugar', 'enzyme', 'honeydew', 'sclerotium'] as const) {
            const cur = state.resources[key] ?? SciNum.ZERO;
            if (!cur.isPositive()) continue;
            const lost = SciNum.mul(cur, 0.05);
            state.resources[key] = SciNum.sub(cur, lost);
            if (rt) rt.stolen = SciNum.add(rt.stolen, lost);
          }
        }
      }

      // 随机重连：把一条边的终点换到另一个节点
      if (fx.relinkEverySec !== null && fx.relinkEverySec > 0) {
        const rt = state.challenges.runtime;
        const due = rt ? state.elapsed - rt.startedAt >= (rt.relinked + 1) * fx.relinkEverySec : false;
        if (due && rt && state.graph.links.size > 0) {
          const links = [...state.graph.links.values()];
          const link = links[Math.floor(rand() * links.length)]!;
          const candidates = [...state.graph.nodes.values()].filter((n) => n.id !== link.from && n.id !== link.to);
          if (candidates.length > 0) {
            const target = candidates[Math.floor(rand() * candidates.length)]!;
            state.graph.links.delete(link.id);
            state.graph.links.set(link.id, { ...link, to: target.id });
            rt.relinked++;
          }
        }
      }

      // 矩阵洗牌：把一条催化规则的倍率随机改动（并留下记录供 UI 显示）
      if (fx.shuffleEverySec !== null && fx.shuffleEverySec > 0) {
        const rt = state.challenges.runtime;
        const due = rt ? state.elapsed - rt.startedAt >= (rt.shuffled + 1) * fx.shuffleEverySec : false;
        if (due && rt) {
          const keys = [...data.catalystIndex.keys()];
          if (keys.length > 0) {
            const key = keys[Math.floor(rand() * keys.length)]!;
            const cur = data.catalystIndex.get(key)!;
            data.catalystIndex.set(key, { ...cur, rateMul: 0.5 + rand() * 1.5 });
            rt.shuffled++;
          }
        }
      }
    }
  }

  // 层解锁
  const unlockedLayers: string[] = [];
  for (const layer of data.layerOrder) {
    if (state.unlockedLayers.includes(layer.id)) continue;
    const u = layer.unlock;
    let ok = false;
    if (u.type === 'start') ok = true;
    else if (u.type === 'resource' && u.resource) {
      // 解锁条件看"曾经拥有过"：即累计产出与当前持有取较大者。
      // 早期只用 totalProduced，于是"由奖励直接发放"的资源（如贫瘠世界掉落的虚空孢子）
      // 永远无法解锁对应层 —— 玩家拿到了钥匙却打不开门。
      const produced = state.totalProduced[u.resource] ?? SciNum.ZERO;
      const held = state.resources[u.resource] ?? SciNum.ZERO;
      const have = SciNum.gt(held, produced) ? held : produced;
      ok = SciNum.gte(have, SciNum.from(u.amount ?? '0'));
    }
    if (ok) {
      state.unlockedLayers.push(layer.id);
      unlockedLayers.push(layer.id);
    }
  }

  // 节点结算
  const { order, cyclic } = state.graph.topoOrder();
  const tickStart: Record<string, SciNum> = {};
  for (const id of Object.keys(state.resources)) tickStart[id] = state.resources[id]!;

  const produced: Record<string, SciNum> = {};
  const throttled: Record<string, number> = {};
  const critExpected = 1 + m.critChance * (m.critMul > 0 ? m.critMul : 0);
  const comboMul = 1 + cfg.combo.perStackBonus * Math.min(state.combo.stacks, cfg.combo.maxStack) * (1 + m.manualMul);
  let activeNodes = 0;

  for (const nodeId of order) {
    const inst = state.graph.nodes.get(nodeId);
    if (!inst || !inst.built || !inst.active) continue;
    const type = data.nodes.get(inst.typeId);
    const layer = data.layers.get(inst.layerId);
    if (!type || !layer) continue;
    activeNodes++;

    const cat = nodeCatalyst(state, data, nodeId);
    const depthMul = SciNum.from(layer.depthMul).toNumber();
    // 富饶度按「该层的基准值」归一化：满富饶的浅层地块 = 100% 产出，
    // 否则表土层（base 70）会让玩家从第一秒起就永远看不到满产。
    const layerBase = layer.richnessBase > 0 ? layer.richnessBase : 100;
    const soilRatio = Math.min(1, Math.max(0, inst.richness / layerBase));
    const soilMul = cfg.soil.richnessMulFloor + (1 - cfg.soil.richnessMulFloor) * soilRatio;
    const catalystMul = (cat.bestRule ? cat.rateMul : 1) + m.catalystBonus;
    const catCalls = cat.bestRule ? 1 : 0;
    if (catCalls > 0) state.stats.catalystUses++;

    const nodeMul =
      (1 + m.globalOutput + (m.byNode[inst.typeId] ?? 0) + (m.byClass[type.def.class] ?? 0) + (m.mirroredNodes[inst.typeId] ?? 0)) *
      catalystMul *
      depthMul *
      soilMul *
      comboMul *
      critExpected *
      m.globalOutputMul;

    // 挑战 reverseRecipes：把输入与输出对调 —— 采集类因此变成"把资源压回土里"的怪东西，
    // 这正是该挑战想要的手感（你必须重新规划整条链，而不是照旧铺一遍）。
    const recipe = fx.reverseRecipes
      ? {
          ...type.recipe,
          inputs: type.recipe.outputs.map((o) => ({ res: o.res, rate: o.rate })),
          outputs: type.recipe.inputs.map((i) => ({ res: i.res, rate: i.rate })),
        }
      : type.recipe;

    const isExtractor = type.def.class === 'extractor';

    if (isExtractor) {
      for (const out of recipe.outputs) {
        const resMul = 1 + (m.byRes[out.res] ?? 0);
        const gain = SciNum.mul(SciNum.mul(out.rate, sdt), nodeMul * resMul);
        addRes(state, data, out.res, gain);
        produced[out.res] = SciNum.add(produced[out.res] ?? SciNum.ZERO, gain);
      }
      if (recipe.depletion > 0) {
        // 菌株可以改写土壤枯竭速度（腐生：×2.2）
        const dmg = recipe.depletion * dt * (1 + m.depletionMul) * (1 - Math.min(0.95, m.depletionReduce));
        inst.richness = Math.max(layer.richnessFloor, inst.richness - dmg);
      }
      continue;
    }

    // 配方节点：先算可行性比例
    const snapshot = cyclic.has(nodeId) ? tickStart : state.resources;
    let ratio = 1;
    const needs: { res: string; amount: SciNum }[] = [];
    for (const inp of recipe.inputs) {
      const need = SciNum.mul(inp.rate, sdt);
      needs.push({ res: inp.res, amount: need });
      const have = snapshot[inp.res] ?? SciNum.ZERO;
      if (SciNum.lt(have, need)) ratio = Math.min(ratio, need.isZero() ? 1 : SciNum.div(have, need).toNumber());
    }
    if (!recipe.enzymePerSec.isZero()) {
      const enzymeMul = 1 - Math.min(0.8, Math.max(0, m.enzymeDiscount + (1 - cat.enzymeMul)));
      const need = SciNum.mul(SciNum.mul(recipe.enzymePerSec, sdt), enzymeMul);
      if (!need.isZero()) {
        needs.push({ res: 'enzyme', amount: need });
        const have = snapshot['enzyme'] ?? SciNum.ZERO;
        if (SciNum.lt(have, need)) ratio = Math.min(ratio, SciNum.div(have, need).toNumber());
      }
    }
    if (ratio < 1) throttled[nodeId] = ratio;
    if (ratio <= 0) continue;

    for (const n of needs) {
      const actual = SciNum.mul(n.amount, ratio);
      const cur = state.resources[n.res] ?? SciNum.ZERO;
      state.resources[n.res] = SciNum.max(SciNum.ZERO, SciNum.sub(cur, actual));
      produced[n.res] = SciNum.sub(produced[n.res] ?? SciNum.ZERO, actual);
    }
    for (const out of recipe.outputs) {
      const resMul = 1 + (m.byRes[out.res] ?? 0);
      const gain = SciNum.mul(SciNum.mul(SciNum.mul(out.rate, sdt), ratio), nodeMul * resMul);
      addRes(state, data, out.res, gain);
      produced[out.res] = SciNum.add(produced[out.res] ?? SciNum.ZERO, gain);
    }
  }

  // 时间银行：把一小部分时间存起来（取出时按当前速率结算）
  tickTimeBank(state, data, dt);

  // ---- 毒素自伤：毒素不是"越多越好"的资源，超过安全线会反噬菌毯。
  // 安全线随手牌规模增长（否则后期毒素永远超标），挑战的 toxinSelfDamageMul 会放大反噬。
  {
    const toxin = state.resources["toxin"] ?? SciNum.ZERO;
    const safeLine = SciNum.mul(SciNum.from(Math.max(100, state.graph.size() * 20)), SciNum.from(1 + state.prestige.level));
    if (toxin.isPositive() && SciNum.gt(toxin, safeLine)) {
      const excess = SciNum.sub(toxin, safeLine);
      const selfDamage = SciNum.mul(excess, 0.01 * dt * fx.toxinSelfDamageMul);
      state.resources["toxin"] = SciNum.max(SciNum.ZERO, SciNum.sub(toxin, selfDamage));
      produced["toxin"] = SciNum.sub(produced["toxin"] ?? SciNum.ZERO, selfDamage);
    }
  }

  // 净速率（UI）：整体重建，避免停工后显示陈旧的旧速率
  state.ratePerSec = {};
  for (const [res, delta] of Object.entries(produced)) {
    state.ratePerSec[res] = SciNum.div(delta, sdt).toNumber();
  }

  if (cfg.debug.assertInvariants) assertInvariants(state, data);

  return { dt, produced, throttled, activeNodes, unlockedLayers };
}

/** 不变量断言：任何违反都会抛错（模拟器捕获后立即报告，而不是静默跑偏） */
export function assertInvariants(state: GameState, data: GameData): void {
  for (const [id, v] of Object.entries(state.resources)) {
    if (!v.isFinite()) throw new Error(`invariant: 资源 ${id} 非有限值 ${String(v.m)}|${String(v.e)}`);
    if (v.isNegative()) throw new Error(`invariant: 资源 ${id} 为负 ${v.toString()}`);
    if (v.isSaturated()) throw new Error(`invariant: 资源 ${id} 触及饱和上限（疑似数值爆炸）`);
    const cap = data.resources.get(id)?.cap;
    if (cap && SciNum.gt(v, cap)) throw new Error(`invariant: 资源 ${id} 超过上限`);
  }
  for (const node of state.graph.nodes.values()) {
    if (!Number.isFinite(node.richness)) throw new Error(`invariant: 节点 ${node.id} 富饶度非法`);
    if (node.richness < 0 || node.richness > 100 * (1 + 10)) throw new Error(`invariant: 节点 ${node.id} 富饶度越界 ${node.richness}`);
  }
}

/** 计算网络价值（Prestige 用） */
export function networkValue(state: GameState, data: GameData): SciNum {
  let total = SciNum.ZERO;
  for (const node of state.graph.nodes.values()) {
    const type = data.nodes.get(node.typeId);
    if (!type) continue;
    let inst = SciNum.ZERO;
    for (const c of type.cost) inst = SciNum.add(inst, SciNum.mul(c.amount, 10)); // 粗略折算为 10 倍基础成本
    total = SciNum.add(total, inst);
  }
  const linkBonus = 1 + 0.03 * state.graph.links.size;
  const topologyFactor = 1 + 0.05 * Math.log1p(state.stats.catalystUses);
  return SciNum.mul(SciNum.mul(total, linkBonus), topologyFactor);
}

/** 孢子化收益（docs/balance-model.md §5） */
export function sporogeneGain(state: GameState, data: GameData, mods: ModifierSet): SciNum {
  const cfg = data.config.prestige;
  const value = networkValue(state, data);
  const base = SciNum.from(cfg.networkValueBase);
  const ratio = SciNum.max(SciNum.div(value, base), SciNum.ONE);
  const raw = SciNum.pow(ratio, cfg.exponent);
  const mul = 1 + mods.prestigeGain;
  // 成熟度：本轮太短就重置，收益打折。否则「重置→立刻再重置」会退化成刷分循环
  // （实测未加此因子时，机器人 7 天孢子化 3000+ 次、每轮约 3 分钟）。
  // 曲线：sqrt(t/600)，最低 20%；10 分钟满额。
  const roundTime = Math.max(0, state.elapsed - state.prestige.roundStartedAt);
  const maturity = Math.max(0.2, Math.min(1, Math.sqrt(roundTime / 600)));
  const gain = SciNum.mul(SciNum.mul(raw, mul), maturity);
  return SciNum.max(SciNum.from(cfg.minGain), SciNum.floor(gain));
}
