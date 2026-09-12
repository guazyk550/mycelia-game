/**
 * 反作弊与鲁棒性复核（PHASE 5）。
 *
 * 目标不是"抓作弊者"，而是保证**任何外部输入都无法把游戏带进不可能的状态**：
 * 时间回拨、时钟超前、超大 dt、篡改数值、注入 NaN、超长离线……
 * 每一条都必须被识别并夹紧，而不是变成 NaN/Infinity 污染整个存档。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData } from '../src/data/node-source.ts';
import { serializeState, deserializeState, fnv1a, type SaveFile } from '../src/core/save/save.ts';
import { settleOffline } from '../src/core/offline/settle.ts';
import { computeModifiers, tick } from '../src/core/economy/engine.ts';

const data = loadGameData();

/** 构造一个带正确校验和的存档文件（校验和本身由被测代码之外的工具生成） */
function makeFile(state: unknown): SaveFile {
  const s = state as SaveFile['state'];
  return {
    version: data.config.save.version,
    savedAt: Date.now(),
    gameTime: 0,
    checksum: fnv1a(JSON.stringify(s)),
    state: s,
  } as SaveFile;
}

test('反作弊：时间回拨被识别，且不发放任何离线收益', () => {
  const st = createNewGame(data);
  const now = Date.now();
  const report = settleOffline(st, data, now + 3600_000, now); // 存档来自"未来"
  assert.equal(report.clockAnomaly, true);
  assert.equal(report.settledSec, 0);
  assert.equal(Object.keys(report.gained).length, 0);
});

test('反作弊：回拨 5 分钟（超过容差）被识别', () => {
  const st = createNewGame(data);
  const now = Date.now();
  // 注意参数是 (state, data, savedAtMs, nowMs)：savedAt 在**未来**才是回拨
  const report = settleOffline(st, data, now + 300_000, now);
  assert.equal(report.clockAnomaly, true, '5 分钟回拨应被识别');
  assert.equal(report.settledSec, 0);
});

test('反作弊：容差内的微小回拨不误判（避免正常时钟同步被当成作弊）', () => {
  const st = createNewGame(data);
  const now = Date.now();
  const report = settleOffline(st, data, now + 30_000, now); // 回拨 30 秒 < 60 秒容差
  assert.equal(report.clockAnomaly, false, '容差内不应判定为异常');
  assert.equal(report.settledSec, 0, '但也不该发放收益（时间没前进）');
});

test('反作弊：超长离线被硬上限截断（离线 30 天 ≠ 30 天收益）', () => {
  const st = createNewGame(data);
  const now = Date.now();
  const report = settleOffline(st, data, now - 30 * 24 * 3600_000, now);
  const cap = Math.min(data.config.antiCheat.maxOfflineSec, data.config.offline.hardCapHours * 3600);
  assert.ok(report.settledSec <= cap, `结算秒数应被截断：${report.settledSec} > ${cap}`);
  assert.ok(report.rawSec > report.settledSec, '原始时长应保留（用于向玩家说明）');
});

test('反作弊：篡改存档被校验和抓住，且不加载', () => {
  const st = createNewGame(data);
  const file = makeFile(serializeState(st));
  // 偷改资源但不更新校验和
  (file.state.resources as Record<string, string>)['spore'] = '999999999999';
  const loaded = deserializeState(file, data);
  assert.equal(loaded.tampered, true, '应被标记为被篡改');
  assert.equal(loaded.state, null, '不应加载被篡改的存档');
});

test('反作弊：即使校验和通过，注入的 NaN/负值也会被夹紧（纵深防御）', () => {
  const st = createNewGame(data);
  const raw = serializeState(st) as unknown as { resources: Record<string, string> };
  raw.resources['humus'] = 'NaN';
  raw.resources['sugar'] = '-1e999';
  const loaded = deserializeState(makeFile(raw), data);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state!.resources['humus']!.toNumber(), 0, 'NaN 应被重置为 0');
  assert.equal(loaded.state!.resources['sugar']!.isNegative(), false, '负值应被夹紧');
  assert.ok(loaded.warnings.length >= 2, '应留下可诊断的警告');
});

test('反作弊：超大 dt 不会让资源瞬间爆炸（tick 拒绝非法 dt）', () => {
  const st = createNewGame(data);
  assert.throws(() => tick(st, data, Number.POSITIVE_INFINITY), /非法 dt/);
  assert.throws(() => tick(st, data, Number.NaN), /非法 dt/);
  assert.throws(() => tick(st, data, -1), /非法 dt/);
  assert.throws(() => tick(st, data, 0), /非法 dt/);
});

test('反作弊：不变量断言会拦住被污染的状态（而不是让它继续传播）', () => {
  const st = createNewGame(data);
  st.resources['humus'] = S.NAN;
  assert.throws(() => tick(st, data, 0.1), /invariant|非有限值/);
});

test('反作弊：节点坐标被篡改成非法值时被夹紧', () => {
  const st = createNewGame(data);
  // 注意：序列化后的节点是**顶层数组**（state.nodes），不是 state.graph.nodes
  const raw = serializeState(st) as unknown as { nodes: { x: number; y: number; richness: number }[] };
  for (const n of raw.nodes) {
    n.x = Number.NaN;
    n.richness = -999;
  }
  const loaded = deserializeState(makeFile(raw), data);
  assert.equal(loaded.ok, true);
  for (const n of loaded.state!.graph.nodes.values()) {
    assert.ok(Number.isFinite(n.x), '坐标应被修正为有限值');
    assert.ok(n.richness >= 0, '富饶度不应为负');
  }
});

test('反作弊：连续 tick 后所有资源保持有限（长跑不产生 NaN/Infinity）', () => {
  const st = createNewGame(data);
  st.resources['humus'] = S.from(1e6);
  st.resources['water'] = S.from(1e6);
  st.resources['sugar'] = S.from(1e6);
  for (let i = 0; i < 20000; i++) tick(st, data, 0.1);
  for (const [id, v] of Object.entries(st.resources)) {
    assert.ok(v.isFinite(), `资源 ${id} 出现非有限值`);
    assert.ok(!v.isNegative(), `资源 ${id} 为负`);
  }
  const m = computeModifiers(st, data);
  assert.ok(Number.isFinite(m.globalOutput) && Number.isFinite(m.globalOutputMul));
});
