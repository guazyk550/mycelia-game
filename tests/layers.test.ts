/**
 * Prestige 多层结构测试。
 *
 * 重点不是"函数能跑"，而是把"多层"与"重复重置"区分开：
 *   · 只有 P1 是重置，P2–P5 是跃迁（不焚毁网络）；
 *   · 不能跳级；
 *   · 门槛即成本（防止囤积后一次连跳两级）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { LAYERS, advanceLayer, hasLayer, listLayers, readGate } from '../src/core/prestige/layers.ts';
import { computeModifiers } from '../src/core/economy/engine.ts';

const data = loadGameData();

function atLevel(level: number) {
  const st = createNewGame(data);
  st.prestige = { ...st.prestige, level };
  return st;
}

test('层级：定义完整且层级号连续（p1–p5）', () => {
  assert.equal(LAYERS.length, 5);
  assert.deepEqual(
    LAYERS.map((l) => l.level),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    LAYERS.map((l) => l.id),
    ['p1', 'p2', 'p3', 'p4', 'p5'],
  );
  // 只有第一层是重置型
  assert.equal(LAYERS.filter((l) => l.isReset).length, 1);
  assert.equal(LAYERS[0]!.isReset, true);
});

test('层级：新开局时只有 p1 是"下一个"，其余都要求先达成前一层', () => {
  const st = createNewGame(data);
  const infos = listLayers(st, data);
  assert.equal(infos[0]!.isNext, true, 'p1 应是下一个可推进层');
  assert.equal(infos[0]!.reached, false);
  for (const info of infos.slice(1)) {
    assert.equal(info.isNext, false);
    assert.match(info.reason, /需要先达成第 \d+ 层/);
  }
});

test('层级：不能跳级（p1 未达成时推进 p2 必须失败）', () => {
  const st = atLevel(0);
  // 就算把资源塞满也不该能跳级
  st.resources['gene'] = S.from(1e6);
  st.prestige = { ...st.prestige, sporogene: S.from(1e6) };

  const res = advanceLayer(st, data);
  assert.equal(res.ok, false);
  assert.match(res.reason, /第 1 层是孢子化/);
});

test('层级：门槛不足时给出可读的缺口说明', () => {
  const st = atLevel(1);
  st.prestige = { ...st.prestige, sporogene: S.from(100) }; // 需要 500
  st.resources['gene'] = S.from(5); // 需要 20

  const infos = listLayers(st, data);
  const p2 = infos.find((i) => i.meta.id === 'p2')!;
  assert.equal(p2.isNext, true);
  assert.equal(p2.ready, false);
  assert.match(p2.reason, /还差/);
  assert.match(p2.reason, /孢子基因 100\/500/);
  assert.match(p2.reason, /基因片段 5\/20/);

  const res = advanceLayer(st, data);
  assert.equal(res.ok, false);
  assert.match(res.reason, /还差/);
});

test('层级：门槛即成本 —— 达成后资源被扣掉，防止囤积连跳', () => {
  const st = atLevel(1);
  st.prestige = { ...st.prestige, sporogene: S.from(500) };
  st.resources['gene'] = S.from(20);

  const res = advanceLayer(st, data);
  assert.equal(res.ok, true);
  assert.equal(res.layer!.id, 'p2');
  assert.equal(res.state!.prestige.level, 2);

  // 孢子基因与基因片段都被扣空
  assert.equal(readGate(res.state!, 'sporogene').toNumber(), 0, '孢子基因应被扣掉 500');
  assert.equal(readGate(res.state!, 'gene').toNumber(), 0, '基因片段应被扣掉 20');

  // 刚跳完 p2，p3 立刻也需要重新积累（不能连跳）
  const infos = listLayers(res.state!, data);
  const p3 = infos.find((i) => i.meta.id === 'p3')!;
  assert.equal(p3.isNext, true);
  assert.equal(p3.ready, false, '刚花完资源，下一层不该立刻可跳');
});

test('层级：advanceLayer 不修改传入的 state（纯函数语义）', () => {
  const st = atLevel(1);
  st.prestige = { ...st.prestige, sporogene: S.from(500) };
  st.resources['gene'] = S.from(20);
  const before = st.prestige.level;

  advanceLayer(st, data);
  assert.equal(st.prestige.level, before, '原状态不应被改动');
  assert.equal(st.prestige.sporogene.toNumber(), 500, '原状态的孢子基因不应被扣');
});

test('层级：hasLayer 与 reached 在达成后一致', () => {
  const st = atLevel(2);
  assert.equal(hasLayer(st, 1), true);
  assert.equal(hasLayer(st, 2), true);
  assert.equal(hasLayer(st, 3), false);

  const infos = listLayers(st, data);
  assert.equal(infos.find((i) => i.meta.id === 'p1')!.reached, true);
  assert.equal(infos.find((i) => i.meta.id === 'p2')!.reached, true);
  assert.equal(infos.find((i) => i.meta.id === 'p3')!.isNext, true);
});

test('层级：每一层的门槛都引用了真实存在的资源或 prestige 字段', () => {
  const st = createNewGame(data);
  const infos = listLayers(st, data);
  for (const info of infos) {
    for (const r of info.requirements) {
      assert.ok(r.need.isPositive(), `${info.meta.id} 的 ${r.key} 门槛应为正数`);
      // 标签必须解析成人类可读的名字（不能回落到 id 之外的空串）
      assert.ok(r.label.length > 0, `${info.meta.id} 的 ${r.key} 缺少可读标签`);
    }
  }
  // p1 是无门槛的重置层
  assert.equal(infos[0]!.requirements.length, 0, 'p1 由孢子化本身作为门槛，不应有额外资源要求');
});

// ---------------------------------------------------------------- doPrestige 的多层保留规则

test('孢子化：首次即第 1 层，且不会倒退已达成层级', async () => {
  const { doPrestige } = await import('../src/core/prestige/prestige.ts');
  const st = createNewGame(data);
  // 造出"曾产出过共生核心"的门票
  st.totalProduced['core'] = S.from(10);
  const r1 = doPrestige(st, data);
  assert.equal(r1.state.prestige.level, 1, '第一次孢子化就是第 1 层');
  assert.equal(r1.report.layer, 1);

  // 已达第 3 层的人孢子化后层级不应掉回 1
  const st3 = createNewGame(data);
  st3.totalProduced['core'] = S.from(10);
  st3.prestige = { ...st3.prestige, level: 3 };
  const r3 = doPrestige(st3, data);
  assert.equal(r3.state.prestige.level, 3, '孢子化不应让已达成层级倒退');
});

test('孢子化：P3 解锁的自动化规则与任务加成必须跨世代保留', async () => {
  const { doPrestige } = await import('../src/core/prestige/prestige.ts');
  const st = createNewGame(data);
  st.totalProduced['core'] = S.from(10);
  st.prestige = { ...st.prestige, level: 3 };
  st.autoRules = [{ id: 'r1', enabled: true, cond: { kind: 'resAbove', res: 'sugar', value: '100' }, act: { kind: 'build', node: 'decomposer_i' } } as never];
  st.questBonuses = [{ kind: 'outputMul', value: 0.05 } as never];

  const r = doPrestige(st, data);
  assert.equal(r.state.autoRules.length, 1, '自动化规则不该被重置清空');
  assert.equal(r.state.questBonuses.length, 1, '任务奖励加成不该被重置清空');
  assert.equal(r.report.keptAutoRules, 1);
  assert.equal(r.report.keptQuestBonuses, 1);
});

test('孢子化：菌株与切换冷却一起跨世代（换流派不需要重付冷却）', async () => {
  const { doPrestige } = await import('../src/core/prestige/prestige.ts');
  const st = createNewGame(data);
  st.totalProduced['core'] = S.from(10);
  st.prestige = { ...st.prestige, level: 2, strain: 'rotten', lastStrainSwitchAt: 1234 };

  const r = doPrestige(st, data);
  assert.equal(r.state.prestige.strain, 'rotten', '菌株应保留');
  assert.equal(r.state.prestige.lastStrainSwitchAt, 1234, '冷却时间戳应保留（不能靠重置刷新）');
});

test('层级：P3 让自动化规则槽 +2（层级要带来能力，不只是数字）', () => {
  const base = computeModifiers(atLevel(2), data);
  const p3 = computeModifiers(atLevel(3), data);
  assert.equal(p3.ruleSlots - base.ruleSlots, 2, 'P3 虫巢意识应带来 +2 规则槽');
});
