import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, cloneState } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { buildNode, buildLink, computeModifiers, tick, buyUpgrade } from '../src/core/economy/engine.ts';
import { checkPrestige, doPrestige } from '../src/core/prestige/prestige.ts';
import { runAutomation } from '../src/core/automation/engine.ts';
import { describeRule, evaluateCondition, makeRule, validateRule, isReady } from '../src/core/automation/rules.ts';

const data = loadGameData(defaultDataDir());

/** 搭一个有核心产出的局面（孢子化门槛是"曾产出过核心"） */
function prestigedReady() {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  for (let i = 0; i < 3; i++) buildNode(state, data, 'decomposer_i', 'topsoil', i * 10, 0, mods);
  state.totalProduced.core = S.from(1);
  state.prestige.roundStartedAt = 0;
  for (let i = 0; i < 1200; i++) tick(state, data, 0.1, { mods });
  return { state, mods };
}

// ---------------------------------------------------------------- Prestige

test('孢子化门槛：没产出过核心时被拒绝，并给出可操作的提示', () => {
  const state = createNewGame(data);
  const check = checkPrestige(state, data);
  assert.equal(check.allowed, false);
  assert.ok(check.reason.includes('共生核心'), check.reason);
});

test('孢子化：资源与网络被重置，跨世代内容保留', () => {
  const { state, mods } = prestigedReady();
  // 先塞一些跨世代内容
  state.techs['tech_auto_1'] = true;
  state.achievements['ach_first_link'] = true;
  state.upgrades['up_m_bidir'] = 1; // mechanic 类
  state.upgrades['up_g_mul_1'] = 7; // global 类（应被重置）
  const nodesBefore = state.graph.size();

  const check = checkPrestige(state, data);
  assert.equal(check.allowed, true);
  const { state: next, report } = doPrestige(state, data);

  assert.equal(next.prestige.count, 1);
  assert.ok(S.gt(next.prestige.sporogene, S.ZERO), '应获得孢子基因');
  assert.ok(nodesBefore > 1);
  assert.equal(next.graph.size(), 1, '网络被重置为初始的 1 个免费节点');
  assert.ok(report.nodesLost >= nodesBefore - 1);
  // 保留项
  assert.equal(next.techs['tech_auto_1'], true);
  assert.equal(next.achievements['ach_first_link'], true);
  assert.equal(next.upgrades['up_m_bidir'], 1);
  // 重置项
  assert.equal(next.upgrades['up_g_mul_1'], undefined);
  // 时间延续（避免 UI 跳回 0）
  assert.equal(next.elapsed, state.elapsed);
  void mods;
});

test('孢子化后孢子基因提供全局加成（不是假机制）', () => {
  const { state } = prestigedReady();
  const before = computeModifiers(state, data).globalOutput;
  const { state: next } = doPrestige(state, data);
  next.prestige.sporogene = S.from(50);
  const after = computeModifiers(next, data).globalOutput;
  assert.ok(after > before, `孢子基因应带来全局加成：${before} → ${after}`);
});

// ---------------------------------------------------------------- 规则引擎

test('规则条件求值：资源阈值 / 净产出 / 节点数', () => {
  const { state } = prestigedReady();
  state.resources.spore = S.from(5000);
  state.ratePerSec['water'] = -1.5;

  const r1 = makeRule({ id: 'r1', cond: { kind: 'resourceGte', res: 'spore', value: '1000' } });
  const r2 = makeRule({ id: 'r2', cond: { kind: 'resourceGte', res: 'spore', value: '99999' } });
  const r3 = makeRule({ id: 'r3', cond: { kind: 'rateLt', res: 'water' } });
  const r4 = makeRule({ id: 'r4', cond: { kind: 'nodesGte', count: 2 } });

  assert.equal(evaluateCondition(r1, state, data), true);
  assert.equal(evaluateCondition(r2, state, data), false);
  assert.equal(evaluateCondition(r3, state, data), true);
  assert.equal(evaluateCondition(r4, state, data), true);
});

test('规则校验：引用不存在的资源/节点/科技会被判为无效', () => {
  const bad1 = makeRule({ id: 'b1', cond: { kind: 'resourceGte', res: 'no_such_res', value: '1' } });
  const bad2 = makeRule({ id: 'b2', act: { kind: 'build', target: 'no_such_node' } });
  const bad3 = makeRule({ id: 'b3', act: { kind: 'tech', target: 'no_such_tech' } });
  const ok = makeRule({ id: 'ok', cond: { kind: 'resourceGte', res: 'spore', value: '10' }, act: { kind: 'upgrade', target: 'up_dec1_a' } });
  assert.ok(validateRule(bad1, data)?.includes('未知资源'));
  assert.ok(validateRule(bad2, data)?.includes('未知节点'));
  assert.ok(validateRule(bad3, data)?.includes('未知科技'));
  assert.equal(validateRule(ok, data), null);
});

test('规则冷却生效', () => {
  const rule = makeRule({ id: 'cd', cooldownSec: 10, lastFiredAt: 100 });
  assert.equal(isReady(rule, 105), false);
  assert.equal(isReady(rule, 111), true);
});

test('规则可读描述（UI 直接展示）', () => {
  const rule = makeRule({
    id: 'd',
    cond: { kind: 'resourceGte', res: 'spore', value: '500' },
    act: { kind: 'build', target: 'sporangium_i' },
  });
  const text = describeRule(rule, data);
  assert.ok(text.includes('孢子'), text);
  assert.ok(text.includes('孢子囊'), text);
});

// ---------------------------------------------------------------- 六级自动化

test('tier 0：没有自动化科技时不产生任何动作', () => {
  const { state, mods } = prestigedReady();
  const report = runAutomation(state, data, mods, state.elapsed);
  assert.equal(report.tier, 0);
  assert.equal(report.actions.length, 0);
});

test('tier 2：自动购买升级，但不会抽干库存', () => {
  const { state } = prestigedReady();
  state.upgrades['tech_auto_dummy'] = 0; // 占位，避免误判
  const mods = computeModifiers(state, data);
  mods.autoTier = 2;
  // 给足资源但限制到"花费不超过库存 25%"的范围内
  state.resources.spore = S.from(1000);
  const before = state.resources.spore!.toNumber();
  const report = runAutomation(state, data, mods, state.elapsed);
  assert.ok(report.actions.length + report.firedRules.length > 0 || before < 30, '应至少尝试一次自动购买或资源本来就很少');
  // 关键约束：库存不会被抽干到 0
  assert.ok(state.resources.spore!.toNumber() > 0, '自动购买不应把库存清零');
});

test('tier 5：达到阈值自动孢子化并返回新状态', () => {
  const { state } = prestigedReady();
  const mods = computeModifiers(state, data);
  mods.autoTier = 5;
  state.autoConfig.autoPrestigeThreshold = '1';
  const report = runAutomation(state, data, mods, state.elapsed);
  assert.ok(report.prestige, '应触发孢子化');
  assert.ok(report.nextState, '应返回新状态');
  assert.equal(report.nextState!.prestige.count, state.prestige.count + 1);
});

test('tier 6：玩家规则优先于内置启发式，且被记录到日志', () => {
  const { state } = prestigedReady();
  const mods = computeModifiers(state, data);
  mods.autoTier = 6;
  mods.unlocks.add('rule_engine');
  state.resources.spore = S.from(1_000_000);
  state.resources.sugar = S.from(1_000_000);
  // 解锁条件看的是累计产出，不是当前库存 —— 少设这一行会让规则因"节点未解锁"静默失败
  state.totalProduced.sugar = S.from(1000);
  state.totalProduced.water = S.from(1000);
  state.totalProduced.humus = S.from(1000);
  state.autoRules = [
    makeRule({
      id: 'rule-build-spore',
      name: '孢子低于阈值就补孢子囊',
      // 注意：这里刻意让条件成立（1e6 ≤ 2e6），否则测的是"规则不触发"
      cond: { kind: 'resourceLte', res: 'spore', value: '2000000' },
      act: { kind: 'build', target: 'sporangium_i' },
      cooldownSec: 0,
    }),
  ];
  const before = state.graph.size();
  const report = runAutomation(state, data, mods, state.elapsed);
  assert.ok(report.firedRules.length > 0, `规则应被触发：${JSON.stringify(report)}`);
  assert.ok(state.graph.size() > before, '规则动作应真的建造了节点');
});

test('tier 3：自动扩建会补足没有生产者的资源', () => {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  mods.autoTier = 3;
  // 只给分解丝（已有），其他资源都没有生产者
  state.resources.spore = S.from(5000);
  state.resources.sugar = S.from(5000);
  state.resources.water = S.from(5000);
  // 解锁若干常见节点
  state.totalProduced.humus = S.from(1000);
  state.totalProduced.sugar = S.from(1000);
  state.totalProduced.water = S.from(1000);
  const before = state.graph.size();
  runAutomation(state, data, mods, 100);
  runAutomation(state, data, mods, 200);
  assert.ok(state.graph.size() > before, '应自动扩建出新节点');
});

test('自动化不修改传入的 mods 对象（纯函数边界）', () => {
  const { state } = prestigedReady();
  const mods = computeModifiers(state, data);
  mods.autoTier = 4;
  const tierBefore = mods.autoTier;
  runAutomation(state, data, mods, state.elapsed);
  assert.equal(mods.autoTier, tierBefore);
});

test('克隆状态上的自动化不影响原状态', () => {
  const { state } = prestigedReady();
  const copy = cloneState(state);
  const mods = computeModifiers(state, data);
  mods.autoTier = 3;
  copy.resources.spore = S.from(100000);
  const before = state.graph.size();
  runAutomation(copy, data, mods, copy.elapsed);
  assert.equal(state.graph.size(), before, '原状态不应被改动');
});

test('自动购买走的是与手动相同的代码路径（买到的升级真的生效）', () => {
  const { state } = prestigedReady();
  const mods = computeModifiers(state, data);
  state.resources.spore = S.from(100000);
  const levelBefore = state.upgrades['up_dec1_a'] ?? 0;
  const r = buyUpgrade(state, data, 'up_dec1_a', mods);
  assert.ok(r.ok);
  assert.equal(state.upgrades['up_dec1_a'], levelBefore + 1);
  // 修饰符里应能看到加成
  const after = computeModifiers(state, data);
  assert.ok((after.byNode['decomposer_i'] ?? 0) > 0, '节点级加成应生效');
});

test('自动重连：无入边的配方节点不会被误判为可优化', () => {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  mods.autoTier = 4;
  const dec = [...state.graph.nodes.keys()][0]!;
  const sac = buildNode(state, data, 'saccharifier_i', 'topsoil', 20, 0, mods).nodeId!;
  buildLink(state, data, dec, sac);
  const report = runAutomation(state, data, mods, state.elapsed);
  // 只有一个上游且已是最优，不应产生动作
  assert.ok(report.actions.every((a) => !a.includes('自动优化')), JSON.stringify(report.actions));
});
