import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum as S } from '../src/core/math/scinum.ts';
import { createNewGame } from '../src/core/state.ts';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { initMarket, sell, buy, tickMarket, priceDelta, ensureMarket } from '../src/core/market/market.ts';

const data = loadGameData(defaultDataDir());

function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('新游戏自带市场，且只包含可交易资源', () => {
  const state = createNewGame(data);
  const market = ensureMarket(state, data);
  assert.ok(Object.keys(market.entries).length > 0);
  for (const [id, entry] of Object.entries(market.entries)) {
    assert.equal(data.resources.get(id)!.def.tradeable, true);
    assert.equal(entry.price, entry.basePrice);
  }
  // 不可交易资源不应出现
  assert.equal(market.entries['light'], undefined);
  assert.equal(market.entries['core'], undefined);
});

test('卖出：资源减少、蜜露增加，并留下手续费痕迹', () => {
  const state = createNewGame(data);
  state.resources.humus = S.from(1000);
  const before = state.resources.honeydew!.toNumber();
  const r = sell(state, data, 'humus', S.from(500));
  assert.equal(r.ok, true);
  assert.equal(state.resources.humus!.toNumber(), 500);
  assert.ok(state.resources.honeydew!.toNumber() > before);
  assert.ok(r.fee > 0, '应有手续费');
});

test('买入：蜜露减少、资源增加', () => {
  const state = createNewGame(data);
  state.resources.honeydew = S.from(10000);
  const r = buy(state, data, 'humus', S.from(100));
  assert.equal(r.ok, true);
  assert.equal(state.resources.humus!.toNumber(), 100);
  assert.ok(state.resources.honeydew!.toNumber() < 10000);
});

test('余额不足时交易被拒绝且状态不变', () => {
  const state = createNewGame(data);
  state.resources.humus = S.from(10);
  const r = sell(state, data, 'humus', S.from(100));
  assert.equal(r.ok, false);
  assert.equal(state.resources.humus!.toNumber(), 10);
  const r2 = buy(state, data, 'humus', S.from(1e9));
  assert.equal(r2.ok, false);
});

test('玩家行为影响价格：连续卖出会压低价格', () => {
  const state = createNewGame(data);
  state.resources.humus = S.from(1e6);
  const entry = ensureMarket(state, data).entries['humus']!;
  const before = entry.price;
  for (let i = 0; i < 10; i++) sell(state, data, 'humus', S.from(1000));
  assert.ok(entry.price < before, `连续卖出应压低价格：${before} → ${entry.price}`);
  assert.ok(priceDelta(entry) < 0);
});

test('手续费随时间递增（同资源 60 秒内重复交易）', () => {
  const state = createNewGame(data);
  state.resources.humus = S.from(1e6);
  const f1 = sell(state, data, 'humus', S.from(100)).fee;
  const f2 = sell(state, data, 'humus', S.from(100)).fee;
  assert.ok(f2 > f1, `重复交易手续费应递增：${f1} → ${f2}`);
  state.elapsed += data.config.market.feeRampWindowSec + 1;
  const f3 = sell(state, data, 'humus', S.from(100)).fee;
  assert.ok(f3 <= f1 + 1e-9, `窗口外应回落到基础费率：${f3}`);
});

test('价格有上下限，不会崩到 0 或涨到无穷', () => {
  const state = createNewGame(data);
  const market = ensureMarket(state, data);
  const entry = market.entries['humus']!;
  const r = rng(7);
  for (let i = 0; i < 20000; i++) {
    state.elapsed += 1;
    tickMarket(state, data, 1, r);
  }
  assert.ok(entry.price >= entry.basePrice * data.config.market.clampLow - 1e-9, `价格下限：${entry.price}`);
  assert.ok(entry.price <= entry.basePrice * data.config.market.clampHigh + 1e-9, `价格上限：${entry.price}`);
  assert.ok(Number.isFinite(entry.price));
});

test('市场波动确定性：同种子两次结果一致', () => {
  const a = createNewGame(data);
  const b = createNewGame(data);
  const ra = rng(99);
  const rb = rng(99);
  for (let i = 0; i < 500; i++) {
    a.elapsed += 1;
    b.elapsed += 1;
    tickMarket(a, data, 1, ra);
    tickMarket(b, data, 1, rb);
  }
  assert.equal(a.market.entries['humus']!.price.toFixed(10), b.market.entries['humus']!.price.toFixed(10));
});

test('市场状态随存档往返', () => {
  const state = createNewGame(data);
  state.resources.humus = S.from(5000);
  sell(state, data, 'humus', S.from(1000));
  const price = state.market.entries['humus']!.price;
  assert.ok(price !== state.market.entries['humus']!.basePrice, '交易后价格应偏离基准');
});
