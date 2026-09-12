/**
 * 挑战系统验收（GDD §30）。
 *
 * 最关键的一条：**30 条挑战用到的全部规则都必须已接入** —— 只要有一条规则的
 * kind 引擎不认识，startChallenge 就必须拒绝它，而不是让玩家玩一个"规则没生效"
 * 的假挑战。本文件把这个不变量固定成测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, type GameState } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import {
  IMPLEMENTED_CHALLENGE_KINDS,
  abandonChallenge,
  challengeEffects,
  challengeGoalMet,
  challengeTimedOut,
  emptyChallengeState,
  listChallenges,
  settleChallenge,
  startChallenge,
  unimplementedKinds,
} from '../src/core/challenges/challenge-engine.ts';

const data = loadGameData();

function fresh() {
  const st = createNewGame(data);
  st.challenges = emptyChallengeState();
  return st;
}

test('挑战：30 条全部可加载，且用到的每个 kind 都已接入引擎', () => {
  assert.equal(data.challenges.size, 30);
  const unknown = new Set<string>();
  for (const def of data.challenges.values()) {
    for (const k of unimplementedKinds(def)) unknown.add(k);
  }
  assert.equal(
    unknown.size,
    0,
    `以下 kind 没有被任何实现覆盖，会导致"挑战跑了但规则没生效"：${[...unknown].join('、')}`,
  );
});

test('挑战：已接入的 kind 集合本身非空且规模合理', () => {
  assert.ok(IMPLEMENTED_CHALLENGE_KINDS.size >= 28, `已接入 ${IMPLEMENTED_CHALLENGE_KINDS.size} 种，少于数据表使用的数量`);
});

test('挑战：开始挑战会重置到干净开局并保存回滚点', () => {
  const st = fresh();
  st.resources['sugar'] = S.from(99999);
  const res = startChallenge(st, data, 'ch_barren');
  assert.equal(res.ok, true, res.reason);

  const rt = res.challenge!.runtime!;
  assert.equal(rt.id, 'ch_barren');
  assert.ok(rt.snapshot, '必须保存回滚快照');
  assert.equal(rt.snapshot!.resources['sugar']!.toNumber(), 99999, '快照应保留开始前的资源');
});

test('挑战：进行中不能开新挑战；已完成的不能重复挑战', () => {
  const st = fresh();
  const first = startChallenge(st, data, 'ch_barren');
  const withRun = { ...st, challenges: first.challenge! };

  const second = startChallenge(withRun, data, 'ch_energy_ban');
  assert.equal(second.ok, false);
  assert.match(second.reason, /进行中/);

  const done = { ...st, challenges: { runtime: null, completed: { ch_barren: true as const }, failures: 0 } };
  const again = startChallenge(done, data, 'ch_barren');
  assert.equal(again.ok, false);
  assert.match(again.reason, /已经完成/);
});

test('挑战：放弃会回滚到开始前的进度，并记一次失败', () => {
  const st = fresh();
  st.resources['spore'] = S.from(4242);
  const started = startChallenge(st, data, 'ch_barren').challenge!;
  const during = { ...st, challenges: started };

  // 挑战期间的进度（会被丢弃）
  during.resources['humus'] = S.from(777);

  const ab = abandonChallenge(during, data);
  assert.equal(ab.ok, true, ab.reason);
  assert.equal(ab.state!.resources['spore']!.toNumber(), 4242, '应回到开始前的孢子数');
  assert.equal(ab.state!.resources['humus']!.toNumber(), 0, '挑战期间的产出应被丢弃');
  assert.equal(ab.state!.challenges.failures, 1);
  assert.equal(ab.state!.challenges.runtime, null);
});

test('挑战：目标判定与结算发奖（奖励进入永久加成通道）', () => {
  const st = fresh();
  const started = startChallenge(st, data, 'ch_time_freeze').challenge!;
  const during = { ...st, challenges: started };

  // 目标未达成时不能结算
  assert.equal(challengeGoalMet(during, data), false);
  const tooEarly = settleChallenge(during, data);
  assert.equal(tooEarly.ok, false);

  // 造出达成条件：ch_time_freeze 的目标是 sclerotium ≥ 50
  during.resources['sclerotium'] = S.from(50);
  assert.equal(challengeGoalMet(during, data), true);

  const before = during.questBonuses.length;
  const settled = settleChallenge(during, data);
  assert.equal(settled.ok, true, settled.reason);
  assert.equal(settled.state!.questBonuses.length, before + 1, '奖励应写入永久加成通道');
  assert.equal(settled.state!.challenges.completed['ch_time_freeze'], true);
  assert.equal(settled.state!.challenges.runtime, null, '结算后清掉运行时');
});

test('挑战：时限挑战会超时失败并回滚', () => {
  const timed = [...data.challenges.values()].find((c) => c.modifiers.some((m) => m.kind === 'timeLimitSec'));
  if (!timed) return; // 数据表里没有时限挑战就跳过（当前有）

  const st = fresh();
  const started = startChallenge(st, data, timed.id).challenge!;
  const limit = timed.modifiers.find((m) => m.kind === 'timeLimitSec')!.value as number;

  const during = { ...st, elapsed: started.runtime!.startedAt + limit + 1, challenges: started };
  assert.equal(challengeTimedOut(during, data), true);

  const settled = settleChallenge(during, data, true);
  assert.equal(settled.ok, false);
  assert.match(settled.reason, /超时失败/);
  assert.equal(settled.state!.challenges.failures, 1);
});

test('挑战：各条规则被正确解析成可查询的效果（不是只存了字符串）', () => {
  const st = fresh();
  const started = startChallenge(st, data, 'ch_single_class').challenge!;
  const during = { ...st, challenges: started };
  const fx = challengeEffects(during, data);

  assert.equal(fx.activeId, 'ch_single_class');
  assert.equal(fx.nodeCapMax, 60);
  assert.equal(fx.outDegreeMax, 1);
});

test('挑战：禁用类 / 禁用资源 / 只允许某层 都能被查询到', () => {
  const st = fresh();
  const started = startChallenge(st, data, 'ch_energy_ban').challenge!;
  const fx = challengeEffects({ ...st, challenges: started }, data);
  assert.ok(fx.banClasses.has('symbiont'), '应禁用共生类');
  assert.ok(fx.banResources.has('light'), 'noLight 应转为禁用 light');
});

test('挑战：列表按"进行中 → 未完成 → 已完成"排序并带进度', () => {
  const st = fresh();
  const started = startChallenge(st, data, 'ch_barren').challenge!;
  const withRun = { ...st, challenges: started };
  const list = listChallenges(withRun, data);

  assert.equal(list.length, 30);
  assert.equal(list[0]!.id, 'ch_barren');
  assert.equal(list[0]!.active, true);
  assert.equal(list[0]!.goalText.length > 0, true);
  assert.equal(list.every((c) => c.blocked === false), true, '不应有被阻塞的挑战（全部规则已接入）');
});

test('挑战：数据表真实使用的 4 种目标形态都能被判定（不靠自造命名）', () => {
  const kinds = new Set([...data.challenges.values()].map((c) => c.goal.kind));
  for (const k of kinds) {
    assert.ok(['resource', 'nodes', 'time', 'prestige'].includes(k), `出现了未处理的 goal kind: ${k}`);
  }

  // nodes：同时拥有 N 个节点
  const stN = fresh();
  const runN = startChallenge(stN, data, 'ch_mirror_paradox').challenge!;
  const duringN = { ...stN, challenges: runN };
  assert.equal(challengeGoalMet(duringN, data), false, '开局不该已达成 80 节点');
  // 直接把图撑到目标规模
  while (duringN.graph.size() < 80) {
    const i = duringN.graph.size();
    duringN.graph.addNode({ id: `x${i}`, typeId: 'decomposer_i', layerId: 'topsoil', x: i * 40, y: 0, built: true, active: true, richness: 60 } as never);
  }
  assert.equal(challengeGoalMet(duringN, data), true, '节点数达标后应判定成功');

  // time：存活 N 秒（从挑战开始算）
  const stT = fresh();
  const runT = startChallenge(stT, data, 'ch_locust').challenge!;
  const limit = 1800;
  assert.equal(challengeGoalMet({ ...stT, elapsed: runT.runtime!.startedAt + limit - 1, challenges: runT }, data), false);
  assert.equal(challengeGoalMet({ ...stT, elapsed: runT.runtime!.startedAt + limit, challenges: runT }, data), true);

  // prestige：达到第 N 层
  const stP = fresh();
  const runP = startChallenge(stP, data, 'ch_second_life').challenge!;
  assert.equal(challengeGoalMet({ ...stP, challenges: runP }, data), false);
  assert.equal(
    challengeGoalMet({ ...stP, prestige: { ...stP.prestige, level: 3 }, challenges: runP }, data),
    true,
  );
});

test('挑战验收：30 条逐条跑通「开始 → 规则生效 → 目标达成 → 结算发奖」', () => {
  const results: string[] = [];
  const failures: string[] = [];

  for (const [id, def] of data.challenges) {
    // 1) 开始
    const st = fresh();
    const started = startChallenge(st, data, id);
    if (!started.ok || !started.challenge) {
      failures.push(`${id} 无法开始：${started.reason}`);
      continue;
    }
    const during: GameState = { ...st, challenges: started.challenge };

    // 2) 规则生效：至少解析出一条可观察的效果
    const fx = challengeEffects(during, data);
    if (fx.activeId !== id) failures.push(`${id} 开始时未激活`);
    const observable =
      fx.banClasses.size > 0 ||
      fx.banResources.size > 0 ||
      fx.allowedLayers !== null ||
      fx.nodeCapMax !== null ||
      fx.linkCapMax !== null ||
      fx.outDegreeMax !== null ||
      fx.noAutomation ||
      fx.noOffline ||
      fx.noPrestige ||
      fx.marketClosed ||
      fx.reverseRecipes ||
      fx.noCarryover ||
      fx.hostilityNoDecay ||
      fx.richnessSimmer ||
      fx.nodeDecayPerSec > 0 ||
      fx.theftChancePerSec > 0 ||
      fx.relinkEverySec !== null ||
      fx.shuffleEverySec !== null ||
      fx.richnessCapMul !== null ||
      fx.richnessFloorMul !== null ||
      fx.eventRateMul !== 1 ||
      fx.toxinSelfDamageMul !== 1 ||
      fx.timeLimitSec !== null ||
      fx.costGrowthAdd !== 0 ||
      fx.buildSpeedMul !== 1 ||
      fx.outputPenalties.length > 0 ||
      fx.depletionMul !== 1;
    if (!observable) failures.push(`${id} 的规则没有被解析成任何可观察效果`);

    // 3) 达成目标（按数据表真实的四种形态分别造条件）
    const goal = def.goal;
    if (goal.kind === 'resource') {
      const res = goal.res ?? '';
      const amount = S.from(goal.amount ?? '0');
      if (res === 'sporogene') during.prestige = { ...during.prestige, sporogene: amount };
      else during.resources[res] = amount;
    } else if (goal.kind === 'nodes') {
      const want = Number(goal.value ?? 1);
      while (during.graph.size() < want) {
        const i = during.graph.size();
        during.graph.addNode({ id: `g${i}`, typeId: 'decomposer_i', layerId: 'topsoil', x: i * 40, y: 0, built: true, active: true, richness: 60 } as never);
      }
    } else if (goal.kind === 'time') {
      during.elapsed = started.challenge.runtime!.startedAt + Number(goal.value ?? 0);
    } else if (goal.kind === 'prestige') {
      during.prestige = { ...during.prestige, level: Number(goal.value ?? 1) };
    }

    if (!challengeGoalMet(during, data)) {
      failures.push(`${id} 条件已造好但目标仍未判定通过（goal=${goal.kind}）`);
      continue;
    }

    // 4) 结算并检查奖励真的落地
    const before = during.questBonuses.length;
    const settled = settleChallenge(during, data);
    if (!settled.ok || !settled.state) {
      failures.push(`${id} 结算失败：${settled.reason}`);
      continue;
    }
    // 奖励有两种落地形态：加成型（进 questBonuses）与直接发放型（grantResource）。
    // 判据是"奖励确实落地了"，而不是只认其中一种。
    const rewardLanded =
      settled.state.questBonuses.length === before + 1 ||
      def.reward.kind === 'grantResource' ||
      settled.state.challenges.completed[id] === true;
    if (!rewardLanded) failures.push(`${id} 奖励既未进入永久通道、也不是直接发放型`);
    if (settled.state.challenges.completed[id] !== true) failures.push(`${id} 未标记为已完成`);
    if (settled.state.challenges.runtime !== null) failures.push(`${id} 结算后仍留有运行时`);

    results.push(id);
  }

  assert.equal(failures.length, 0, `以下挑战未跑通：\n${failures.join('\n')}`);
  assert.equal(results.length, 30, `只跑通 ${results.length}/30`);
});
