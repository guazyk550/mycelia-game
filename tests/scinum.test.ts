import test from 'node:test';
import assert from 'node:assert/strict';
import { SciNum, S } from '../src/core/math/scinum.ts';

const eq = (a: SciNum, m: number, e: number, msg?: string): void => {
  assert.equal(a.m, m, `${msg ?? ''} mantissa`);
  assert.equal(a.e, e, `${msg ?? ''} exponent`);
};

test('构造与归一化', () => {
  eq(S.from(0), 0, 0, 'zero');
  eq(S.from(1), 1, 0, 'one');
  eq(S.from(1234), 1.234, 3, '1234');
  eq(S.from('1e30'), 1, 30, 'string 1e30');
  eq(S.from('1.5e-7'), 1.5, -7, 'string negative exp');
  eq(S.from('123'), 1.23, 2, 'plain string');
  eq(S.from(S.ZERO), 0, 0, 'idempotent');
  // 浮点边界：log10 误差不能让尾数跑出 [1,10)
  for (const n of [9.999999, 1.0000001, 1e-5, 1e5, 3.14159e8]) {
    const x = S.from(n);
    assert.ok(x.m >= 1 && x.m < 10, `${n} -> m=${x.m} out of range`);
  }
});

test('加减法（含跨数量级吞并）', () => {
  eq(S.add(S.from(1), S.from(2)), 3, 0, '1+2');
  eq(S.add(S.from('1e30'), S.from('1e30')), 2, 30, '1e30+1e30');
  eq(S.sub(S.from(5), S.from(5)), 0, 0, '5-5');
  eq(S.sub(S.from(3), S.from(10)), -7, 0, 'negative result');
  // 超出 17 个数量级的小项被吞掉，但不会产生误差累积
  eq(S.add(S.from('1e30'), S.from('1e5')), 1, 30, 'tiny swallowed');
  // 同一数量级必须精确
  const near = S.sub(S.add(S.from('1.5000001e10'), S.from('2.5e9')), S.from('2.5e9'));
  assert.ok(Math.abs(near.m - 1.5000001) < 1e-6, `precision lost: ${near.toString()}`);
});

test('乘除与幂', () => {
  eq(S.mul(S.from('1e300'), S.from('1e300')), 1, 600, '1e300*1e300');
  eq(S.mul(S.from(3), S.from(4)), 1.2, 1, '3*4');
  eq(S.div(S.from('9e100'), S.from('3e50')), 3, 50, '9e100/3e50');
  eq(S.div(S.from(1), S.from(8)), 1.25, -1, '1/8');
  // 成本曲线：cost(n) = base × 1.2^n（数值校验用相对误差，避免写死不精确的期望值）
  const base = S.from(10);
  const growth = 1.2;
  const cost100 = S.mul(base, S.pow(S.from(growth), 100));
  const expect100 = 10 * Math.pow(1.2, 100);
  assert.ok(
    Math.abs(cost100.toNumber() - expect100) / expect100 < 1e-9,
    `cost curve mismatch: ${cost100.toString()} vs ${expect100}`,
  );
  // x^0.55（Prestige 曲线）
  const p = S.pow(S.from('1e6'), 0.55);
  assert.ok(Math.abs(p.toNumber() - Math.pow(1e6, 0.55)) < 1e-6, `prestige curve: ${p.toString()}`);
});

test('对数与 10 的幂往返', () => {
  for (const s of ['1', '42', '1e30', '7.77e123', '1e-40']) {
    const x = S.from(s);
    const back = S.fromPow10(S.log10(x));
    assert.ok(Math.abs(S.log10(back) - S.log10(x)) < 1e-9, `roundtrip failed for ${s}`);
  }
  assert.equal(S.log10(S.from('1e1000')), 1000);
  assert.ok(Math.abs(S.ln(S.from(Math.E)) - 1) < 1e-12, 'ln(e) = 1');
});

test('比较运算', () => {
  assert.equal(S.cmp(S.from(1), S.from(2)), -1);
  assert.equal(S.cmp(S.from('1e30'), S.from('9e29')), 1);
  assert.equal(S.cmp(S.from(5), S.from(5)), 0);
  assert.equal(S.cmp(S.from(-1), S.from(1)), -1);
  assert.equal(S.cmp(S.from('-1e30'), S.from('-1e29')), -1, 'negative ordering flips');
  assert.ok(S.lt(S.from(1), S.from(2)));
  assert.ok(S.gte(S.from(2), S.from(2)));
  assert.ok(S.eq(S.from('1e30'), S.from('10e29')), '10e29 normalizes to 1e30');
  assert.ok(S.clamp(S.from(5), S.from(1), S.from(3)).toString() === '3', 'clamp hi');
});

test('floor 与整数边界', () => {
  eq(S.floor(S.from(3.7)), 3, 0, 'floor(3.7)');
  eq(S.floor(S.from('1.2345e20')), 1.2345, 20, 'big already integer');
  eq(S.floor(S.from(0.5)), 0, 0, 'floor(0.5)');
  eq(S.floor(S.from(-0.5)), -1, 0, 'floor(-0.5)');
});

test('NaN 与饱和哨兵（不允许静默产生 Infinity）', () => {
  assert.ok(S.from(Number.NaN).isNaN());
  assert.ok(S.from(Number.POSITIVE_INFINITY).isNaN());
  assert.ok(S.div(S.from(1), S.from(0)).isNaN(), 'div by zero -> NaN');
  const sat = S.mul(S.from('1e900000000000000000'), S.from('1e900000000000000000'));
  assert.ok(sat.isFinite(), 'saturation stays finite');
  assert.ok(sat.isSaturated(), 'flagged as saturated');
  assert.throws(() => S.cmp(S.from(1), S.NAN), /NaN/, 'comparing NaN throws');
});

test('序列化往返（存档保真）', () => {
  for (const s of ['0', '1', '1234.5', '1e30', '9.9999e-13', '3.3333e999']) {
    const x = S.from(s);
    const y = S.fromJSON(x.toJSON());
    assert.equal(x.serialize(), y.serialize(), `JSON roundtrip failed for ${s}`);
    const z = S.from(x.serialize());
    assert.equal(x.serialize(), z.serialize(), `string roundtrip failed for ${s}`);
  }
  assert.equal(S.from('0').serialize(), '0|0');
  assert.equal(S.from('1e30').serialize(), '1|30');
});

test('UI 短格式', () => {
  assert.equal(S.format(S.from(0)), '0');
  assert.equal(S.format(S.from(999)), '999');
  assert.equal(S.format(S.from(1500)), '1.50K');
  assert.equal(S.format(S.from('2.5e6')), '2.50M');
  assert.equal(S.format(S.from('1e12')), '1.00T');
  assert.equal(S.format(S.from('1.23e30')), '1.23No');
  assert.ok(S.format(S.from('1e100')).includes('e100'), 'falls back to sci notation');
  assert.equal(S.format(S.from('-4200')), '-4.20K');
});

test('性能：10 万次混合运算在预算内', () => {
  const t0 = performance.now();
  let acc = S.from(1);
  for (let i = 0; i < 100000; i++) {
    acc = S.add(acc, S.mul(S.from(1.0001), S.from(i % 7)));
    if (i % 1000 === 0) acc = S.max(acc, S.from('1e10'));
  }
  const ms = performance.now() - t0;
  assert.ok(acc.isFinite(), 'accumulator stayed finite');
  assert.ok(ms < 2000, `100k ops took ${ms.toFixed(1)}ms (budget 2000ms)`);
});
