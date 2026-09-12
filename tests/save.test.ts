import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import {
  CURRENT_SAVE_VERSION,
  deserializeState,
  fnv1a,
  loadFromJson,
  makeSaveFile,
  saveToJson,
  serializeState,
} from '../src/core/save/save.ts';
import { buildNode, tick, computeModifiers } from '../src/core/economy/engine.ts';

const data = loadGameData(defaultDataDir());

function play(seconds: number) {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  buildNode(state, data, 'hydra_i', 'topsoil', 10, 0, mods);
  buildNode(state, data, 'saccharifier_i', 'topsoil', 20, 0, mods);
  for (let i = 0; i < seconds * 10; i++) tick(state, data, 0.1, { mods });
  return state;
}

test('存档往返：序列化→反序列化后关键状态一致', () => {
  const state = play(60);
  const json = saveToJson(state, 1000);
  const result = loadFromJson(json, data);
  assert.ok(result.ok, result.warnings.join(';'));
  const s2 = result.state!;
  assert.equal(s2.tick, state.tick);
  assert.ok(Math.abs(s2.elapsed - state.elapsed) < 1e-9);
  assert.equal(s2.graph.size(), state.graph.size());
  assert.equal(s2.graph.links.size, state.graph.links.size);
  for (const [id, v] of Object.entries(state.resources)) {
    assert.equal(s2.resources[id]!.serialize(), v.serialize(), `资源 ${id} 不一致`);
  }
});

test('校验和：篡改内容会被标记为 tampered 而不是静默加载', () => {
  const state = play(30);
  const file = makeSaveFile(state, 1000);
  file.state.resources.spore = '999999';
  const result = deserializeState(file, data);
  assert.equal(result.ok, false);
  assert.equal(result.tampered, true);
  assert.equal(result.state, null);
});

test('坏数值被夹紧：NaN / 负数 / 未知资源不会污染状态', () => {
  const state = play(20);
  const file = makeSaveFile(state, 1000);
  file.state.resources.spore = 'NaN|0';
  file.state.resources.humus = '-5|3';
  file.state.resources['nonexistent_res'] = '1|10';
  file.checksum = fnv1a(JSON.stringify(file.state)); // 让校验和通过，只测夹紧逻辑
  const result = deserializeState(file, data);
  assert.ok(result.ok);
  const s2 = result.state!;
  assert.equal(s2.resources.spore!.toString(), '0');
  assert.equal(s2.resources.humus!.toString(), '0');
  assert.equal(s2.resources['nonexistent_res'], undefined);
  assert.ok(result.warnings.length >= 2, `应有夹紧警告，实际 ${result.warnings.length}`);
});

test('未知引用被跳过：不存在的节点类型与悬空连线', () => {
  const state = play(20);
  const file = makeSaveFile(state, 1000);
  file.state.nodes.push({
    id: 'ghost',
    typeId: 'node_that_does_not_exist',
    layerId: 'topsoil',
    x: 0,
    y: 0,
    active: true,
    built: true,
    richness: 60,
    rotationSwaps: 0,
  });
  file.state.links.push({ id: 'ghostlink', from: 'ghost', to: 'n0', fluxCap: '0' });
  file.checksum = fnv1a(JSON.stringify(file.state));
  const result = deserializeState(file, data);
  assert.ok(result.ok);
  assert.equal(result.state!.graph.nodes.has('ghost'), false);
  assert.equal(result.state!.graph.links.has('ghostlink'), false);
  assert.ok(result.warnings.some((w) => w.includes('不存在')));
});

test('版本高于支持范围时拒绝加载', () => {
  const state = createNewGame(data);
  const file = makeSaveFile(state, 0);
  file.version = CURRENT_SAVE_VERSION + 5;
  const result = deserializeState(file, data);
  assert.equal(result.ok, false);
  assert.equal(result.tampered, false);
  assert.ok(result.warnings[0]!.includes('高于'));
});

test('损坏的 JSON 文本返回失败而不是抛错', () => {
  const result = loadFromJson('{"version":1,"state":', data);
  assert.equal(result.ok, false);
  assert.ok(result.warnings[0]!.includes('解析失败'));
});

test('存档体积可控（100 节点网络 < 200KB）', () => {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  for (let i = 0; i < 60; i++) buildNode(state, data, 'decomposer_i', 'topsoil', i * 10, 0, mods);
  const json = saveToJson(state, Date.now());
  assert.ok(json.length < 200_000, `存档过大: ${json.length} 字节`);
});
