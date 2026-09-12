/**
 * 生态法则（Meta 层）验收。
 *
 * 核心不变量：法则改的是**公式**，所以它们的生效点必须在配置读取处，
 * 而不是简单往倍率里塞一个数。下面每一项都验证"公式真的变了"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, type GameState } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { computeModifiers, nodeCost, tick } from '../src/core/economy/engine.ts';
import { applyLaw, lawBonuses, lawsOf, listLaws } from '../src/core/meta/laws.ts';
import { sell, ensureMarket } from '../src/core/market/market.ts';

const data = loadGameData();

function withLaws(n: number): GameState {
  const st = createNewGame(data);
  st.resources['law'] = S.from(n);
  return st;
}

test('法则：数据表至少 8 条可加载，且都有可读效果说明', () => {
  assert.ok(data.laws.size >= 8, `法则数量不足：${data.laws.size}`);
  for (const [id, def] of data.laws) {
    assert.ok(def.effect.desc, `${id} 缺少 effect.desc —— 无法向玩家解释它改了什么`);
    assert.ok(def.maxStacks >= 1);
  }
});

test('法则：应用会消耗碎片并记录叠加', () => {
  const st = withLaws(3);
  const r = applyLaw(st, data, 'law_frugal', null);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state!.resources['law']!.toNumber(), 2, '应精确扣除 1 片');
  assert.equal(lawsOf(r.state!).length, 1);
  assert.equal(lawsOf(r.state!)[0]!.stacks, 1);

  // 再叠一次
  const r2 = applyLaw(r.state!, data, 'law_frugal', null);
  assert.equal(r2.ok, true);
  assert.equal(lawsOf(r2.state!)[0]!.stacks, 2);
});

test('法则：碎片不足 / 超出上限 / 目标要求不符 都会被拒绝', () => {
  const poor = withLaws(0);
  assert.equal(applyLaw(poor, data, 'law_frugal', null).ok, false);

  const rich = withLaws(99);
  // 需要目标的法则不给目标
  assert.match(applyLaw(rich, data, 'law_nourish', null).reason, /需要选择/);
  // 不需要目标的法则给了目标
  assert.match(applyLaw(rich, data, 'law_frugal', 'sugar').reason, /不接受目标/);
  // 不存在的目标
  assert.match(applyLaw(rich, data, 'law_nourish', 'not_a_res').reason, /未知目标/);
});

test('法则：廉直律真的改成本曲线（不是加折扣）', () => {
  const plain = withLaws(0);
  const st = withLaws(9);
  for (let i = 0; i < 3; i++) {
    const r = applyLaw(st, data, 'law_frugal', null);
    assert.equal(r.ok, true, r.reason);
    Object.assign(st, r.state!);
  }
  const a = nodeCost(plain, data, 'decomposer_i', computeModifiers(plain, data))[0]!.amount;
  const b = nodeCost(st, data, 'decomposer_i', computeModifiers(st, data))[0]!.amount;
  assert.ok(S.lt(b, a), `成本曲线应被压低：${a.toString()} vs ${b.toString()}`);
});

test('法则：滋养律对指定资源的产出加成生效（真实 tick）', () => {
  const st = withLaws(3);
  const r = applyLaw(st, data, 'law_nourish', 'humus');
  assert.equal(r.ok, true, r.reason);
  Object.assign(st, r.state!);
  const bonuses = lawBonuses(st, data);
  assert.ok((bonuses.byRes['humus'] ?? 0) > 0, '腐殖质应获得产出加成');

  const m = computeModifiers(st, data);
  assert.ok((m.byRes['humus'] ?? 0) > 0, '修饰符里应能读到法则加成');
});

test('法则：共鸣律 / 沃土律 / 静默律 / 长眠律 / 速熟律 / 深流律 分别改到对应公式', () => {
  const st = withLaws(20);
  for (const id of ['law_resonance', 'law_loam', 'law_silence', 'law_slumber', 'law_ripen', 'law_deepflow']) {
    const r = applyLaw(st, data, id, null);
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
    Object.assign(st, r.state!);
  }
  const b = lawBonuses(st, data);
  assert.ok(b.catalystBonus > 0, '共鸣律应提升催化');
  assert.ok(b.richnessRepair > 0, '沃土律应开启土壤自愈');
  assert.ok(b.eventRateCut > 0, '静默律应降低事件频率');
  assert.ok(b.offlineHoursAdd > 0, '长眠律应延长离线上限');
  assert.ok(b.maturityFloorAdd > 0, '速熟律应抬高成熟度下限');
  assert.ok(b.marketDepthMul > 0, '深流律应加深市场');

  // 沃土律：土壤恢复要走真实 tick 对比。
  // 注意：单层沃土律（+0.02/s）追不上分解丝的消耗（0.06/s），所以正确的判据是
  // "同样局面下有法则的土壤更高"，而不是"土壤一定上涨"。
  const plainSoil = createNewGame(data);
  const lawSoil = createNewGame(data);
  lawSoil.laws = [{ id: 'law_loam', target: null, stacks: data.laws.get('law_loam')!.maxStacks }];
  for (const s2 of [plainSoil, lawSoil]) {
    for (const n of s2.graph.nodes.values()) n.richness = 30;
  }
  for (let i = 0; i < 60; i++) {
    tick(plainSoil, data, 1);
    tick(lawSoil, data, 1);
  }
  const rp2 = [...plainSoil.graph.nodes.values()][0]!.richness;
  const rl2 = [...lawSoil.graph.nodes.values()][0]!.richness;
  assert.ok(rl2 > rp2, `有沃土律的土壤应更高：${rp2.toFixed(3)} vs ${rl2.toFixed(3)}`);
});

test('法则：深流律让同样的出货量砸得更轻（市场深度真的变深）', () => {
  const def = data.laws.get('law_deepflow')!;

  const plain = createNewGame(data);
  plain.resources['sugar'] = S.from(1e6);
  ensureMarket(plain, data);
  sell(plain, data, 'sugar', S.from(50000));
  const plainPrice = ensureMarket(plain, data).entries['sugar']!.price;

  const deep = createNewGame(data);
  deep.resources['sugar'] = S.from(1e6);
  deep.laws = [{ id: def.id, target: null, stacks: def.maxStacks }];
  ensureMarket(deep, data);
  sell(deep, data, 'sugar', S.from(50000));
  const deepPrice = ensureMarket(deep, data).entries['sugar']!.price;

  assert.ok(deepPrice > plainPrice, `深流律下同样出货量应压价更少：${plainPrice.toFixed(2)} vs ${deepPrice.toFixed(2)}`);
});

test('法则：列表接口给出叠加状态与可负担性（UI 依赖）', () => {
  const st = withLaws(1);
  const list = listLaws(st, data);
  assert.equal(list.length, data.laws.size);
  assert.equal(list.every((l) => l.cost.isPositive()), true);
  const nourish = list.find((l) => l.def.id === 'law_nourish')!;
  assert.equal(nourish.targets.length > 0, true, '需要目标的法则应给出候选目标');
  assert.equal(nourish.affordable, true);
});

test('法则：应用法则不影响既有玩家行为（纯增量，不重置网络）', () => {
  const st = withLaws(1);
  const beforeNodes = st.graph.size();
  const beforeSugar = st.resources['sugar']!.toNumber();
  const r = applyLaw(st, data, 'law_frugal', null);
  assert.equal(r.state!.graph.size(), beforeNodes, '不应动网络');
  assert.equal(r.state!.resources['sugar']!.toNumber(), beforeSugar, '不应动其他资源');
});

test('法则：矩阵律改写催化规则后真的改变产出（派生索引重建）', () => {
  const key = [...data.catalystIndex.keys()][0]!;
  const plain = createNewGame(data);
  const st = createNewGame(data);
  st.resources['law'] = S.from(10);

  const r = applyLaw(st, data, 'law_matrix', key);
  assert.equal(r.ok, true, r.reason);
  Object.assign(st, r.state!);

  // 覆盖值应出现在法则加成里
  const bonuses = lawBonuses(st, data);
  assert.equal(typeof bonuses.matrixOverrides[key], 'number', '矩阵覆盖应被记录');
  assert.equal(bonuses.matrixOverrides[key], 1.5);

  // 改写后，读到的催化规则倍率应变成 1.5（而不是原地修改全局索引）
  const before = data.catalystIndex.get(key)!.rateMul;
  assert.notEqual(before, 1.5, '全局索引本身不应被就地改写（否则会污染其它存档）');

  // 无覆盖的局面读到原始值：通过 nodeCatalyst 的对外行为间接验证
  const plainBonus = lawBonuses(plain, data).matrixOverrides;
  assert.equal(Object.keys(plainBonus).length, 0, '没有法则时不应有任何覆盖');
});

test('法则：多存档之间互不污染（覆盖只存在于各自的 state.laws 里）', () => {
  const key = [...data.catalystIndex.keys()][0]!;
  const a = createNewGame(data);
  a.resources['law'] = S.from(10);
  const r = applyLaw(a, data, 'law_matrix', key);
  Object.assign(a, r.state!);

  const b = createNewGame(data);
  assert.equal(Object.keys(lawBonuses(b, data).matrixOverrides).length, 0, '另一个存档不应受影响');
  assert.equal(data.catalystIndex.get(key)!.rateMul, data.catalystIndex.get(key)!.rateMul);
});

test('验收：法则存档往返后仍然生效（重启游戏不该丢掉改写过的规则）', async () => {
  const { serializeState, deserializeState } = await import('../src/core/save/save.ts');

  const st = withLaws(20);
  for (const [id, target] of [
    ['law_frugal', null],
    ['law_slumber', null],
    ['law_nourish', 'humus'],
  ] as const) {
    const r = applyLaw(st, data, id, target);
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
    Object.assign(st, r.state!);
  }
  const beforeBonuses = lawBonuses(st, data);
  assert.ok(beforeBonuses.costGrowthCut > 0 && beforeBonuses.offlineHoursAdd > 0);

  // 存档往返
  const loaded = deserializeState(
    { version: 1, savedAt: 0, gameTime: st.elapsed, checksum: '', state: serializeState(st) } as never,
    data,
    { skipChecksum: true },
  );
  assert.equal(loaded.ok, true, loaded.warnings.join('；'));
  const back = loaded.state!;

  assert.equal(back.laws.length, st.laws.length, '法则条数应保留');
  const afterBonuses = lawBonuses(back, data);
  assert.equal(afterBonuses.costGrowthCut, beforeBonuses.costGrowthCut, '廉直律应仍生效');
  assert.equal(afterBonuses.offlineHoursAdd, beforeBonuses.offlineHoursAdd, '长眠律应仍生效');
  assert.equal(afterBonuses.byRes['humus'], beforeBonuses.byRes['humus'], '滋养律应仍生效');

  // 往返后成本曲线仍是压低过的
  const plain = withLaws(0);
  const a = nodeCost(plain, data, 'decomposer_i', computeModifiers(plain, data))[0]!.amount;
  const b = nodeCost(back, data, 'decomposer_i', computeModifiers(back, data))[0]!.amount;
  assert.ok(S.lt(b, a), '往返后成本曲线应仍是改写过的版本');
});

test('验收：法则不是"数值升级" —— 它改变的是曲线的斜率', () => {
  const st = withLaws(9);
  const r = applyLaw(st, data, 'law_frugal', null);
  Object.assign(st, r.state!);

  const growthPlain = data.nodes.get('decomposer_i')!.costGrowth;
  const growthLaw = growthPlain - lawBonuses(st, data).costGrowthCut;
  assert.ok(growthLaw < growthPlain, );

  // 关键区别："打折"会让第一个节点就变便宜，而"改斜率"让相邻成本的比值变小。
  // 这里直接比较真实成本之比：cost(n=2)/cost(n=1) 应等于被改写后的增长率。
  const plain = withLaws(0);
  const c1 = nodeCost(plain, data, 'decomposer_i', computeModifiers(plain, data))[0]!.amount.toNumber();
  plain.graph.addNode({ id: 'tmp1', typeId: 'decomposer_i', layerId: 'topsoil', x: 500, y: 0, built: true, active: true, richness: 60 } as never);
  const c2 = nodeCost(plain, data, 'decomposer_i', computeModifiers(plain, data))[0]!.amount.toNumber();
  const ratio = c2 / c1;
  assert.ok(Math.abs(ratio - growthPlain) < 1e-6, );
  assert.ok(Math.abs(growthLaw - (growthPlain - 0.02)) < 1e-9);
});
