/**
 * SciNum — 科学计数法大数
 *
 * 表示：value = m × 10^e，其中 m = 0 或 1 ≤ |m| < 10，e 为 double（可表示到 10^1e15）。
 * 用途：全部游戏数值（资源账本、成本、倍率、Prestige 收益）都走这里，禁止裸 number 跨数量级累加。
 *
 * 设计约束（见 docs/balance-model.md §0、§12）：
 *   · 不可变；所有运算返回新实例
 *   · 任何非有限输入 → 立即产出 NaN 哨兵（不会静默变成 Infinity）
 *   · 指数超过 SATURATION_EXP 时进入饱和态并由 isSaturated() 上报，而不是溢出成 Infinity
 *   · 相对误差目标 < 1e-12（double mantissa 约 15-16 位十进制有效数字）
 */

/** 饱和阈值：10^1e15 已远超游戏设计上限（10^10000） */
const SATURATION_EXP = 1e15;

/** 归一化时保持的尾数上限（避免 log10 浮点误差导致 m 落在 [1,10) 之外） */
const LOG10_EPS = 1e-12;

export class SciNum {
  /** 尾数：0 或 1 ≤ |m| < 10 */
  readonly m: number;
  /** 指数：value = m × 10^e */
  readonly e: number;

  private constructor(m: number, e: number) {
    this.m = m;
    this.e = e;
  }

  // ---------------------------------------------------------------- 构造

  /** 从 number / 字符串 / 已有实例构造。字符串支持 "123"、"1.5e30"、"1e-9"，也接受 "m|e" 紧凑格式。 */
  static from(v: number | string | SciNum): SciNum {
    if (v instanceof SciNum) return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return SciNum.NAN;
      return SciNum.norm(v, 0);
    }
    const s = v.trim();
    if (s === '') return SciNum.NAN;
    const pipe = s.indexOf('|');
    if (pipe > 0) {
      const m = Number(s.slice(0, pipe));
      const e = Number(s.slice(pipe + 1));
      return SciNum.norm(m, e);
    }
    const expMatch = /^([+-]?[0-9]*\.?[0-9]+)[eE]([+-]?[0-9]+)$/.exec(s);
    if (expMatch) {
      const m = Number(expMatch[1]);
      const e = Number(expMatch[2]);
      if (!Number.isFinite(m) || !Number.isFinite(e)) return SciNum.NAN;
      return SciNum.norm(m, e);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return SciNum.NAN;
    return SciNum.norm(n, 0);
  }

  /** 归一化：把 (m, e) 整理成标准形式。所有内部运算的唯一出口。 */
  static norm(m: number, e: number): SciNum {
    if (!Number.isFinite(m) || !Number.isFinite(e)) return SciNum.NAN;
    if (m === 0) return SciNum.ZERO;
    if (e > SATURATION_EXP) return new SciNum(m > 0 ? 9.999999999 : -9.999999999, SATURATION_EXP);
    if (e < -SATURATION_EXP) return SciNum.ZERO;

    const sign = m < 0 ? -1 : 1;
    let am = Math.abs(m);
    let ae = e;

    let d = Math.floor(Math.log10(am));
    if (Number.isFinite(d) && d !== 0) {
      am = am / Math.pow(10, d);
      ae += d;
    }
    // log10 的浮点误差可能让 am 落在 [1,10) 之外，收尾一次
    if (am >= 10 - LOG10_EPS) {
      am /= 10;
      ae += 1;
    } else if (am < 1 - LOG10_EPS) {
      am *= 10;
      ae -= 1;
    }
    // 尾数吸附：吸收 0.7/0.1 = 6.999999999999999 这类浮点噪声，
    // 让「整数运算得整数」成立（否则 floor 后的阈值比较、成就判定会出现 1e-16 级偏差）
    am = snapMantissa(am);
    if (am >= 10) {
      am /= 10;
      ae += 1;
    }
    if (!Number.isFinite(am) || !Number.isFinite(ae)) return SciNum.NAN;
    return new SciNum(sign * am, ae);
  }

  /** 零 */
  static readonly ZERO: SciNum = new SciNum(0, 0);
  /** 一 */
  static readonly ONE: SciNum = new SciNum(1, 0);
  /** NaN 哨兵（m 与 e 均为 NaN） */
  static readonly NAN: SciNum = new SciNum(Number.NaN, Number.NaN);

  /** 尾数吸附：把 6.999999999999999 之类的值拉回 7（见 snapMantissa 注释） */
  static snap(am: number): number {
    return snapMantissa(am);
  }

  // ---------------------------------------------------------------- 算术

  static add(a: SciNum, b: SciNum | number): SciNum {
    const bb = toSci(b);
    if (a.isZero()) return bb;
    if (bb.isZero()) return a;
    if (!a.isFinite() || !bb.isFinite()) return SciNum.NAN;
    const hi = a.e >= bb.e ? a : bb;
    const lo = a.e >= bb.e ? bb : a;
    const d = hi.e - lo.e;
    if (d > 17) return hi; // 小项完全被吞掉（double 精度边界）
    const m = hi.m + lo.m * Math.pow(10, -d);
    if (m === 0) return SciNum.ZERO;
    return SciNum.norm(m, hi.e);
  }

  static sub(a: SciNum, b: SciNum | number): SciNum {
    const bb = toSci(b);
    if (bb.isZero()) return a;
    if (a.isZero()) return SciNum.neg(bb);
    return SciNum.add(a, SciNum.neg(bb));
  }

  static mul(a: SciNum, b: SciNum | number): SciNum {
    const bb = toSci(b);
    if (a.isZero() || bb.isZero()) return SciNum.ZERO;
    if (!a.isFinite() || !bb.isFinite()) return SciNum.NAN;
    return SciNum.norm(a.m * bb.m, a.e + bb.e);
  }

  static div(a: SciNum, b: SciNum | number): SciNum {
    const bb = toSci(b);
    if (bb.isZero()) return SciNum.NAN; // 除零显式失败，便于发现 bug
    if (a.isZero()) return SciNum.ZERO;
    if (!a.isFinite() || !bb.isFinite()) return SciNum.NAN;
    return SciNum.norm(a.m / bb.m, a.e - bb.e);
  }

  /** a^p（p 为普通 number；成本曲线与 Prestige 曲线都用它） */
  static pow(a: SciNum, p: number): SciNum {
    if (!Number.isFinite(p)) return SciNum.NAN;
    if (p === 0) return SciNum.ONE;
    if (a.isZero()) return p > 0 ? SciNum.ZERO : SciNum.NAN;
    if (!a.isFinite()) return SciNum.NAN;
    if (a.m < 0 && !Number.isInteger(p)) return SciNum.NAN; // 负数非整数次幂
    const lg = SciNum.log10(a);
    if (!Number.isFinite(lg)) return SciNum.NAN;
    return SciNum.fromPow10(lg * p);
  }

  /** a^b（b 也可以是超大数） */
  static powSci(a: SciNum, b: SciNum): SciNum {
    if (b.isZero()) return SciNum.ONE;
    if (a.isZero()) return SciNum.ZERO;
    const lg = SciNum.mul(SciNum.from(SciNum.log10(a)), b);
    return SciNum.fromPow10(lg.toNumber());
  }

  /** 10^x → SciNum */
  static fromPow10(x: number): SciNum {
    if (!Number.isFinite(x)) return SciNum.NAN;
    if (x > SATURATION_EXP) return new SciNum(9.999999999, SATURATION_EXP);
    if (x < -SATURATION_EXP) return SciNum.ZERO;
    const e = Math.floor(x);
    const m = Math.pow(10, x - e);
    return SciNum.norm(m, e);
  }

  static log10(a: SciNum): number {
    if (!a.isFinite() || a.m <= 0) return Number.NaN;
    return a.e + Math.log10(a.m);
  }

  /** 自然对数（SciNum 参数重载：支持 log(a, b) 换底） */
  static ln(a: SciNum): number {
    const lg = SciNum.log10(a);
    return Number.isNaN(lg) ? Number.NaN : lg * Math.LN10;
  }

  static neg(a: SciNum): SciNum {
    if (a.isZero()) return SciNum.ZERO;
    if (!a.isFinite()) return SciNum.NAN;
    return SciNum.norm(-a.m, a.e);
  }

  static abs(a: SciNum): SciNum {
    if (a.m >= 0) return a;
    return SciNum.neg(a);
  }

  static floor(a: SciNum): SciNum {
    if (!a.isFinite()) return SciNum.NAN;
    if (a.e >= 16) return a; // 10^16 一定大于 2^53，本身即整数
    if (a.e < 0) return a.m > 0 ? SciNum.ZERO : SciNum.from(-1);
    const n = Math.floor(a.toNumber());
    return SciNum.from(n);
  }

  static max(a: SciNum, b: SciNum): SciNum {
    return SciNum.cmp(a, b) >= 0 ? a : b;
  }

  static min(a: SciNum, b: SciNum): SciNum {
    return SciNum.cmp(a, b) <= 0 ? a : b;
  }

  static clamp(a: SciNum, lo: SciNum, hi: SciNum): SciNum {
    return SciNum.max(lo, SciNum.min(hi, a));
  }

  /** 返回 -1 / 0 / 1；NaN 参与比较时抛错（便于暴露 bug，而不是静默给出错误顺序） */
  static cmp(a: SciNum, b: SciNum): -1 | 0 | 1 {
    if (!a.isFinite() || !b.isFinite()) {
      throw new Error('SciNum.cmp: 比较涉及 NaN/饱和值');
    }
    const sa = Math.sign(a.m);
    const sb = Math.sign(b.m);
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (sa === 0) return 0;
    if (a.e !== b.e) {
      const r = a.e < b.e ? -1 : 1;
      return (sa < 0 ? -r : r) as -1 | 1;
    }
    if (a.m === b.m) return 0;
    return a.m < b.m ? -1 : 1;
  }

  static lt(a: SciNum, b: SciNum): boolean {
    return SciNum.cmp(a, b) < 0;
  }
  static lte(a: SciNum, b: SciNum): boolean {
    return SciNum.cmp(a, b) <= 0;
  }
  static gt(a: SciNum, b: SciNum): boolean {
    return SciNum.cmp(a, b) > 0;
  }
  static gte(a: SciNum, b: SciNum): boolean {
    return SciNum.cmp(a, b) >= 0;
  }
  static eq(a: SciNum, b: SciNum): boolean {
    return SciNum.cmp(a, b) === 0;
  }

  // ---------------------------------------------------------------- 状态

  isZero(): boolean {
    return this.m === 0;
  }
  isFinite(): boolean {
    return Number.isFinite(this.m) && Number.isFinite(this.e);
  }
  isNaN(): boolean {
    return Number.isNaN(this.m) || Number.isNaN(this.e);
  }
  isNegative(): boolean {
    return this.m < 0;
  }
  isPositive(): boolean {
    return this.m > 0;
  }
  /** 饱和态（超过设计上限，值仍有限但不精确） */
  isSaturated(): boolean {
    return this.isFinite() && this.e >= SATURATION_EXP;
  }

  // ---------------------------------------------------------------- 转换

  toNumber(): number {
    if (!this.isFinite()) return Number.NaN;
    if (this.isZero()) return 0;
    if (this.e > 308) return this.m > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (this.e < -323) return 0;
    return this.m * Math.pow(10, this.e);
  }

  /** 紧凑精确格式：小数值用十进制，大数值用 "1.2345e30" */
  toString(): string {
    if (this.isNaN()) return 'NaN';
    if (this.isZero()) return '0';
    if (this.e >= 0 && this.e < 6) {
      const n = this.toNumber();
      return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
    }
    if (this.e < 0 && this.e > -4) {
      const n = this.toNumber();
      return String(Number(n.toPrecision(6)));
    }
    return `${this.m.toFixed(4)}e${this.e}`;
  }

  /** 存档格式（无损） */
  toJSON(): { m: number; e: number } {
    return { m: this.m, e: this.e };
  }
  static fromJSON(v: { m: number; e: number }): SciNum {
    return SciNum.norm(v.m, v.e);
  }

  /** 紧凑存档字符串 */
  serialize(): string {
    return `${this.m}|${this.e}`;
  }

  /**
   * UI 短格式。suffixes 覆盖到 10^33，更大的数回落科学计数法。
   * 例：1.23K、4.56M、7.89e42
   */
  static format(a: SciNum): string {
    if (!a.isFinite()) return 'NaN';
    if (a.isZero()) return '0';
    const neg = a.m < 0;
    const s = SciNum.formatAbs(SciNum.abs(a));
    return neg ? `-${s}` : s;
  }

  private static formatAbs(a: SciNum): string {
    if (a.e < 3) {
      const n = a.toNumber();
      return n >= 100 ? String(Math.round(n)) : n >= 10 ? String(Number(n.toFixed(1))) : String(Number(n.toFixed(2)));
    }
    const idx = Math.floor((a.e + 1) / 3) - 1; // K=1, M=2, ...
    if (idx >= 0 && idx < SUFFIXES.length) {
      const scaled = a.m * Math.pow(10, a.e - (idx + 1) * 3);
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)}${SUFFIXES[idx]}`;
    }
    const e = a.e;
    return `${a.m.toFixed(2)}e${e}`;
  }
}

const SUFFIXES = [
  'K', 'M', 'B', 'T', // 10^3 .. 10^12
  'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', // 10^15 .. 10^30
  'Dc', 'Ud', 'Dd', 'Td', 'Qad', 'Qid', 'Sxd', 'Spd', 'Ocd', 'Nod', 'Vg', // 10^33 .. 10^63
];

/**
 * 尾数吸附：若 am 与最近整数的相对差 < 1e-14，则取该整数。
 * 目的：让 0.7 / 0.1 这类浮点除法噪声（6.999999999999999）不会污染后续的整数比较与阈值判定。
 * 代价：小于 1e-14 相对误差的真实非整数会被舍入——对增量游戏无影响。
 */
function snapMantissa(am: number): number {
  const r = Math.round(am);
  if (r !== 0 && Math.abs((am - r) / r) < 1e-14) return r;
  return am;
}

/** 允许 SciNum 运算接受裸 number（倍率、dt 等），内部即时包装 */
function toSci(v: SciNum | number): SciNum {
  return typeof v === 'number' ? SciNum.from(v) : v;
}

/** 便捷别名（模拟器与 UI 层高频使用） */
export const S = SciNum;
export const ZERO = SciNum.ZERO;
export const ONE = SciNum.ONE;
