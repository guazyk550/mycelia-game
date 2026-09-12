/**
 * 菌株与 Prestige 的**行为级**验收。
 *
 * 前面的 strains/layers 测试验证的是"修饰符算得对"；这里验证的是
 * "跑起来真的不一样" —— 用真实 tick 驱动，比较同一局面下不同菌株的实际产量。
 * 这类测试最容易发现"修饰符算了但引擎没读"的接线错误。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { computeModifiers, tick } from '../src/core/economy/engine.ts';
import { advanceLayer, listLayers } from '../src/core/prestige/layers.ts';
import { switchStrain } from '../src/core/prestige/strains.ts';

const data = loadGameData();

/** 跑真实的 tick（默认 60 秒游戏时间） */
function run(st: ReturnType<typeof createNewGame>, seconds = 60): void {
  const dt = 0.1;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) tick(st, data, dt);
}

/** 造一个"有土壤、能长时间采集"的局面 */
function farmState(strain: string | null) {
  const st = createNewGame(data);
  st.prestige = { ...st.prestige, strain, lastStrainSwitchAt: -1 };
  // 给足土壤富饶度（注意：富饶度是 0–richnessBase 的点数，不是 0–1 的比例；
  // 设成 1 会被 floor 直接 clamp 到下限，导致枯竭速度这类测试失去意义）
  for (const node of st.graph.nodes.values()) {
    node.richness = data.layers.get(node.layerId)?.richnessBase ?? 70;
  }
  return st;
}

test('行为验收：腐生菌株在同样局面下的实际腐殖质产出显著更高', () => {
  const plain = farmState(null);
  const rotten = farmState('rotten');

  run(plain, 60);
  run(rotten, 60);

  const a = plain.totalProduced['humus'] ?? S.ZERO;
  const b = rotten.totalProduced['humus'] ?? S.ZERO;
  assert.ok(a.isPositive(), '基础方案应产出腐殖质（否则测试本身失效）');
  const ratio = S.div(b, a).toNumber();
  assert.ok(ratio > 1.4, `腐生应有明显提升（+60% 产出）：实际 ×${ratio.toFixed(2)}`);
});

test('行为验收：腐生菌株的土壤枯竭确实更快（代价在真实 tick 里生效）', () => {
  const plain = farmState(null);
  const rotten = farmState('rotten');

  run(plain, 120);
  run(rotten, 120);

  const pick = (st: ReturnType<typeof createNewGame>): number => {
    const first = [...st.graph.nodes.values()][0]!;
    return first.richness;
  };
  assert.ok(pick(rotten) < pick(plain), `腐生的土壤应更快枯竭：${pick(plain).toFixed(3)} vs ${pick(rotten).toFixed(3)}`);
});

test('行为验收：孢子菌株的全局产出惩罚在真实 tick 里生效', () => {
  const plain = farmState(null);
  const sporer = farmState('sporer');
  // 孢子菌株需要第 2 层才能表达，但这里直接设置以隔离"产出惩罚"这一项
  run(plain, 60);
  run(sporer, 60);

  const a = plain.totalProduced['humus'] ?? S.ZERO;
  const b = sporer.totalProduced['humus'] ?? S.ZERO;
  const ratio = S.div(b, a).toNumber();
  assert.ok(ratio < 0.85, `孢子菌株应有 -30% 全局产出代价：实际 ×${ratio.toFixed(2)}`);
});

test('行为验收：完整链路 —— 孢子化到第 1 层 → 攒够资源跃迁到第 2 层 → 菌株从此可选', () => {
  const st = createNewGame(data);

  // 第 1 层：孢子化（直接把门票与收益条件凑齐）
  st.totalProduced['core'] = S.from(100);
  st.prestige = { ...st.prestige, sporogene: S.from(500) };
  st.resources['gene'] = S.from(20);

  // 第 0 层时不能跃迁（跳级被拦）
  const blocked = advanceLayer(st, data);
  assert.equal(blocked.ok, false, '未孢子化时不能直接跃迁到第 2 层');

  // 模拟孢子化后的层级提升
  const afterSpore = { ...st, prestige: { ...st.prestige, level: 1 } };
  const infos = listLayers(afterSpore, data);
  assert.equal(infos.find((i) => i.meta.id === 'p2')!.isNext, true);

  // 跃迁到第 2 层
  const up = advanceLayer(afterSpore, data);
  assert.equal(up.ok, true, up.reason);
  assert.equal(up.state!.prestige.level, 2);

  // 第 2 层后 high-tier 菌株才可选
  const s = { ...up.state!, resources: { ...up.state!.resources, gene: S.from(50) } };
  const res = switchStrain(s, data, 'parasite'); // unlockLevel 1
  assert.equal(res.ok, true, `第 2 层应能表达寄生菌株：${res.reason}`);
  assert.equal(res.state!.prestige.strain, 'parasite');
});

test('行为验收：菌株产出的资源并不"凭空突破上限"（防 NaN/Infinity）', () => {
  const st = farmState('catalyst');
  run(st, 300);
  for (const [id, v] of Object.entries(st.resources)) {
    assert.ok(v.isFinite(), `资源 ${id} 出现非有限值`);
    assert.ok(!v.isNegative(), `资源 ${id} 变成负数`);
  }
  const m = computeModifiers(st, data);
  assert.ok(Number.isFinite(m.globalOutput) && Number.isFinite(m.depletionMul));
});

test('行为验收：切换菌株后立刻重新结算，产出方向随之反转', () => {
  const st = farmState(null);
  run(st, 30);
  const before = st.totalProduced['humus'] ?? S.ZERO;

  // 切到腐生（模拟冷却已过）
  const switched = switchStrain({ ...st, resources: { ...st.resources, gene: S.from(100) } }, data, 'rotten').state!;
  run(switched, 30);
  const afterSwitch = switched.totalProduced['humus'] ?? S.ZERO;

  const plainMore = S.sub(afterSwitch, before).toNumber();
  assert.ok(plainMore > 0, '切换后应继续产出');
  // 同长度时间片内，腐生的增量应大于无菌株方案
  const control = farmState(null);
  run(control, 30);
  const controlGain = (control.totalProduced['humus'] ?? S.ZERO).toNumber();
  assert.ok(plainMore > controlGain * 1.2, `切换后 30 秒增量应更高：${plainMore.toFixed(1)} vs ${controlGain.toFixed(1)}`);
});
