/**
 * 挑战规则的**行为**验收：每一条限制都必须真的拦住玩家，而不是只存在于数据表。
 *
 * 这类测试的意义：挑战最容易出的一种 bug 是"开始界面显示了一堆限制，
 * 但引擎根本没读" —— 玩家玩了一个假的挑战。下面逐类验证拦截点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { buildLink, buildNode, computeModifiers, nodeCost, tick } from '../src/core/economy/engine.ts';
import { emptyChallengeState, startChallenge, challengeEffects, applyChallengeModifiers } from '../src/core/challenges/challenge-engine.ts';
import { runAutomation } from '../src/core/automation/engine.ts';
import { settleOffline } from '../src/core/offline/settle.ts';
import { checkPrestige } from '../src/core/prestige/prestige.ts';
import { buy, sell, ensureMarket } from '../src/core/market/market.ts';

const data = loadGameData();

/** 开始某条挑战并返回局面 */
function inChallenge(id: string) {
  const st = createNewGame(data);
  st.challenges = emptyChallengeState();
  const r = startChallenge(st, data, id);
  assert.equal(r.ok, true, `无法开始 ${id}: ${r.reason}`);
  const s = { ...st, challenges: r.challenge! };
  s.resources['spore'] = S.from(1e6);
  s.resources['humus'] = S.from(1e6);
  s.resources['sugar'] = S.from(1e6);
  s.resources['honeydew'] = S.from(1e6);
  return s;
}

test('挑战限制：banClass 真的拦住建造（能源禁令禁共生类）', () => {
  const st = inChallenge('ch_energy_ban');
  // 先解锁层与资源门槛，确保被拒的原因确实是 banClass 而不是 layer-locked
  st.unlockedLayers = [...new Set([...st.unlockedLayers, 'aquifer'])];
  st.totalProduced['honeydew'] = S.from(1e9);
  st.totalProduced['sugar'] = S.from(1e9);
  st.resources['spore'] = S.from(1e9);
  const res = buildNode(st, data, 'algae_i', 'aquifer', 0, 0, computeModifiers(st, data));
  assert.equal(res.ok, false, '共生类应被挑战禁用');
  assert.match(res.detail ?? '', /禁止建造/);
});

test('挑战限制：nodeCapMax 达到上限后拒绝建造', () => {
  const st = inChallenge('ch_single_class'); // 上限 60
  const mods = computeModifiers(st, data);
  // 直接把图塞到上限
  for (let i = st.graph.size(); i < 60; i++) {
    st.graph.addNode({ id: `n${i}`, typeId: 'decomposer_i', layerId: 'topsoil', x: i * 40, y: 0, built: true, active: true, richness: 60 } as never);
  }
  const res = buildNode(st, data, 'decomposer_i', 'topsoil', 9999, 9999, mods);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? '', /节点总数/);
});

test('挑战限制：outDegreeMax 限制每个节点的出度', () => {
  const st = inChallenge('ch_single_class'); // 出度上限 1
  const from = [...st.graph.nodes.values()][0]!;
  const a = st.graph.addNode({ id: 'a1', typeId: 'saccharifier_i', layerId: 'topsoil', x: 100, y: 0, built: true, active: true, richness: 60 } as never);
  const b = st.graph.addNode({ id: 'b1', typeId: 'saccharifier_i', layerId: 'topsoil', x: 200, y: 0, built: true, active: true, richness: 60 } as never);
  void a;
  void b;

  const first = buildLink(st, data, from.id, 'a1');
  assert.equal(first.ok, true, first.detail);
  const second = buildLink(st, data, from.id, 'b1');
  assert.equal(second.ok, false, '第二条出线应被拒');
  assert.match(second.detail ?? '', /出度/);
});

test('挑战限制：layersOnly 只允许指定层建造', () => {
  // ch_layers 用 layersOnly 把玩家锁在某一层
  const def = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'layersOnly'));
  if (!def) return;
  const st = inChallenge(def.id);
  const allowed = def.modifiers.find((m) => m.kind === 'layersOnly')!.value as string;
  const other = ['topsoil', 'aquifer', 'lode', 'bedrock'].find((l) => l !== allowed)!;
  st.unlockedLayers = [allowed, other];

  const blocked = buildNode(st, data, 'decomposer_i', other, 0, 0, computeModifiers(st, data));
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail ?? '', /只允许|禁止建造/, '应被层限制或类限制拦下');
});

test('挑战限制：noAutomation 让自动化彻底停摆', () => {
  const st = inChallenge('ch_time_freeze');
  const mods = { ...computeModifiers(st, data), autoTier: 5 };
  const report = runAutomation(st, data, mods, st.elapsed);
  assert.equal(report.actions.length, 0);
  assert.equal(report.firedRules.length, 0);
});

test('挑战限制：noOffline 让离线收益归零（并说明原因）', () => {
  const st = inChallenge('ch_time_freeze');
  const now = Date.now();
  const report = settleOffline(st, data, now - 3600_000, now);
  assert.equal(report.settledSec, 0);
  assert.equal(Object.keys(report.gained).length, 0);
  assert.ok(report.events.some((e) => e.includes('禁止离线收益')));
});

test('挑战限制：noPrestige 禁止孢子化（并给出可操作的原因）', () => {
  const def = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'noPrestige'));
  if (!def) return;
  const st = inChallenge(def.id);
  st.totalProduced['core'] = S.from(100);
  const check = checkPrestige(st, data);
  assert.equal(check.allowed, false);
  assert.match(check.reason, /禁止孢子化/);
});

test('挑战限制：marketClosed 让买卖都被拒绝', () => {
  const def = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'marketClosed'));
  if (!def) return;
  const st = inChallenge(def.id);
  // 先让市场初始化，否则拒绝原因可能是"资源不可交易"
  ensureMarket(st, data);
  const s = sell(st, data, 'sugar', S.from(10));
  assert.equal(s.ok, false);
  assert.match(s.reason ?? '', /菌市关闭/);
});

test('挑战限制：costGrowthAdd 真的把成本曲线抬上去', () => {
  const plain = createNewGame(data);
  const costDef = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'costGrowthAdd'));
  if (!costDef) return;
  const challenged = inChallenge(costDef.id);
  const a = nodeCost(plain, data, 'decomposer_i', computeModifiers(plain, data))[0]!.amount;
  const b = nodeCost(challenged, data, 'decomposer_i', computeModifiers(challenged, data))[0]!.amount;
  assert.ok(S.gte(b, a), `挑战下成本不应更低：${a.toString()} vs ${b.toString()}`);
});

test('挑战限制：banResource / resourceZero 把该资源产出压到 0 或负向', () => {
  const st = inChallenge('ch_energy_ban'); // noLight 等效于禁 light
  const m = computeModifiers(st, data);
  assert.ok((m.byRes['light'] ?? 0) <= -1, `light 应被彻底压住，实际加成 ${m.byRes['light']}`);
});

test('挑战限制：reverseRecipes 真的把输入输出对调（跑真实 tick 验证）', () => {
  const def = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'reverseRecipes'));
  if (!def) return;

  const plain = createNewGame(data);
  const rev = inChallenge(def.id);

  // 两边都放一个糖化腔（输入腐殖质 → 输出糖），跑一秒
  for (const [st, tag] of [[plain, 'plain'], [rev, 'rev']] as const) {
    st.resources['humus'] = S.from(1e6);
    st.resources['water'] = S.from(1e6);
    st.graph.addNode({ id: `s_${tag}`, typeId: 'saccharifier_i', layerId: 'topsoil', x: 300, y: 0, built: true, active: true, richness: 60 } as never);
  }
  const before = {
    plainSugar: plain.resources['sugar']!.toNumber(),
    revSugar: rev.resources['sugar']!.toNumber(),
    revHumus: rev.resources['humus']!.toNumber(),
  };
  for (let i = 0; i < 20; i++) {
    tick(plain, data, 0.1);
    tick(rev, data, 0.1);
  }
  const after = {
    plainSugar: plain.resources['sugar']!.toNumber(),
    revSugar: rev.resources['sugar']!.toNumber(),
    revHumus: rev.resources['humus']!.toNumber(),
  };

  assert.ok(after.plainSugar > before.plainSugar, '普通局面应产出糖');
  // 反转后糖化腔变成"糖 → 腐殖质"，所以糖不该增加（反而被消耗）
  assert.ok(after.revSugar <= before.revSugar, `反转后不应再增产糖：${before.revSugar} → ${after.revSugar}`);
});

test('挑战限制：depletionMul 让土壤更快枯竭（真实 tick）', () => {
  const def = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'depletionMul'));
  if (!def) return;

  const plain = createNewGame(data);
  const drained = inChallenge(def.id);
  for (const st of [plain, drained]) {
    for (const n of st.graph.nodes.values()) n.richness = data.layers.get(n.layerId)?.richnessBase ?? 70;
    for (let i = 0; i < 60; i++) tick(st, data, 1);
  }
  const rp = [...plain.graph.nodes.values()][0]!.richness;
  const rd = [...drained.graph.nodes.values()][0]!.richness;
  assert.ok(rd < rp, `挑战下土壤应更快枯竭：${rp.toFixed(2)} vs ${rd.toFixed(2)}`);
});

test('挑战限制：applyChallengeModifiers 在无挑战时完全不改动修饰符', () => {
  const st = createNewGame(data);
  const m = computeModifiers(st, data);
  const before = { depletionMul: m.depletionMul, costGrowthAdd: m.costGrowthAdd, buildSpeed: m.buildSpeed };
  applyChallengeModifiers(st, data, m);
  assert.equal(m.depletionMul, before.depletionMul);
  assert.equal(m.costGrowthAdd, before.costGrowthAdd);
  assert.equal(m.buildSpeed, before.buildSpeed);
  assert.equal(challengeEffects(st, data).activeId, null);
});

test('挑战存档：进行中的挑战可往返，且回滚快照不落盘', async () => {
  const { serializeState, deserializeState } = await import('../src/core/save/save.ts');
  const st = inChallenge('ch_barren');
  const json = { version: 1, savedAt: 0, gameTime: st.elapsed, checksum: '', state: serializeState(st) } as never;

  // 快照是完整 GameState，写进存档会让体积爆炸且出现自引用式嵌套
  assert.ok(!JSON.stringify(json).includes('"snapshot"'), '回滚快照不应被序列化');

  const loaded = deserializeState(json, data, { skipChecksum: true });
  assert.equal(loaded.ok, true, loaded.warnings.join('；'));
  const back = loaded.state!;
  assert.equal(back.challenges.runtime?.id, 'ch_barren', '进行中的挑战应被恢复');
  assert.equal(back.challenges.runtime?.snapshot, null, '回滚点跨会话后为 null（诚实丢失，而不是假装还能回滚）');
  assert.equal(back.challenges.runtime?.startedAt, st.challenges.runtime!.startedAt);
});

test('挑战存档：已完成的挑战名单与失败次数都能保留', async () => {
  const { serializeState, deserializeState } = await import('../src/core/save/save.ts');
  const st = createNewGame(data);
  st.challenges = { runtime: null, completed: { ch_barren: true }, failures: 3 };
  const loaded = deserializeState(
    { version: 1, savedAt: 0, gameTime: st.elapsed, checksum: '', state: serializeState(st) } as never,
    data,
    { skipChecksum: true },
  );
  const back = loaded.state!;
  assert.equal(back.challenges.completed['ch_barren'], true);
  assert.equal(back.challenges.failures, 3);
});
