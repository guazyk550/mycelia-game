/**
 * 数据加载层：把原始 JSON 表索引化并把所有字符串数值预解析为 SciNum。
 *
 * 运行时只做最小结构校验（完整校验见 scripts/validate-data.ts）：
 *   发现结构性错误时立刻抛错，避免"静默地用错误数据跑一整天模拟"。
 */

import { SciNum } from '../core/math/scinum.ts';
import type {
  CatalystRule,
  GameData,
  NodeDef,
  ParsedNode,
  ParsedRecipe,
  ParsedResource,
  LawDef,
  ParsedStrain,
  ParsedTech,
  ParsedUpgrade,
  RawTables,
} from '../core/types.ts';

function amount(s: string | undefined, where: string): SciNum {
  if (typeof s !== 'string') throw new Error(`loader: ${where} 缺少数值`);
  const v = SciNum.from(s);
  if (v.isNaN()) throw new Error(`loader: ${where} 数值非法: ${s}`);
  return v;
}

function parseCost(cost: Record<string, string> | undefined, where: string): { res: string; amount: SciNum }[] {
  const out: { res: string; amount: SciNum }[] = [];
  for (const [res, v] of Object.entries(cost ?? {})) out.push({ res, amount: amount(v, `${where}.cost.${res}`) });
  return out;
}

function parseRecipe(def: NodeDef): ParsedRecipe {
  const where = `nodes.${def.id}.recipe`;
  const inputs: { res: string; rate: SciNum }[] = [];
  const outputs: { res: string; rate: SciNum }[] = [];
  for (const [res, v] of Object.entries(def.recipe.inputs ?? {})) inputs.push({ res, rate: amount(v, `${where}.in.${res}`) });
  for (const [res, v] of Object.entries(def.recipe.outputs ?? {})) outputs.push({ res, rate: amount(v, `${where}.out.${res}`) });
  return {
    inputs,
    outputs,
    enzymePerSec: amount(def.recipe.enzymePerSec, `${where}.enzymePerSec`),
    depletion: def.recipe.depletion ?? 0,
    ...(def.recipe.modulatedBy ? { modulatedBy: def.recipe.modulatedBy } : {}),
    ...(def.recipe.structural ? { structural: def.recipe.structural } : {}),
    ...(def.recipe.global ? { global: def.recipe.global } : {}),
  };
}

export function buildGameData(raw: RawTables): GameData {
  const resources = new Map<string, ParsedResource>();
  for (const def of raw.resources.resources) {
    resources.set(def.id, {
      def,
      startAmount: amount(def.startAmount, `resources.${def.id}.startAmount`),
      cap: def.cap === null ? null : amount(def.cap, `resources.${def.id}.cap`),
      basePrice: def.basePrice === null ? null : amount(def.basePrice, `resources.${def.id}.basePrice`),
      strategicReserve: def.strategicReserve ? amount(def.strategicReserve, `resources.${def.id}.strategicReserve`) : SciNum.ZERO,
    });
  }

  const nodes = new Map<string, ParsedNode>();
  for (const def of raw.nodes.nodes) {
    nodes.set(def.id, {
      def,
      cost: parseCost(def.cost, `nodes.${def.id}`),
      recipe: parseRecipe(def),
      buildTime: def.buildTime,
      costGrowth: def.costGrowth,
    });
  }

  const layers = new Map(raw.nodes.layers.map((l) => [l.id, l] as const));
  const layerOrder = [...raw.nodes.layers].sort((a, b) => a.order - b.order);

  const upgrades = new Map<string, ParsedUpgrade>();
  for (const def of raw.upgrades.upgrades)
    upgrades.set(def.id, { def, cost: parseCost(def.cost, `upgrades.${def.id}`) });

  const techs = new Map<string, ParsedTech>();
  for (const def of raw.tech.techs) techs.set(def.id, { def, cost: parseCost(def.cost, `tech.${def.id}`) });

  const challenges = new Map(raw.challenges.challenges.map((c) => [c.id, c] as const));
  const achievements = new Map(raw.achievements.achievements.map((a) => [a.id, a] as const));
  const quests = new Map(raw.quests.quests.map((q) => [q.id, q] as const));

  const laws = new Map<string, LawDef>();
  for (const def of raw.laws.laws) {
    if (laws.has(def.id)) throw new Error("loader: 法则 id 重复 " + def.id);
    laws.set(def.id, def);
  }

  const strains = new Map<string, ParsedStrain>();
  for (const def of raw.strains.strains) {
    if (strains.has(def.id)) throw new Error(`loader: 菌株 id 重复 ${def.id}`);
    strains.set(def.id, { def, geneCost: SciNum.from(def.geneCost) });
  }
  // 交叉校验：specials 必须都在词表内（引擎会按这些开关分支，拼错会静默失效）
  const specialKinds = new Set(raw.strains.specialKinds.map((s) => s.split(' — ')[0]!.trim()));
  for (const st of strains.values())
    for (const sp of st.def.specials)
      if (!specialKinds.has(sp)) throw new Error(`loader: 菌株 ${st.def.id} 使用未声明的 special ${sp}`);

  // 催化索引：精确键优先，'*' 次之，最后 default
  const catalystIndex = new Map<string, CatalystRule>();
  for (const r of raw.catalystMatrix.rules) {
    const key = `${r.upstreamTag}>${r.downstreamClass}`;
    if (catalystIndex.has(key)) throw new Error(`loader: 催化矩阵存在重复规则 ${key}`);
    catalystIndex.set(key, r);
  }
  const catalystDefault: CatalystRule = {
    upstreamTag: '*',
    downstreamClass: '*',
    ...raw.catalystMatrix.default,
  };

  // 引用完整性（运行时快速自检）
  for (const n of nodes.values()) {
    for (const c of n.cost) if (!resources.has(c.res)) throw new Error(`loader: 节点 ${n.def.id} 成本引用未知资源 ${c.res}`);
    for (const i of [...n.recipe.inputs, ...n.recipe.outputs])
      if (!resources.has(i.res)) throw new Error(`loader: 节点 ${n.def.id} 配方引用未知资源 ${i.res}`);
    if (!layers.has(n.def.layer)) throw new Error(`loader: 节点 ${n.def.id} 引用未知层 ${n.def.layer}`);
  }

  return {
    raw,
    resources,
    nodes,
    layers,
    layerOrder,
    upgrades,
    techs,
    challenges,
    achievements,
    events: raw.events.events,
    quests,
    strains,
    laws,
    config: raw.gameConfig,
    catalystIndex,
    catalystDefault,
    effectKinds: new Set(raw.upgrades.effectKinds.map((s) => s.split(' — ')[0]!.trim())),
  };
}

/** 查询某条边（上游 catalystTag → 下游 class）的催化规则 */
export function lookupCatalyst(data: GameData, upstreamTag: string, downstreamClass: string): CatalystRule {
  return (
    data.catalystIndex.get(`${upstreamTag}>${downstreamClass}`) ??
    data.catalystIndex.get(`${upstreamTag}>*`) ??
    data.catalystDefault
  );
}
