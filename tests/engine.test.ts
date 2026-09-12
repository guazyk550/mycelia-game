import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { createNewGame, cloneState, type GameState } from '../src/core/state.ts';
import {
  buildNode,
  buildLink,
  nodeCatalyst,
  nodeCost,
  tick,
  computeModifiers,
  networkValue,
  sporogeneGain,
  type ModifierSet,
} from '../src/core/economy/engine.ts';
import type { GameData } from '../src/core/types.ts';

const DATA_DIR = defaultDataDir();
const data: GameData = loadGameData(DATA_DIR);

interface Ctx {
  state: GameState;
  data: GameData;
  mods: ModifierSet;
}

function setup(): Ctx {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  return { state, data, mods };
}

function give(state: GameState, res: string, amount: string): void {
  state.resources[res] = S.from(amount);
  state.totalProduced[res] = S.add(state.totalProduced[res] ?? S.ZERO, S.from(amount));
}

/** 立刻建好一个节点（跳过建造时间），返回实例 id */
function place(ctx: Ctx, typeId: string, layerId?: string): string {
  const layer = layerId ?? data.nodes.get(typeId)!.def.layer;
  const r = buildNode(ctx.state, data, typeId, layer, 0, 0, ctx.mods);
  assert.ok(r.ok, `build ${typeId} failed: ${r.reason}`);
  const inst = ctx.state.graph.nodes.get(r.nodeId!)!;
  inst.built = true;
  delete ctx.state.buildQueue[inst.id];
  return inst.id;
}

function connect(ctx: Ctx, from: string, to: string): void {
  const r = buildLink(ctx.state, data, from, to);
  assert.ok(r.ok, `link failed: ${r.reason}`);
}

function run(ctx: Ctx, seconds: number, dt = 0.1): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) tick(ctx.state, data, dt, { mods: ctx.mods });
}

// ---------------------------------------------------------------- 初始化

test('新游戏：初始资源、免费节点、起始层', () => {
  const { state } = setup();
  assert.equal(state.graph.size(), 1, '一个免费分解丝');
  assert.equal(state.resources.spore!.toString(), '120', '初始孢子 120（必须够建 孢子囊 25 + 糖化腔 12 + 早期扩张）');
  assert.equal(state.resources.sugar!.toString(), '0');
  assert.deepEqual(state.unlockedLayers, ['topsoil']);
  assert.equal(state.prestige.level, 0);
});

test('单节点产出：分解丝产腐殖质并消耗土壤', () => {
  const ctx = setup();
  const node = [...ctx.state.graph.nodes.keys()][0]!;
  const richnessBefore = ctx.state.graph.nodes.get(node)!.richness;
  run(ctx, 10);
  // 0.5/s × 10s ≈ 5，实际略低（土壤在这 10 秒内被抽走 0.6 点富饶度）
  assert.ok(Math.abs(ctx.state.resources.humus!.toNumber() - 5) < 0.05, `humus=${ctx.state.resources.humus!.toString()}`);
  // 枯竭 0.06/s × 10s = 0.6
  assert.ok(Math.abs(richnessBefore - ctx.state.graph.nodes.get(node)!.richness - 0.6) < 1e-9, 'soil depletion');
});

test('拓扑传播：上游产出在同 tick 内被下游消费', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '1000');
  give(ctx.state, 'water', '100');
  const dec = [...ctx.state.graph.nodes.keys()][0]!;
  const hyd = place(ctx, 'hydra_i');
  const sac = place(ctx, 'saccharifier_i');
  connect(ctx, hyd, sac);
  connect(ctx, dec, sac);
  run(ctx, 20);
  const sugar = ctx.state.resources.sugar!.toNumber();
  // 糖化腔受 humus 限制：10 秒产 5 humus，之后节流
  assert.ok(sugar > 0, `应有糖产出: ${sugar}`);
  assert.ok(sugar < 20, `应被腐殖质限制在满产以下: ${sugar}`);
  assert.ok(ctx.state.resources.water!.toNumber() > 10, '水应持续积累');
});

test('缺料降速：上游同 tick 供料只能支持部分运行，且库存不为负', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '1000');
  give(ctx.state, 'water', '100');
  const sac = place(ctx, 'saccharifier_i'); // 无入边（无催化），但需要 humus 2/s
  const report = tick(ctx.state, data, 0.1, { mods: ctx.mods });
  // 免费分解丝先产 0.05 humus，糖化腔需要 0.12 → ratio ≈ 0.4167
  const ratio = report.throttled[sac];
  assert.ok(ratio !== undefined && ratio > 0 && ratio < 1, `应部分降速，实际 ${ratio}`);
  assert.ok(Math.abs(ratio! - 0.05 / 0.12) < 1e-9, `ratio=${ratio}`);
  assert.ok(!ctx.state.resources.humus!.isNegative(), '库存不为负');
});

test('零供料时完全停工（ratio = 0）', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '1000');
  give(ctx.state, 'water', '100');
  give(ctx.state, 'humus', '500');
  const sac = place(ctx, 'saccharifier_i');
  ctx.state.resources['humus'] = S.ZERO; // 手动耗空
  ctx.state.graph.nodes.delete('n0'); // 移除免费分解丝，断绝腐殖质来源
  const report = tick(ctx.state, data, 0.1, { mods: ctx.mods });
  assert.equal(report.throttled[sac], 0, '无原料时完全停工');
  assert.equal(ctx.state.resources.sugar!.toNumber(), 0);
});

test('催化剂：不同上游 tag 对同一配方产生不同倍率', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '100000');
  give(ctx.state, 'mineral', '100000');
  give(ctx.state, 'sugar', '100000');
  give(ctx.state, 'water', '100000');
  const dec = [...ctx.state.graph.nodes.keys()][0]!; // fresh tag
  const tox = place(ctx, 'toxin_gland_i'); // volatile tag
  const sacA = place(ctx, 'saccharifier_i');
  const sacB = place(ctx, 'saccharifier_i');
  connect(ctx, dec, sacA);
  connect(ctx, tox, sacB);

  const catA = nodeCatalyst(ctx.state, data, sacA);
  const catB = nodeCatalyst(ctx.state, data, sacB);
  assert.equal(catA.bestRule?.upstreamTag, 'fresh');
  assert.ok(Math.abs(catA.rateMul - 1.15) < 1e-12, `fresh → metabolizer 应为 1.15，实际 ${catA.rateMul}`);
  assert.equal(catB.bestRule?.upstreamTag, 'volatile');
  assert.ok(Math.abs(catB.rateMul - 0.85) < 1e-12, `volatile → metabolizer 应为 0.85，实际 ${catB.rateMul}`);
});

test('入边数有边际收益但受 1.2 上限约束', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '100000');
  give(ctx.state, 'water', '100');
  const target = place(ctx, 'saccharifier_i');
  const sources = [place(ctx, 'decomposer_i'), place(ctx, 'decomposer_i'), place(ctx, 'decomposer_i')];
  for (const s of sources) connect(ctx, s, target);
  const cat = nodeCatalyst(ctx.state, data, target);
  // 3 条入边：1 + 0.02 × 2 = 1.04，再乘 fresh 规则 1.15
  assert.ok(Math.abs(cat.rateMul - 1.15 * 1.04) < 1e-12, `rateMul=${cat.rateMul}`);
});

test('配方守恒：消耗量等于产出量的输入侧，且酶被按折扣扣除', () => {
  const ctx = setup();
  give(ctx.state, 'humus', '1000');
  give(ctx.state, 'water', '1000');
  give(ctx.state, 'spore', '10000');
  const dec = [...ctx.state.graph.nodes.keys()][0]!;
  const sac = place(ctx, 'saccharifier_i');
  connect(ctx, dec, sac);
  run(ctx, 10);
  // 糖化腔：humus 2/s + water 0.2/s → sugar 1/s，受 fresh 催化 ×1.15
  const sugar = ctx.state.resources.sugar!.toNumber();
  const waterSpent = 1000 - ctx.state.resources.water!.toNumber();
  // 糖化腔：humus 1.2/s + water 0.2/s → sugar 1.5/s，受 fresh 催化 ×1.15
  assert.ok(Math.abs(sugar - 17.25) < 1e-6, `sugar=${sugar}`);
  assert.ok(Math.abs(waterSpent - 2) < 1e-6, `waterSpent=${waterSpent}`);
  // 腐殖质净变化 = 分解丝产出 ≈4.99 − 糖化腔消耗 12 = −7.01（同一 tick 内上游先入账）
  const humusNet = 1000 - ctx.state.resources.humus!.toNumber();
  assert.ok(Math.abs(humusNet - 7) < 0.05, `humusNet=${humusNet}`);
});

test('环内结算确定：糖↔酶互转不抛错且结果可复现', () => {
  const mk = (): Ctx => {
    const c = setup();
    give(c.state, 'spore', '100000');
    give(c.state, 'sugar', '5000');
    give(c.state, 'enzyme', '5000');
    give(c.state, 'water', '100000');
    const eg = place(c, 'enzyme_gland_i'); // sugar → enzyme
    const glu = place(c, 'gluconeogen'); // enzyme → sugar
    connect(c, eg, glu);
    connect(c, glu, eg);
    return c;
  };
  const a = mk();
  const b = mk();
  const cyc = a.state.graph.topoOrder().cyclic;
  assert.ok(cyc.size >= 2, `应识别出环内节点，实际 ${cyc.size}`);
  run(a, 5);
  run(b, 5);
  assert.equal(a.state.resources.sugar!.serialize(), b.state.resources.sugar!.serialize(), '同输入两次模拟必须完全一致');
  assert.equal(a.state.resources.enzyme!.serialize(), b.state.resources.enzyme!.serialize());
});

test('整体确定性：同种子同操作序列两次运行结果一致', () => {
  const build = (): Ctx => {
    const c = setup();
    give(c.state, 'spore', '50000');
    give(c.state, 'water', '100');
    give(c.state, 'sugar', '100');
    const dec = [...c.state.graph.nodes.keys()][0]!;
    const hyd = place(c, 'hydra_i');
    const sac = place(c, 'saccharifier_i');
    const spg = place(c, 'sporangium_i');
    connect(c, dec, sac);
    connect(c, hyd, sac);
    connect(c, sac, spg);
    return c;
  };
  const a = build();
  const b = build();
  run(a, 120);
  run(b, 120);
  for (const res of ['humus', 'water', 'sugar', 'spore']) {
    assert.equal(a.state.resources[res]!.serialize(), b.state.resources[res]!.serialize(), `${res} 不一致`);
  }
});

test('土壤枯竭会压低产出（richnessMul）', () => {
  const ctx = setup();
  const node = [...ctx.state.graph.nodes.keys()][0]!;
  const inst = ctx.state.graph.nodes.get(node)!;
  inst.richness = 100;
  const before = ctx.state.resources.humus!.toNumber();
  run(ctx, 5);
  const richYield = ctx.state.resources.humus!.toNumber() - before;
  inst.richness = 5; // 接近枯竭下限（base 70 → 约 7% 富饶比）
  const before2 = ctx.state.resources.humus!.toNumber();
  run(ctx, 5);
  const poorYield = ctx.state.resources.humus!.toNumber() - before2;
  assert.ok(poorYield < richYield * 0.6, `贫瘠地块产出应显著更低: ${poorYield} vs ${richYield}`);
  assert.ok(poorYield > 0, '不会归零（35% 下限）');
});

test('建造与升级：成本按已建数量增长，升级按等级增长', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '1000000');
  const c1 = ctx.state.graph.nodes.size;
  place(ctx, 'decomposer_i');
  place(ctx, 'decomposer_i');
  assert.equal(ctx.state.graph.size(), c1 + 2);
  // 起始已有 1 个免费分解丝，再建 2 个 → n = 3，第 4 个的成本 = 5 × 1.14^3
  const cost3 = nodeCost(ctx.state, data, 'decomposer_i', ctx.mods);
  assert.ok(Math.abs(cost3[0]!.amount.toNumber() - 5 * 1.14 ** 3) < 1e-9, `cost3=${cost3[0]!.amount.toString()}`);
});

test('网络价值与孢子化收益：单调且不低于下限', () => {
  const ctx = setup();
  give(ctx.state, 'spore', '100000');
  place(ctx, 'decomposer_i');
  const v1 = networkValue(ctx.state, data);
  place(ctx, 'decomposer_i');
  place(ctx, 'decomposer_i');
  const v2 = networkValue(ctx.state, data);
  assert.ok(S.gt(v2, v1), '网络价值随节点增加');
  const g = sporogeneGain(ctx.state, data, ctx.mods);
  assert.ok(S.gte(g, S.ONE), `孢子化收益不低于下限，实际 ${g.toString()}`);
});

test('cloneState 与原状态完全独立', () => {
  const ctx = setup();
  run(ctx, 5);
  const copy = cloneState(ctx.state);
  const before = copy.resources.humus!.serialize();
  run(ctx, 5);
  assert.equal(copy.resources.humus!.serialize(), before, '克隆体不受原状态 tick 影响');
  assert.notEqual(ctx.state.resources.humus!.serialize(), before, '原状态继续推进');
});
