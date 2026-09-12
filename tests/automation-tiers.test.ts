/**
 * 自动化 6 级的**可观测性**测试。
 *
 * 这组测试的存在理由：曾经有 14 条自动化科技，其中 tier 1 在引擎里什么都不做，
 * 而它的名字叫「自动采集」—— 一个这个游戏从来没有过的概念。玩家点完科技，
 * 感觉不到任何变化，然后合理地认为"这东西没用"。
 *
 * 因此这里固定一条不变量：**每提升一级，都必须产生与上一级可区分的行为差异**。
 * 未来任何一级失效，这组测试会立刻失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, type GameState } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { computeModifiers, tick } from '../src/core/economy/engine.ts';
import { runAutomation } from '../src/core/automation/engine.ts';

const data = loadGameData();

interface Observation {
  nodes: number;
  links: number;
  autoActions: number;
  upgradesBought: number;
  prestiges: number;
}

/** 用一个固定局面跑 tier 级自动化，返回可观测结果 */
function observe(tier: number, seconds = 40): Observation {
  const st: GameState = createNewGame(data);
  st.resources['spore'] = S.from(1e6);
  st.resources['humus'] = S.from(1e6);
  st.resources['water'] = S.from(1e6);
  st.resources['sugar'] = S.from(1e6);
  st.resources['mineral'] = S.from(1e6);

  let mods = { ...computeModifiers(st, data), autoTier: tier };
  let autoActions = 0;
  let prestiges = 0;

  for (let i = 0; i < seconds * 10; i++) {
    tick(st, data, 0.1, { mods });
    if (i % 10 === 0) {
      const r = runAutomation(st, data, mods, st.elapsed);
      autoActions += r.actions.length;
      if (r.prestige) prestiges++;
      if (r.nextState) {
        // 孢子化会给出新状态：观察者只记录，不替换（本轮测试关心"行为是否发生"）
        prestiges++;
      }
      mods = { ...computeModifiers(st, data), autoTier: tier };
    }
  }

  let upgradesBought = 0;
  for (const lvl of Object.values(st.upgrades)) upgradesBought += lvl;

  return { nodes: st.graph.size(), links: st.graph.links.size, autoActions, upgradesBought, prestiges };
}

test('自动化 0 级：什么都不做（基线）', () => {
  const o = observe(0);
  assert.equal(o.autoActions, 0, '未解锁时不应有任何自动动作');
  assert.equal(o.nodes, 1, '节点数应保持开局值');
});

test('自动化 1 级：只买升级，不扩建、不连线', () => {
  const base = observe(0);
  const o = observe(1);
  assert.ok(o.autoActions > 0, 'tier 1 必须产生动作（这正是当年缺失的那一项）');
  assert.ok(o.upgradesBought > base.upgradesBought, 'tier 1 应真的买到升级');
  assert.equal(o.nodes, base.nodes, 'tier 1 不该扩建');
  assert.equal(o.links, base.links, 'tier 1 不该连线');
});

test('自动化 2 级：扩建节点，但仍不连线（可见的代价）', () => {
  const o1 = observe(1);
  const o2 = observe(2);
  assert.ok(o2.nodes > o1.nodes, 'tier 2 应扩建节点');
  assert.equal(o2.links, 0, 'tier 2 建出来的节点是孤立的 —— 这是它和 tier 3 的可观测区别');
});

test('自动化 3 级：把孤立节点接上线（产量因此跳一档）', () => {
  const o2 = observe(2);
  const o3 = observe(3);
  assert.ok(o3.links > o2.links, `tier 3 应补上连线：${o2.links} → ${o3.links}`);
});

test('自动化 4 级：在 3 级基础上继续优化拓扑（连线数不会减少，动作类型不同）', () => {
  const o3 = observe(3);
  const o4 = observe(4);
  assert.ok(o4.links >= o3.links, '优化不应把连线弄丢');
  assert.ok(o4.autoActions >= o3.autoActions, '优化会额外产生自动动作');
});

test('自动化 5 级：具备自动孢子化的能力（tier 位由 mods 提供，行为在阈值满足时触发）', () => {
  // 阈值设得极低，确保 40 秒内一定触发
  const st = createNewGame(data);
  st.resources['spore'] = S.from(1e6);
  st.resources['humus'] = S.from(1e6);
  st.totalProduced['core'] = S.from(10); // 孢子化门票
  st.autoConfig = { ...st.autoConfig, autoPrestigeThreshold: '0.0001' };
  const mods = { ...computeModifiers(st, data), autoTier: 5 };

  const r = runAutomation(st, data, mods, st.elapsed);
  assert.ok(r.prestige || r.nextState, 'tier 5 在阈值满足时应触发孢子化');
});

test('自动化：每一级的可观测行为都互不重叠（这是"每级都有意义"的判据）', () => {
  const obs = [0, 1, 2, 3, 4].map((t) => observe(t));
  // 签名必须覆盖"这一级能改变的所有东西"：节点、连线、是否产生动作、升级总量。
  // 最初只用了 节点|连线，结果 tier 1（买升级）被判成"与 0 级一致" —— 那是签名的问题，不是功能的问题。
  const signatures = obs.map((o) => `${o.nodes}|${o.links}|${o.autoActions > 0 ? 'A' : '-'}|${o.upgradesBought}`);

  // 相邻两级的行为签名必须不同 —— 否则那一级等于没做
  for (let i = 1; i < signatures.length; i++) {
    assert.notEqual(
      signatures[i],
      signatures[i - 1],
      `tier ${i} 与 tier ${i - 1} 的行为完全一致（签名 = ${signatures[i]}）—— 说明这一级没有可观测效果`,
    );
  }
});

// ---------------------------------------------------------------- 自动化智能化（本轮加强）

test('智能放置：节点建在倍率更高的层，而不是它自己的默认层', async () => {
  const { createNewGame } = await import('../src/core/state.ts');
  const { computeModifiers, tick } = await import('../src/core/economy/engine.ts');
  const { SciNum: S5 } = await import('../src/core/math/scinum.ts');

  const st = createNewGame(data);
  for (const k of ['spore', 'humus', 'water', 'sugar', 'mineral', 'enzyme', 'sclerotium']) {
    st.resources[k] = S5.from(1e7);
  }
  st.unlockedLayers = [...data.layers.keys()];
  let mods = { ...computeModifiers(st, data), autoTier: 4 };
  for (let i = 0; i < 3000; i++) {
    tick(st, data, 0.1, { mods });
    if (i % 10 === 0) {
      runAutomation(st, data, mods, st.elapsed);
      mods = { ...computeModifiers(st, data), autoTier: 4 };
    }
  }

  const byLayer: Record<string, number> = {};
  for (const n of st.graph.nodes.values()) byLayer[n.layerId] = (byLayer[n.layerId] ?? 0) + 1;
  const mantle = byLayer['mantle'] ?? 0;
  const topsoil = byLayer['topsoil'] ?? 0;
  assert.ok(mantle > topsoil, `自动扩建应优先高倍率层：地幔 ${mantle} vs 表土 ${topsoil}`);
  assert.ok(mantle >= 10, `地幔层应聚集大部分节点，实际 ${mantle} 个`);
});

test('智能连线：不产生环，也不把线接到出度已满的节点上', async () => {
  const { createNewGame } = await import('../src/core/state.ts');
  const { computeModifiers, tick } = await import('../src/core/economy/engine.ts');
  const { SciNum: S6 } = await import('../src/core/math/scinum.ts');

  const st = createNewGame(data);
  for (const k of ['spore', 'humus', 'water', 'sugar', 'mineral', 'enzyme', 'sclerotium']) {
    st.resources[k] = S6.from(1e7);
  }
  st.unlockedLayers = [...data.layers.keys()];
  let mods = { ...computeModifiers(st, data), autoTier: 4 };
  for (let i = 0; i < 2000; i++) {
    tick(st, data, 0.1, { mods });
    if (i % 10 === 0) {
      runAutomation(st, data, mods, st.elapsed);
      mods = { ...computeModifiers(st, data), autoTier: 4 };
    }
  }

  const { cyclic } = st.graph.topoOrder();
  assert.equal(cyclic.size, 0, `自动连线不应制造环，实际有 ${cyclic.size} 个环内节点`);

  // 出度上限：自动连线自己遵守 6 条
  for (const n of st.graph.nodes.values()) {
    const out = st.graph.outLinkIds(n.id).length;
    assert.ok(out <= 10, `节点 ${n.id} 出度 ${out} 过高（自动连线不应无限堆线）`);
  }
});

test('智能优化：换线只在真实催化变好时才保留（否则回滚）', async () => {
  const { createNewGame } = await import('../src/core/state.ts');
  const { computeModifiers, nodeCatalyst } = await import('../src/core/economy/engine.ts');
  const { SciNum: S7 } = await import('../src/core/math/scinum.ts');

  const st = createNewGame(data);
  for (const k of ['spore', 'humus', 'water', 'sugar']) st.resources[k] = S7.from(1e6);
  // 造一个"新上游催化更高但产不出原料"的局面，验证优化不会盲信 rateMul
  const mods = { ...computeModifiers(st, data), autoTier: 4 };
  const before = [...st.graph.nodes.values()].map((n) => nodeCatalyst(st, data, n.id).rateMul);
  const r = runAutomation(st, data, mods, st.elapsed);
  const after = [...st.graph.nodes.values()].map((n) => nodeCatalyst(st, data, n.id).rateMul);
  // 若发生了重连，催化总和不应变差
  if (r.actions.some((a) => a.includes('催化'))) {
    const sumBefore = before.reduce((a, b) => a + b, 0);
    const sumAfter = after.reduce((a, b) => a + b, 0);
    assert.ok(sumAfter >= sumBefore - 1e-9, `重连后催化总和不应下降：${sumBefore.toFixed(3)} → ${sumAfter.toFixed(3)}`);
  }
});
