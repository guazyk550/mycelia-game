/**
 * 菌株（Build）验收测试 —— PHASE 4 批次 C。
 *
 * 这些测试要证明的不是"菌株能被选中"，而是"选了真的不一样"：
 *   · 切换会改修饰符（产出/成本/土壤/离线）
 *   · 冷却与解锁门槛真的拦得住
 *   · 每种菌株的代价真的生效（不是只有好处）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { computeModifiers, nodeCost } from '../src/core/economy/engine.ts';
import {
  activeSpecials,
  listStrains,
  strainCooldownLeft,
  switchStrain,
} from '../src/core/prestige/strains.ts';
import { doPrestige } from '../src/core/prestige/prestige.ts';

const data = loadGameData();

/** 造一个可以自由切菌株的局面：第 3 层 + 充足基因片段 */
function richState() {
  const st = createNewGame(data);
  st.prestige = { ...st.prestige, level: 3, lastStrainSwitchAt: -1 };
  st.resources['gene'] = S.from(1000);
  return st;
}

test('菌株：数据表 6 种全部可加载，开局可用 2 种', () => {
  const st = richState();
  const list = listStrains(st, data);
  assert.equal(list.length, 6);
  const starters = list.filter((s) => s.def.unlockLevel === 0);
  assert.equal(starters.length, 2, '开局就应该有两种流派可选，否则第一局只有唯一解');
});

test('菌株：层级不够则不可选，且给出可读原因', () => {
  const st = createNewGame(data); // level 0
  const list = listStrains(st, data);
  const parasite = list.find((s) => s.def.id === 'parasite')!;
  assert.equal(parasite.levelOk, false);
  assert.equal(parasite.selectable, false);
  assert.match(parasite.reason, /第 1 层/);

  const res = switchStrain(st, data, 'parasite');
  assert.equal(res.ok, false);
  assert.match(res.reason, /第 1 层/);
});

test('菌株：基因片段不够则不可选（成本真的扣）', () => {
  const st = richState();
  st.resources['gene'] = S.from(0);
  const res = switchStrain(st, data, 'weaver'); // 需要 25
  assert.equal(res.ok, false);
  assert.match(res.reason, /基因片段/);

  st.resources['gene'] = S.from(100);
  const ok = switchStrain(st, data, 'weaver');
  assert.equal(ok.ok, true);
  assert.equal(ok.state!.resources['gene']!.toNumber(), 75, '应精确扣除 25 基因片段');
  assert.equal(ok.state!.prestige.strain, 'weaver');
});

test('菌株：切换有冷却，冷却期内不能再切；而且冷却不因孢子化重置', () => {
  const st = richState();
  const first = switchStrain(st, data, 'rotten');
  assert.equal(first.ok, true);
  const s1 = first.state!;

  assert.ok(strainCooldownLeft(s1, data) > 0, '刚切换完应处于冷却中');
  const second = switchStrain(s1, data, 'symbiont');
  assert.equal(second.ok, false);
  assert.match(second.reason, /冷却/);

  // 时间推进超过冷却
  const later = { ...s1, elapsed: s1.elapsed + 24 * 3600 + 1 };
  assert.equal(strainCooldownLeft(later, data), 0);
  assert.equal(switchStrain(later, data, 'symbiont').ok, true);

  // 孢子化后冷却仍在（防止"重置一次刷新冷却"）
  const afterPrestige = doPrestige(s1, data).state;
  assert.equal(afterPrestige.prestige.lastStrainSwitchAt, s1.prestige.lastStrainSwitchAt);
  assert.ok(strainCooldownLeft(afterPrestige, data) > 0, '孢子化不应刷新切换冷却');
});

test('菌株：腐生真的改产出、也真的改土壤枯竭（有得必有失）', () => {
  const st = richState();
  const base = computeModifiers(st, data);
  st.prestige.strain = 'rotten';
  const rotten = computeModifiers(st, data);

  assert.equal((rotten.byClass.extractor ?? 0) - (base.byClass.extractor ?? 0), 0.6, '采集类 +60%');
  assert.equal(rotten.depletionMul, 1.2, '土壤枯竭速度 +120%');
  assert.ok(activeSpecials(st, data).has('soil_no_self_repair'));
});

test('菌株：共生提升离线、压低手动；寄生抗事件更差；孢子全局产出更低', () => {
  const st = richState();

  st.prestige.strain = 'symbiont';
  const sym = computeModifiers(st, data);
  assert.ok(sym.offlineEfficiency > 0.4, '共生应有明显离线效率加成');
  assert.ok(sym.manualMul < 0, '共生的手动连击应被削弱（代价）');
  assert.ok(sym.specials.has('offline_cap_24h'));

  st.prestige.strain = 'parasite';
  const par = computeModifiers(st, data);
  assert.ok(par.eventResist < 0, '寄生的事件抗性应为负（代价）');
  assert.ok((par.byRes.toxin ?? 0) > 0.7, '寄生应大幅提升毒素产出');
  assert.ok(par.specials.has('negative_event_profit'));

  st.prestige.strain = 'sporer';
  const spo = computeModifiers(st, data);
  assert.ok(spo.prestigeGain > 0.4, '孢子化收益加成');
  assert.ok(spo.globalOutput < 0, '孢子菌株的代价是全局产出下降');
  assert.ok(spo.specials.has('sporogene_keep_10pct'));
});

test('菌株：催化菌株真的改写成本曲线（不是只给折扣）', () => {
  const st = richState();
  const node = data.nodes.get('decomposer_i')!;
  const baseMods = computeModifiers(st, data);
  const baseCost = nodeCost(st, data, 'decomposer_i', baseMods)[0]!.amount;

  st.prestige.strain = 'catalyst';
  const catMods = computeModifiers(st, data);
  const catCost = nodeCost(st, data, 'decomposer_i', catMods)[0]!.amount;

  assert.equal(catMods.costGrowthAdd, 0.03);
  assert.ok(
    S.gt(catCost, baseCost),
    `催化菌株的成本应更高（增长率 ${node.costGrowth} → ${node.costGrowth + 0.03}）：${baseCost.toString()} vs ${catCost.toString()}`,
  );
});

test('菌株：织网的加成随连线数增长（奖励"多连"而不是"多造"）', () => {
  const st = richState();
  st.prestige.strain = 'weaver';
  const zero = computeModifiers(st, data).globalOutput;

  // 造 25 条连线 → 应拿到 2 × 8% 的全局加成
  for (let i = 0; i < 25; i++) {
    const before = { id: `n_before_${i}`, typeId: 'decomposer_i', layerId: 'topsoil', x: i * 100, y: 0, built: true, active: true, richness: 1 };
    const after = { id: `n_after_${i}`, typeId: 'saccharifier_i', layerId: 'topsoil', x: i * 100, y: 100, built: true, active: true, richness: 1 };
    st.graph.addNode(before as never);
    st.graph.addNode(after as never);
    st.graph.addLink({ id: `l_${i}`, from: before.id, to: after.id, flux: 1 } as never);
  }
  const many = computeModifiers(st, data).globalOutput;
  assert.ok(many > zero, '连线变多后应有额外全局加成');
  assert.ok(many - zero > 0.15, `25 条连线应带来约 +16%：实际 +${((many - zero) * 100).toFixed(1)}%`);
});

test('菌株：切换会写进图鉴名单，且 strainsUsed 只增不重复计', () => {
  const st = richState();
  const a = switchStrain(st, data, 'rotten').state!;
  // 切换函数**自己**就把菌株写进图鉴名单：早期版本只加 strainsUsed 却不写名单，
  // 导致切回用过的菌株会被重复计数（六种表达类成就会提前解锁）。
  assert.deepEqual(a.stats.strainCodex, ['rotten']);
  assert.equal(a.stats.strainsUsed, 1);

  // 用时间推进绕过冷却，切到第二种
  const later = { ...a, elapsed: a.elapsed + 25 * 3600 };
  const b = switchStrain(later, data, 'symbiont').state!;
  assert.equal(b.stats.strainSwitchCount, 2);
});

test('菌株：无菌株（新开局）时修饰符里不应出现任何菌株痕迹', () => {
  const st = createNewGame(data);
  const m = computeModifiers(st, data);
  assert.equal(m.depletionMul, 0);
  assert.equal(m.manualMul, 0);
  assert.equal(m.costGrowthAdd, 0);
  assert.equal(m.specials.size, 0);
});
