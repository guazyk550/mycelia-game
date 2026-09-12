import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { buildNode, buildLink, computeModifiers, tick } from '../src/core/economy/engine.ts';
import { checkAchievements, checkQuests, tickEvents } from '../src/core/progression/content-engine.ts';
import { EMPTY_TRIGGER_CONTEXT, evaluateTrigger } from '../src/core/progression/triggers.ts';

const data = loadGameData(defaultDataDir());

function play(seconds = 30) {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  const hyd = buildNode(state, data, 'hydra_i', 'topsoil', 20, 0, mods).nodeId!;
  const sac = buildNode(state, data, 'saccharifier_i', 'topsoil', 40, 0, mods).nodeId!;
  buildLink(state, data, hyd, sac);
  buildLink(state, data, [...state.graph.nodes.keys()][0]!, sac);
  for (let i = 0; i < seconds * 10; i++) tick(state, data, 0.1, { mods });
  return state;
}

/** 确定性伪随机（与离线结算同款），保证事件测试可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('条件求值：资源看累计产出，不看当前持有', () => {
  const state = play(20);
  state.totalProduced.humus = S.from('1e6');
  state.resources.humus = S.ZERO; // 当前持有为 0，但累计达标
  assert.equal(evaluateTrigger({ kind: 'resource', res: 'humus', amount: '100000' }, state, data, EMPTY_TRIGGER_CONTEXT), true);
  assert.equal(evaluateTrigger({ kind: 'resource', res: 'humus', amount: '1e9' }, state, data, EMPTY_TRIGGER_CONTEXT), false);
});

test('条件求值：未知条件类型返回 false 而不是抛错', () => {
  const state = play(5);
  assert.equal(evaluateTrigger({ kind: 'a_condition_that_does_not_exist_yet', value: 1 }, state, data, EMPTY_TRIGGER_CONTEXT), false);
});

test('成就：满足条件即解锁，且解锁一次不会重复', () => {
  const state = play(20);
  state.graph.links.clear();
  buildLink(state, data, [...state.graph.nodes.keys()][0]!, [...state.graph.nodes.keys()][1]!);
  const first = checkAchievements(state, data, EMPTY_TRIGGER_CONTEXT);
  assert.ok(first.includes('ach_first_link'), `应解锁「第一根线」，实际 ${JSON.stringify(first)}`);
  const second = checkAchievements(state, data, EMPTY_TRIGGER_CONTEXT);
  assert.ok(!second.includes('ach_first_link'), '不应重复解锁');
});

test('成就：解锁后效果真的进入修饰符聚合', () => {
  const state = play(20);
  const before = computeModifiers(state, data).globalOutput;
  state.achievements['ach_100_nodes'] = true; // 该成就带 outputMul 0.05
  const after = computeModifiers(state, data).globalOutput;
  assert.ok(after > before, `成就效果应生效：${before} → ${after}`);
});

test('任务：新手任务按顺序推进，完成后发放奖励', () => {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  // q_first_hypha：建造 1 个分解丝（初始已赠送）
  const done1 = checkQuests(state, data, EMPTY_TRIGGER_CONTEXT);
  assert.ok(done1.some((q) => q.id === 'q_first_hypha'), `第一个新手任务应完成：${JSON.stringify(done1)}`);
  const sporeAfterReward = state.resources.spore!;
  assert.ok(sporeAfterReward.toNumber() > 120, `奖励应到账，实际 ${sporeAfterReward.toString()}`);

  // q_water：建造吸水菌丝（依赖 q_first_hypha 已完成）
  buildNode(state, data, 'hydra_i', 'topsoil', 10, 0, mods);
  const done2 = checkQuests(state, data, EMPTY_TRIGGER_CONTEXT);
  assert.ok(done2.some((q) => q.id === 'q_water'), `第二个任务应完成：${JSON.stringify(done2)}`);
});

test('任务：前置未完成时不会跳过', () => {
  const state = createNewGame(data);
  // 手动把前置标记为未完成，但把后置条件堆满
  state.stats.questsCompleted = ['q_first_hypha'];
  state.graph.links.clear();
  buildLink(state, data, [...state.graph.nodes.keys()][0]!, [...state.graph.nodes.keys()][0]!); // 会失败（自环）
  const done = checkQuests(state, data, EMPTY_TRIGGER_CONTEXT);
  assert.ok(!done.some((q) => q.id === 'q_bruteforce'), '不应跳过前置直接完成远期任务');
});

test('事件：按概率触发并进入 activeEvents，且被记录进 eventsSeen', () => {
  const state = play(120);
  const rng = mulberry32(12345);
  let started = 0;
  for (let i = 0; i < 4000; i++) {
    const r = tickEvents(state, data, 1, rng);
    started += r.started.length;
  }
  assert.ok(started > 0, '长时间推进应至少触发一次事件');
  assert.ok(state.stats.eventsSeen.length > 0, '触发的事件应被记录');
  assert.ok(state.activeEvents.length <= 3, '同时生效事件数量应有上限');
});

test('事件：负面事件不会无限叠加（同时生效上限 3）', () => {
  const state = play(120);
  const rng = mulberry32(999);
  for (let i = 0; i < 20000; i++) tickEvents(state, data, 1, rng);
  assert.ok(state.activeEvents.length <= 3, `实际 ${state.activeEvents.length}`);
});

test('事件效果进入修饰符（产出被事件改变）', () => {
  const state = play(60);
  const before = computeModifiers(state, data).globalOutput;
  state.activeEvents.push({
    instanceId: 'test',
    eventId: 'ev_bloom', // 全局 +30%
    startedAt: 0,
    endsAt: state.elapsed + 1000,
    strength: 1,
    isOffline: false,
  });
  const after = computeModifiers(state, data).globalOutput;
  assert.ok(after > before, `事件应影响产出：${before} → ${after}`);
});

test('事件：过期后被清理', () => {
  const state = play(30);
  state.activeEvents.push({
    instanceId: 'expire-me',
    eventId: 'ev_rain',
    startedAt: 0,
    endsAt: state.elapsed + 5,
    strength: 1,
    isOffline: false,
  });
  for (let i = 0; i < 100; i++) tick(state, data, 0.1, { mods: computeModifiers(state, data) });
  tickEvents(state, data, 1, mulberry32(1));
  assert.equal(state.activeEvents.find((e) => e.instanceId === 'expire-me'), undefined, '过期事件应被移除');
});

test('事件抗性会削减负面事件强度', () => {
  const state = play(30);
  state.questBonuses.push({ kind: 'eventResist', value: 0.4 });
  const m = computeModifiers(state, data);
  assert.ok(m.eventResist >= 0.4, `事件抗性应生效：${m.eventResist}`);
  assert.ok(m.eventResist <= 1, '抗性不应超过 100%');
});

// ---------------------------------------------------------------- 事件有效性过滤

test('事件：对当前局面无效的事件不会被触发（孢子云 vs 没有孢子产出链）', async () => {
  const { eventHasEffect, describeEventEffect } = await import('../src/core/progression/content-engine.ts');
  const { createNewGame } = await import('../src/core/state.ts');
  const { SciNum: S2 } = await import('../src/core/math/scinum.ts');

  const st = createNewGame(data);
  const sporeCloud = data.events.find((e) => e.id === 'ev_spore_cloud')!;
  const bloom = data.events.find((e) => e.id === 'ev_bloom')!;

  // 新开局：没有孢子产出（ratePerSec 空）
  st.ratePerSec = {};
  st.totalProduced = {};
  assert.equal(eventHasEffect(st, data, sporeCloud), false, '没有孢子产出时，孢子云应被判为无效');

  // 全局事件永远有效
  assert.equal(eventHasEffect(st, data, bloom), true, '全局产出加成始终有效');

  // 让孢子真的在产出后，孢子云就有效了
  st.ratePerSec = { spore: 1.5 };
  assert.equal(eventHasEffect(st, data, sporeCloud), true, '有孢子产出后应变有效');

  // 共生类事件需要真的有共生节点
  const sym = data.events.find((e) => e.modifiers.some((m) => m.kind === 'outputMul' && m.class))!;
  const st2 = createNewGame(data);
  st2.ratePerSec = {};
  assert.equal(eventHasEffect(st2, data, sym), false, '没有该节点类时，针对性事件应无效');
  st2.graph.addNode({
    id: 'sym1', typeId: 'algae_i', layerId: 'aquifer', x: 0, y: 0, built: true, active: true, richness: 60,
  } as never);
  assert.equal(eventHasEffect(st2, data, sym), true, '铺了共生体后应变有效');

  // 效果描述必须能翻译成人话
  const text = describeEventEffect(bloom, data);
  assert.match(text, /全局产出 \+30%/, `描述应写清效果，实际：${text}`);
  void S2;
});

test('事件：提示文案包含具体效果（玩家不用猜它改了什么）', async () => {
  const { describeEventEffect } = await import('../src/core/progression/content-engine.ts');
  for (const e of data.events) {
    const text = describeEventEffect(e, data);
    assert.ok(text.length > 0, `${e.id} 的效果描述为空`);
  }
});

// ---------------------------------------------------------------- 效果可观测性验收

test('验收：每一条事件在"对它有效的局面"下都能被数值观测到', async () => {
  const { eventHasEffect, describeEventEffect } = await import('../src/core/progression/content-engine.ts');
  const { computeModifiers, tick } = await import('../src/core/economy/engine.ts');
  const { createNewGame } = await import('../src/core/state.ts');
  const { SciNum: S3 } = await import('../src/core/math/scinum.ts');

  const undetectable: string[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const ev of data.events) {
    // 造一个"尽可能让这条事件有效"的局面：带上各种资源与其他资源产出
    const st = createNewGame(data);
    for (const res of ['humus', 'water', 'sugar', 'spore', 'mineral', 'enzyme', 'toxin', 'honeydew', 'light']) {
      st.ratePerSec[res] = 1;
      st.resources[res] = S3.from(1000);
      st.totalProduced[res] = S3.from(1000);
    }
    // 各节点类都放一个，让"针对某类"的事件也有效
    for (const cls of ['extractor', 'metabolizer', 'symbiont', 'sporifier']) {
      const node = [...data.nodes.values()].find((n) => n.def.class === cls);
      if (!node) continue;
      st.graph.addNode({
        id: `t_${cls}`, typeId: node.def.id, layerId: node.def.layer,
        x: 0, y: 0, built: true, active: true, richness: 60,
      } as never);
    }

    if (!eventHasEffect(st, data, ev)) {
      skipped.push(`${ev.name}（该局面下仍无效，属于设计上的条件性事件）`);
      continue;
    }

    // 立即效果型（duration = 0）在 tickEvents 里结算，这里只验证持续型的修饰符变化
    if (ev.duration <= 0) {
      // 立即效果至少要有可读描述
      const text = describeEventEffect(ev, data);
      if (!text || text.length === 0) undetectable.push(`${ev.name}：没有可读的效果描述`);
      continue;
    }

    const before = computeModifiers(st, data);
    st.activeEvents.push({
      instanceId: 'probe', eventId: ev.id, startedAt: st.elapsed,
      endsAt: st.elapsed + ev.duration, strength: 1, isOffline: false,
    } as never);
    const after = computeModifiers(st, data);

    // 观测点：全局产出、资源加成、类加成、催化、事件抗性…… 只要有一处变了就算可观测
    const changed =
      Math.abs(after.globalOutput - before.globalOutput) > 1e-9 ||
      Math.abs(after.catalystBonus - before.catalystBonus) > 1e-9 ||
      JSON.stringify(after.byRes) !== JSON.stringify(before.byRes) ||
      JSON.stringify(after.byClass) !== JSON.stringify(before.byClass) ||
      JSON.stringify(after.byNode) !== JSON.stringify(before.byNode) ||
      Math.abs(after.globalOutputMul - before.globalOutputMul) > 1e-9;

    if (!changed) {
      // 也可能只影响状态（如土壤/敌意/市场），跑一步 tick 观察资源变化
      const sugarBefore = st.resources['sugar']!.toNumber();
      for (let i = 0; i < 10; i++) tick(st, data, 0.1);
      const sugarAfter = st.resources['sugar']!.toNumber();
      if (Math.abs(sugarAfter - sugarBefore) < 1e-9) {
        undetectable.push(`${ev.name}：注入后修饰符与产出都没有变化`);
        continue;
      }
    }
    checked++;
  }

  assert.equal(
    undetectable.length,
    0,
    `以下事件在被判为"有效"的局面下依然观测不到任何变化：\n${undetectable.join('\n')}`,
  );
  assert.ok(checked >= 15, `实际验证到的事件太少（${checked} 条），验收可能失效`);
  void skipped;
});
