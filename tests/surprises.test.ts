/**
 * 惊喜机制验收：时间银行、镜像网络、事件链。
 *
 * 这些机制的共同点是"藏在系统里" —— 玩家不会在教程里被告知，
 * 但它们必须真的按描述工作，而不是数据表里的一句漂亮话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, type GameState } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { computeModifiers, tick } from '../src/core/economy/engine.ts';
import { timeBankView, tickTimeBank, withdrawTimeBank } from '../src/core/meta/timebank.ts';
import { tickEvents } from '../src/core/progression/content-engine.ts';

const data = loadGameData();

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

function run(st: GameState, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 10); i++) tick(st, data, 0.1);
}

test('时间银行：随时间累积、有上限、取出按当前速率结算并扣损耗', () => {
  const st = createNewGame(data);
  st.techs[data.config.timeBank.unlockTech] = true;

  const capSec = data.config.timeBank.capHours * 3600;
  run(st, 120); // 120 秒 → 存入 120 * 0.05 = 6 秒
  const view = timeBankView(st, data);
  assert.ok(view.unlocked, '解锁科技后应可用');
  assert.ok(Math.abs(view.storedSec - 6) < 0.2, `应存入约 6 秒，实际 ${view.storedSec}`);

  // 上限：直接灌到超过上限再 tick
  st.timeBank.storedSec = capSec + 1000;
  tickTimeBank(st, data, 1);
  assert.ok(st.timeBank.storedSec <= capSec, '不应超过上限');

  // 取出：应拿到 (储存秒数 × 当前速率 × (1-损耗))
  const before = st.resources['humus']!.toNumber();
  const stored = st.timeBank.storedSec;
  const rate = st.ratePerSec['humus'] ?? 0;
  assert.ok(rate > 0, '应有腐殖质产出（否则测试无意义）');

  const res = withdrawTimeBank(st, data);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.state!.timeBank.storedSec, 0, '取出后应清零');

  const expected = rate * stored * (1 - data.config.timeBank.withdrawLoss);
  const actual = res.state!.resources['humus']!.toNumber() - before;
  assert.ok(Math.abs(actual - expected) < expected * 0.05, `取出量应接近预期：${actual} vs ${expected}`);
});

test('时间银行：空银行不能取出；取出不影响原状态的纯净性', () => {
  const st = createNewGame(data);
  assert.equal(withdrawTimeBank(st, data).ok, false, '空银行应拒绝');

  run(st, 200);
  const beforeStored = st.timeBank.storedSec;
  withdrawTimeBank(st, data);
  assert.equal(st.timeBank.storedSec, beforeStored, '不应修改传入的 state');
});

test('镜像网络：让邻居的产出真的翻倍（数据表里 structural.mirrorAdjacent 的落地）', () => {
  const plain = createNewGame(data);
  const mirrored = createNewGame(data);

  // 两面都放一个糖化腔（下游），镜像局面再放一个镜像节点连向它
  for (const st of [plain, mirrored]) {
    st.graph.addNode({ id: 'down', typeId: 'saccharifier_i', layerId: 'topsoil', x: 200, y: 0, built: true, active: true, richness: 60 } as never);
    st.resources['humus'] = S.from(1e6);
    st.resources['water'] = S.from(1e6);
  }
  mirrored.graph.addNode({ id: 'mir', typeId: 'mirror_node', layerId: 'topsoil', x: 0, y: 200, built: true, active: true, richness: 60 } as never);
  mirrored.graph.addLink({ id: 'l_mir', from: 'mir', to: 'down', fluxCap: '0' } as never);

  const mA = computeModifiers(mirrored, data);
  assert.ok((mA.mirroredNodes['saccharifier_i'] ?? 0) > 0, '镜像节点应给邻居类型加上产出加成');

  run(plain, 30);
  run(mirrored, 30);
  const a = plain.totalProduced['sugar']!.toNumber();
  const b = mirrored.totalProduced['sugar']!.toNumber();
  assert.ok(b > a, `被镜像的邻居应产出更多：${a.toFixed(2)} vs ${b.toFixed(2)}`);
});

test('虫巢枢纽：global.allProductionMul 作为乘性倍率生效', () => {
  const st = createNewGame(data);
  st.graph.addNode({ id: 'hub', typeId: 'hive_hub', layerId: 'topsoil', x: 0, y: 200, built: true, active: true, richness: 60 } as never);
  st.resources['pheromone'] = S.from(1e6);
  const m = computeModifiers(st, data);
  assert.ok(m.globalOutputMul > 1, `全局乘性倍率应 > 1，实际 ${m.globalOutputMul}`);
  assert.ok(Math.abs(m.globalOutputMul - data.nodes.get('hive_hub')!.recipe.global!.allProductionMul!) < 1e-9);
});

test('事件链：同一 chainTag 连续三次 → 获得共生回声', () => {
  const st = createNewGame(data);
  // 用固定种子反复抽取，直到凑满三次同链（或超时）
  const rng = mulberry32(4242);
  let gained = false;
  for (let i = 0; i < 4000 && !gained; i++) {
    st.activeEvents = [];
    const r = tickEvents(st, data, 5, rng);
    if (r.echoGained) gained = true;
  }
  assert.ok(gained, '连续同链三次应产出共生回声');
  assert.ok((st.resources['echo'] ?? S.ZERO).isPositive(), '回声资源应真的增加');
  assert.equal(st.stats.echoesFound, 1);
});

test('事件链：链标签被打断时重新计数（不是累计三次）', () => {
  const st = createNewGame(data);
  st.stats.lastChainTag = 'chain_green';
  st.stats.chainStreak = 2;
  // 换一条链 → 计数应回到 1
  const rng = mulberry32(777);
  for (let i = 0; i < 200; i++) {
    st.activeEvents = [];
    const r = tickEvents(st, data, 5, rng);
    if (r.started.length > 0) {
      const tag = r.started[0]!.chainTag;
      if (tag && tag !== 'chain_green') {
        assert.equal(st.stats.chainStreak, 1, '换链后应重新计数');
        break;
      }
    }
  }
});

test('虚空菌床：贫瘠世界挑战掉落虚空孢子，孢子解锁隐藏层与隐藏节点', async () => {
  const { emptyChallengeState, startChallenge, settleChallenge } = await import('../src/core/challenges/challenge-engine.ts');

  const st = createNewGame(data);
  st.challenges = emptyChallengeState();
  const started = startChallenge(st, data, 'ch_barren');
  assert.equal(started.ok, true, started.reason);
  const during: GameState = { ...st, challenges: started.challenge! };

  // 达成贫瘠世界的目标：孢子基因 ≥ 25
  during.prestige = { ...during.prestige, sporogene: S.from(25) };
  const settled = settleChallenge(during, data);
  assert.equal(settled.ok, true, settled.reason);
  assert.ok((settled.state!.resources['voidspore'] ?? S.ZERO).isPositive(), '应掉落虚空孢子');

  // 孢子解锁隐藏层
  const withSpore = settled.state!;
  const before = withSpore.unlockedLayers.length;
  for (let i = 0; i < 20; i++) tick(withSpore, data, 1);
  assert.ok(withSpore.unlockedLayers.includes('voidbed'), '虚空孢子应解锁隐藏层 voidbed');
  assert.ok(withSpore.unlockedLayers.length > before);

  // 隐藏层上的隐藏节点可用，且层倍率确实更高
  const voidLayer = data.layers.get('voidbed')!;
  assert.ok(voidLayer.depthMul > data.layers.get('topsoil')!.depthMul, '隐藏层的产出倍率应更高');
  assert.equal(voidLayer.unlock.type, 'resource');
});

test('虚空菌床：数据表里的隐藏层与隐藏节点真的已接线（不是只写在 JSON 里）', () => {
  const layer = data.layers.get('voidbed');
  assert.ok(layer, '隐藏层应被 loader 读到');
  const node = data.nodes.get('void_culture');
  assert.ok(node, '隐藏节点应被 loader 读到');
  assert.equal(node!.def.layer, 'voidbed');
  assert.equal(data.resources.get('voidspore')!.def.hidden, true, '虚空孢子应保持隐藏（不出现在合成表常规列表）');
});

test('规则碎片：自定义催化规则生效，且受总量守恒约束', async () => {
  const { addCustomRule, customRuleBudgetUsed, customRuleFor, removeCustomRule, CUSTOM_RULE_BUDGET } =
    await import('../src/core/meta/laws.ts');
  const { nodeCatalyst } = await import('../src/core/economy/engine.ts');

  const tag = [...data.nodes.values()][0]!.def.catalystTag;
  const st = createNewGame(data);

  // 写一条：上游 tag → metabolizer ×1.5
  const r = addCustomRule(st, data, tag, 'metabolizer', 1.5);
  assert.equal(r.ok, true, r.reason);
  assert.equal(customRuleFor(r.state!, tag, 'metabolizer'), 1.5);
  assert.ok(Math.abs(customRuleBudgetUsed(r.state!) - 0.5) < 1e-9);

  // 超出预算应被拒绝
  const tooMuch = addCustomRule(r.state!, data, tag, 'extractor', 1.9);
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.reason, /总量守恒/);

  // 覆盖同一条组合不叠加预算
  const overwrite = addCustomRule(r.state!, data, tag, 'metabolizer', 1.2);
  assert.equal(overwrite.ok, true);
  assert.ok(Math.abs(customRuleBudgetUsed(overwrite.state!) - 0.2) < 1e-9, '覆盖应替换而非叠加');

  // 删除释放预算
  const removed = removeCustomRule(overwrite.state!, tag, 'metabolizer');
  assert.ok(customRuleBudgetUsed(removed) < 1e-9);
  assert.ok(CUSTOM_RULE_BUDGET > 0);
});

test('规则碎片：自定义规则真的改变催化结果（不是只存在 state 里）', async () => {
  const { addCustomRule } = await import('../src/core/meta/laws.ts');
  const { nodeCatalyst } = await import('../src/core/economy/engine.ts');

  // 造一个"上游 → 下游"的连线，让下游拿到催化
  const build = (withCustom: boolean): number => {
    let st = createNewGame(data);
    const up = [...data.nodes.values()].find((n) => n.def.class === 'extractor')!;
    const tag = up.def.catalystTag;
    const down = [...data.nodes.values()].find((n) => n.def.class === 'metabolizer' && n.def.layer === 'topsoil');
    if (!down) return 0;
    st.graph.addNode({ id: 'u', typeId: up.def.id, layerId: 'topsoil', x: 0, y: 0, built: true, active: true, richness: 60 } as never);
    st.graph.addNode({ id: 'd', typeId: down.def.id, layerId: 'topsoil', x: 100, y: 0, built: true, active: true, richness: 60 } as never);
    st.graph.addLink({ id: 'l1', from: 'u', to: 'd', fluxCap: '0' } as never);

    if (withCustom) {
      const r = addCustomRule(st, data, tag, 'metabolizer', 2.0);
      if (r.ok && r.state) st = r.state;
    }
    return nodeCatalyst(st, data, 'd').rateMul;
  };

  const plain = build(false);
  const custom = build(true);
  assert.ok(custom > plain, `自定义规则应提高催化倍率：${plain.toFixed(3)} → ${custom.toFixed(3)}`);
});
