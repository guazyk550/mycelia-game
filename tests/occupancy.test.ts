import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { buildNode, buildLink, computeModifiers, moveNode, demolishNode, demolishLink } from '../src/core/economy/engine.ts';
import {
  TILE_SIZE,
  snapToTile,
  tileKeyOf,
  occupiedTiles,
  isTileFree,
  tileKeyOf as _tk,
  findNearestFreeTile,
  resolvePlacement,
} from '../src/core/network/occupancy.ts';

const data = loadGameData(defaultDataDir());

function fresh() {
  const state = createNewGame(data);
  const mods = computeModifiers(state, data);
  state.resources.spore = S.from(1e6);
  state.resources.sugar = S.from(1e6);
  state.totalProduced.water = S.from(1000);
  state.totalProduced.humus = S.from(1000);
  state.totalProduced.sugar = S.from(1000);
  return { state, mods };
}

test('吸附：任意坐标落到最近格中心', () => {
  assert.deepEqual(snapToTile(0, 0), { x: 0, y: 0 });
  assert.deepEqual(snapToTile(10, 10), { x: 0, y: 0 });
  assert.deepEqual(snapToTile(30, 30), { x: TILE_SIZE, y: TILE_SIZE });
  assert.deepEqual(snapToTile(-30, 5), { x: -TILE_SIZE, y: 0 });
});

test('建造后节点坐标被吸附到网格', () => {
  const { state, mods } = fresh();
  const r = buildNode(state, data, 'decomposer_i', 'topsoil', 37, -52, mods);
  assert.ok(r.ok, r.reason);
  const node = state.graph.nodes.get(r.nodeId!)!;
  // 注意：JS 里 -46 % 46 === -0，用 Math.abs 避开负零陷阱（否则 Object.is 比较会失败）
  assert.equal(Math.abs(node.x % TILE_SIZE), 0, `x=${node.x} 未吸附`);
  assert.equal(Math.abs(node.y % TILE_SIZE), 0, `y=${node.y} 未吸附`);
  assert.equal(Number.isInteger(node.x / TILE_SIZE), true);
  assert.equal(Number.isInteger(node.y / TILE_SIZE), true);
});

test('同一格重复建造不会重叠：第二个节点被移到最近空格', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const b = buildNode(state, data, 'decomposer_i', 'topsoil', 5, 5, mods);
  assert.ok(a.ok && b.ok);
  const na = state.graph.nodes.get(a.nodeId!)!;
  const nb = state.graph.nodes.get(b.nodeId!)!;
  assert.notEqual(tileKeyOf(na.x, na.y), tileKeyOf(nb.x, nb.y), '两个节点不应落在同一格');
  // 且第二个应该离第一个足够近（螺旋搜索是"最近空格"）
  const dist = Math.hypot(nb.x - na.x, nb.y - na.y);
  assert.ok(dist <= TILE_SIZE * 1.5, `移位过远：${dist}`);
});

test('大批量建造：所有节点两两不重叠', () => {
  const { state, mods } = fresh();
  for (let i = 0; i < 40; i++) buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const tiles = [...state.graph.nodes.values()].map((n) => tileKeyOf(n.x, n.y));
  assert.equal(new Set(tiles).size, tiles.length, '存在重叠节点');
});

test('占用查询与最近空格搜索', () => {
  const { state, mods } = fresh();
  const occupied = occupiedTiles(state);
  assert.ok(occupied.size >= 1, '起始节点应占用一格');
  assert.equal(isTileFree(state, 0, 0, occupied), false, '起始格应被占用');
  const free = findNearestFreeTile(occupied, 0, 0);
  assert.ok(free, '应能找到空格');
  assert.equal(isTileFree(state, free!.x, free!.y, occupied), true);

  // 人为填满第一环，确认会向外扩
  const dense = new Set<string>(occupied);
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) dense.add(`${dc},${dr}`);
  const farther = findNearestFreeTile(dense, 0, 0);
  assert.ok(farther);
  const ring = Math.max(Math.abs(farther!.x / TILE_SIZE), Math.abs(farther!.y / TILE_SIZE));
  assert.equal(ring, 2, `应扩到第 2 环，实际 ${ring}`);
  void mods;
});

test('resolvePlacement：空闲时不移位，占用时移位', () => {
  const { state } = fresh();
  const free = resolvePlacement(state, TILE_SIZE * 5, TILE_SIZE * 5);
  assert.ok(free && free.shifted === false);
  const busy = resolvePlacement(state, 0, 0);
  assert.ok(busy && busy.shifted === true, '起始格已被占用，应发生移位');
});

test('极端拥挤时返回 null 而不是无限循环', () => {
  const dense = new Set<string>();
  for (let dc = -10; dc <= 10; dc++) for (let dr = -10; dr <= 10; dr++) dense.add(`${dc},${dr}`);
  const tile = findNearestFreeTile(dense, 0, 0, 3);
  assert.equal(tile, null, '半径 3 内全满时应返回 null');
});

// ---------------------------------------------------------------- 移动节点（反馈 #5）

test('moveNode：移动到空格并释放原格', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const node = state.graph.nodes.get(a.nodeId!)!;
  const from = { x: node.x, y: node.y };
  const r = moveNode(state, a.nodeId!, TILE_SIZE * 4, TILE_SIZE * 4);
  assert.ok(r.ok, r.reason);
  assert.equal(node.x, TILE_SIZE * 4);
  assert.equal(node.y, TILE_SIZE * 4);
  // 原格应被释放
  assert.equal(isTileFree(state, from.x, from.y), true, '原格应变为空');
});

test('moveNode：目标格被占用时自动移位', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const b = buildNode(state, data, 'decomposer_i', 'topsoil', TILE_SIZE * 3, 0, mods);
  const nb = state.graph.nodes.get(b.nodeId!)!;
  const beforeB = { x: nb.x, y: nb.y };
  const r = moveNode(state, a.nodeId!, beforeB.x, beforeB.y);
  assert.ok(r.ok);
  assert.equal(r.shifted, true, '目标被占用应报告发生了移位');
  const na = state.graph.nodes.get(a.nodeId!)!;
  assert.notEqual(tileKeyOf(na.x, na.y), tileKeyOf(beforeB.x, beforeB.y), '不应叠到已有节点上');
});

test('moveNode：可以原地微调（占位计算排除自己）', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', TILE_SIZE * 2, TILE_SIZE * 2, mods);
  const node = state.graph.nodes.get(a.nodeId!)!;
  const origin = { x: node.x, y: node.y };
  // 拖回自己所在的格子附近（差几像素）
  const r = moveNode(state, a.nodeId!, origin.x + 6, origin.y - 5);
  assert.ok(r.ok, r.reason);
  assert.equal(r.shifted, false, '回到自己格子不算移位');
  assert.equal(node.x, origin.x);
  assert.equal(node.y, origin.y);
});

test('moveNode：大量随机移动后仍无重叠', () => {
  const { state, mods } = fresh();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(buildNode(state, data, 'decomposer_i', 'topsoil', i * 7, 0, mods).nodeId!);
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let step = 0; step < 200; step++) {
    const id = ids[Math.floor(rnd() * ids.length)]!;
    moveNode(state, id, Math.round(rnd() * 600 - 300), Math.round(rnd() * 600 - 300));
  }
  const tiles = [...state.graph.nodes.values()].map((n) => tileKeyOf(n.x, n.y));
  assert.equal(new Set(tiles).size, tiles.length, '移动后出现重叠');
});

// ---------------------------------------------------------------- 拆除（反馈 #5）

test('demolishNode：返还一半基础成本且断开关联连线', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const b = buildNode(state, data, 'saccharifier_i', 'topsoil', TILE_SIZE * 2, 0, mods);
  buildLink(state, data, a.nodeId!, b.nodeId!);
  assert.equal(state.graph.links.size, 1);

  // 记录拆除前的孢子（孢子是 decomposer_i 的唯一成本）
  const sporeBefore = state.resources.spore!;
  const r = demolishNode(state, data, a.nodeId!);
  assert.ok(r.ok);
  assert.equal(state.graph.nodes.has(a.nodeId!), false);
  assert.equal(state.graph.links.size, 0, '关联连线应被断开');
  // 返还 = 基础成本 5 的 50% = 2.5
  assert.ok(r.refund.length > 0);
  const sporeRefund = r.refund.find((x) => x.res === 'spore');
  assert.ok(sporeRefund, '应返还孢子');
  assert.ok(Math.abs(sporeRefund!.amount.toNumber() - 2.5) < 1e-9, `返还不符：${sporeRefund!.amount.toString()}`);
  assert.ok(S.gt(state.resources.spore!, sporeBefore), '资源应增加');
});

test('拆除不会产生刷资源漏洞：建→拆循环净值下降', () => {
  const { state, mods } = fresh();
  // 先建若干，把成本推高
  for (let i = 0; i < 5; i++) buildNode(state, data, 'decomposer_i', 'topsoil', i * TILE_SIZE, 0, mods);
  const start = state.resources.spore!;
  let spent = S.ZERO;
  for (let round = 0; round < 6; round++) {
    const before = state.resources.spore!;
    const built = buildNode(state, data, 'decomposer_i', 'topsoil', TILE_SIZE * 8, 0, mods);
    assert.ok(built.ok, built.reason);
    const afterBuild = state.resources.spore!;
    spent = S.add(spent, S.sub(before, afterBuild));
    demolishNode(state, data, built.nodeId!);
  }
  const end = state.resources.spore!;
  assert.ok(S.lt(end, start), `建拆循环应净亏，实际 ${start.toString()} → ${end.toString()}`);
  assert.ok(S.gt(spent, S.ZERO));
});

test('demolishLink：断开指定连线', () => {
  const { state, mods } = fresh();
  const a = buildNode(state, data, 'decomposer_i', 'topsoil', 0, 0, mods);
  const b = buildNode(state, data, 'saccharifier_i', 'topsoil', TILE_SIZE * 2, 0, mods);
  const link = buildLink(state, data, a.nodeId!, b.nodeId!);
  assert.equal(demolishLink(state, link.nodeId!), true);
  assert.equal(state.graph.links.size, 0);
  assert.equal(demolishLink(state, 'nope'), false);
});

// ---------------------------------------------------------------- 层选择（收益杠杆）

test('层倍率：同一节点建在不同层的产出差异真实存在（这是"放哪层"决策的依据）', async () => {
  const { buildNode, computeModifiers, tick } = await import('../src/core/economy/engine.ts');
  const { SciNum: S4 } = await import('../src/core/math/scinum.ts');
  const { createNewGame } = await import('../src/core/state.ts');
  const d = loadGameData();

  const measure = (layerId: string): number => {
    const st = createNewGame(d);
    st.unlockedLayers = [...new Set([...st.unlockedLayers, layerId])];
    st.resources['spore'] = S4.from(1e6);
    const r = buildNode(st, d, 'decomposer_i', layerId, 500, 500, computeModifiers(st, d));
    assert.equal(r.ok, true, `${layerId} 建造失败：${r.reason}`);
    for (let i = 0; i < 600; i++) tick(st, d, 0.1);
    return st.totalProduced['humus']!.toNumber();
  };

  const top = measure('topsoil');
  const mantle = measure('mantle');
  assert.ok(top > 0 && mantle > 0);
  const ratio = mantle / top;
  assert.ok(ratio > 50, `地幔层的产出应远高于表土层：实测 ×${ratio.toFixed(1)}（layer.depthMul 声明为 ×400）`);
});

test('层容量：每层有节点上限，满了就不能再建（这是层选择成为决策的前提）', () => {
  const d = loadGameData();
  for (const layer of d.layerOrder) {
    assert.ok(layer.nodeCap > 0, `${layer.name} 缺少节点上限`);
    assert.ok(layer.nodeCap <= 200, `${layer.name} 的节点上限 ${layer.nodeCap} 过大，层选择会失去意义`);
  }
});
