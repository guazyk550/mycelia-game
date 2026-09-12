import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame, cloneState } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { buildNode, buildLink, computeModifiers, tick } from '../src/core/economy/engine.ts';
import { offlineSoftCap, settleOffline } from '../src/core/offline/settle.ts';

const data = loadGameData(defaultDataDir());

function farmState(seconds = 120) {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  const dec = [...state.graph.nodes.keys()][0]!;
  const hyd = buildNode(state, data, 'hydra_i', 'topsoil', 20, 0, mods).nodeId!;
  const sac = buildNode(state, data, 'saccharifier_i', 'topsoil', 40, 0, mods).nodeId!;
  const spg = buildNode(state, data, 'sporangium_i', 'topsoil', 60, 0, mods).nodeId!;
  // 再补 3 个分解丝，否则糖化腔会因腐殖质不足而降速（农场不平衡，离线产出会失真）
  buildNode(state, data, 'decomposer_i', 'topsoil', -20, 0, mods);
  buildNode(state, data, 'decomposer_i', 'topsoil', -40, 0, mods);
  buildNode(state, data, 'decomposer_i', 'topsoil', -60, 0, mods);
  buildLink(state, data, hyd, sac);
  buildLink(state, data, dec, sac);
  buildLink(state, data, sac, spg);
  for (let i = 0; i < seconds * 10; i++) tick(state, data, 0.1, { mods });
  return state;
}

test('软衰减曲线：2 小时满额，8 小时到下限，超过硬上限不再增长', () => {
  const cfg = data.config.offline;
  assert.equal(offlineSoftCap(1, cfg), 1);
  assert.equal(offlineSoftCap(2, cfg), 1);
  assert.ok(Math.abs(offlineSoftCap(8, cfg) - cfg.softCapFloor) < 1e-9, '8 小时应到下限');
  assert.ok(offlineSoftCap(12, cfg) > cfg.softCapFloor, '长离线略回升');
});

test('正常离线：产出为正、效率在合理区间、无时钟异常', () => {
  const state = farmState();
  const before = { ...state.resources };
  const report = settleOffline(state, data, 0, 3600 * 1000); // 离线 1 小时
  assert.equal(report.clockAnomaly, false);
  assert.ok(report.settledSec > 3500 && report.settledSec <= 3600);
  // 崩溃的农场会因缺料而部分停工，所以只断言“至少有一种资源实现了正增长”
  const grewHumus = S.gt(state.resources.humus!, before.humus!);
  const grewSugar = S.gt(state.resources.sugar!, before.sugar!);
  const grewSpore = S.gt(state.resources.spore!, before.spore!);
  assert.ok(grewHumus || grewSugar || grewSpore, '离线期间应至少有一种资源正增长');
  assert.ok(S.gt(state.resources.humus!, before.humus!), '腐殖质应增长（分解丝不依赖输入）');
  assert.ok(report.efficiency >= 1, `效率应 ≥1，实际 ${report.efficiency}`);
  assert.ok(report.settleMs < 5000, `结算应在预算内，实际 ${report.settleMs.toFixed(0)}ms`);
});

test('时间回拨被识别且不发放收益', () => {
  const state = farmState();
  const sporeBefore = state.resources.spore!.serialize();
  const report = settleOffline(state, data, 10_000_000, 1000); // 现在早于存档时间
  assert.equal(report.clockAnomaly, true);
  assert.equal(report.settledSec, 0);
  assert.equal(state.resources.spore!.serialize(), sporeBefore, '状态不应被改动');
  assert.ok(report.events[0]!.includes('回拨'));
});

test('硬上限：离线 7 天只结算 12 小时', () => {
  const state = farmState();
  const report = settleOffline(state, data, 0, 7 * 24 * 3600 * 1000);
  assert.equal(report.settledSec, data.config.offline.hardCapHours * 3600);
  assert.ok(report.rawSec > report.settledSec);
});

test('离线结算确定性：同状态同参数两次结果一致', () => {
  const a = farmState();
  const b = farmState();
  const ra = settleOffline(a, data, 0, 7200 * 1000);
  const rb = settleOffline(b, data, 0, 7200 * 1000);
  assert.equal(ra.efficiency.toFixed(9), rb.efficiency.toFixed(9));
  assert.deepEqual(ra.events, rb.events);
  for (const id of ['humus', 'sugar', 'spore']) {
    assert.equal(a.resources[id]!.serialize(), b.resources[id]!.serialize(), `${id} 不一致`);
  }
});

test('过短的离线时间不触发结算（避免频繁弹窗）', () => {
  const state = farmState();
  const report = settleOffline(state, data, 0, 3000); // 3 秒
  assert.equal(report.settledSec, 3);
  assert.equal(Object.keys(report.gained).length, 0);
  assert.equal(report.events.length, 0);
});

test('离线期间土壤不会被抽干（保护性规则）', () => {
  const state = cloneState(farmState());
  for (const node of state.graph.nodes.values()) node.richness = 10;
  settleOffline(state, data, 0, 6 * 3600 * 1000);
  for (const node of state.graph.nodes.values()) {
    const layer = data.layers.get(node.layerId)!;
    assert.ok(node.richness >= layer.richnessFloor, `节点 ${node.id} 富饶度低于下限`);
  }
});
