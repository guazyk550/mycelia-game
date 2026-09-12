/**
 * 菌市（GDD §10）。
 *
 * 价格用均值回归过程：p ← p × (1 + θ(1 − p/μ) + σ·ε)，其中 μ 受玩家净产量影响 ——
 * 这是一条刻意的反直觉设计：**你在市场上卖得越多，价格越低**，
 * 所以"囤货 / 加工 / 等待"才会成为真实选择，而不是无脑刷。
 *
 * 手续费随时间递增（60 秒内重复交易同一资源），用于抑制单资源刷分。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { GameData } from '../types.ts';
import { challengeEffects } from '../challenges/challenge-engine.ts';
import { lawBonuses } from '../meta/laws.ts';

export interface MarketEntry {
  price: number;
  /** 基准价（用于显示涨跌幅） */
  basePrice: number;
  /** 最近一次成交时间（手续费递增用） */
  lastTradeAt: number;
  tradesInWindow: number;
}

export interface MarketState {
  entries: Record<string, MarketEntry>;
  /** 累计成交额（蜜露） */
  volume: SciNum;
  lastTick: number;
}

export function initMarket(data: GameData): MarketState {
  const entries: Record<string, MarketEntry> = {};
  for (const [id, res] of data.resources) {
    if (!res.def.tradeable || res.basePrice === null) continue;
    entries[id] = { price: res.basePrice.toNumber(), basePrice: res.basePrice.toNumber(), lastTradeAt: -1e9, tradesInWindow: 0 };
  }
  return { entries, volume: SciNum.ZERO, lastTick: 0 };
}

/** 保证旧存档也能拿到市场状态 */
export function ensureMarket(state: GameState, data: GameData): MarketState {
  if (!state.market || Object.keys(state.market.entries).length === 0) {
    state.market = initMarket(data);
  }
  return state.market;
}

/** 由玩家净产量推出的"市场深度"修正：产量越高，均衡价越低 */
function equilibrium(data: GameData, market: MarketEntry, res: string): number {
  const netRate = 0; // 由调用方传入更精确；这里用基准价作为默认均衡
  void res;
  void netRate;
  return market.basePrice;
}

export function tickMarket(state: GameState, data: GameData, dt: number, rng: () => number): void {
  const market = ensureMarket(state, data);
  const cfg = data.config.market;
  market.lastTick = state.elapsed;

  for (const [resId, entry] of Object.entries(market.entries)) {
    // 玩家产量会压低均衡价（每 1000/s 净产出压 5%，上限 ±50%）
    const rate = Math.max(0, state.ratePerSec[resId] ?? 0);
    const supplyFactor = Math.max(0.5, Math.min(1.5, 1 - 0.05 * Math.log10(1 + rate / 1000)));
    const mu = equilibrium(data, entry, resId) * supplyFactor;

    // 均值回归 + 噪声（每步按 dt 缩放，保证不同步长下行为一致）
    const theta = cfg.theta * dt;
    const sigma = cfg.sigma * Math.sqrt(dt);
    const shock = sigma * (rng() * 2 - 1);
    let next = entry.price * (1 + theta * (1 - entry.price / mu) + shock);

    next = Math.max(entry.basePrice * cfg.clampLow, Math.min(entry.basePrice * cfg.clampHigh, next));
    entry.price = next;

    // 手续费窗口滚动
    if (state.elapsed - entry.lastTradeAt > cfg.feeRampWindowSec) entry.tradesInWindow = 0;
  }
}

function feeFor(entry: MarketEntry, data: GameData, elapsed: number): number {
  const cfg = data.config.market;
  if (elapsed - entry.lastTradeAt > cfg.feeRampWindowSec) return cfg.feeBase;
  return cfg.feeBase + entry.tradesInWindow * cfg.feeRampPerFastTrade;
}

export interface TradeResult {
  ok: boolean;
  reason?: string;
  /** 实际获得的蜜露（卖出）或消耗的蜜露（买入） */
  honeydew: SciNum;
  fee: number;
}

/** 卖出：资源 → 蜜露 */
export function sell(state: GameState, data: GameData, resId: string, amount: SciNum): TradeResult {
  // 挑战 marketClosed：菌市整体关闭（含市价波动也停摆，否则只是禁用按钮没有意义）
  if (challengeEffects(state, data).marketClosed) {
    return { ok: false, reason: '当前挑战禁止交易（菌市关闭）', honeydew: SciNum.ZERO, fee: 0 };
  }
  const market = ensureMarket(state, data);
  const entry = market.entries[resId];
  if (!entry) return { ok: false, reason: '该资源不可交易', honeydew: SciNum.ZERO, fee: 0 };
  if (!SciNum.gt(amount, SciNum.ZERO)) return { ok: false, reason: '数量必须大于 0', honeydew: SciNum.ZERO, fee: 0 };
  const have = state.resources[resId] ?? SciNum.ZERO;
  if (SciNum.lt(have, amount)) return { ok: false, reason: '持有量不足', honeydew: SciNum.ZERO, fee: 0 };

  const fee = feeFor(entry, data, state.elapsed);
  const gross = amount.toNumber() * entry.price;
  const net = gross * (1 - fee);
  if (!Number.isFinite(net)) return { ok: false, reason: '数值溢出', honeydew: SciNum.ZERO, fee };

  state.resources[resId] = SciNum.sub(have, amount);
  const gained = SciNum.from(net);
  state.resources.honeydew = SciNum.add(state.resources.honeydew ?? SciNum.ZERO, gained);
  market.volume = SciNum.add(market.volume, gained);

  // 卖压：把价格压下去一点（玩家的行为真的会影响市场）。
  // 压价幅度与「市场深度」成反比 —— 法则「深流律」加深市场，等于同样的出货量砸得更轻。
  // 早期版本这里是写死的 0.02，配置里的 depthBase 从未被使用（数据与代码脱节）。
  const lawDepth = 1 + lawBonuses(state, data).marketDepthMul;
  const depth = Math.max(1, SciNum.from(data.config.market.depthBase).toNumber() * lawDepth);
  const impact = Math.min(0.25, (amount.toNumber() / depth) * 0.02);
  entry.price = Math.max(entry.basePrice * data.config.market.clampLow, entry.price * (1 - impact));
  entry.lastTradeAt = state.elapsed;
  entry.tradesInWindow++;

  return { ok: true, honeydew: gained, fee };
}

/** 买入：蜜露 → 资源 */
export function buy(state: GameState, data: GameData, resId: string, amount: SciNum): TradeResult {
  // 挑战 marketClosed：菌市整体关闭（含市价波动也停摆，否则只是禁用按钮没有意义）
  if (challengeEffects(state, data).marketClosed) {
    return { ok: false, reason: '当前挑战禁止交易（菌市关闭）', honeydew: SciNum.ZERO, fee: 0 };
  }
  const market = ensureMarket(state, data);
  const entry = market.entries[resId];
  if (!entry) return { ok: false, reason: '该资源不可交易', honeydew: SciNum.ZERO, fee: 0 };
  if (!SciNum.gt(amount, SciNum.ZERO)) return { ok: false, reason: '数量必须大于 0', honeydew: SciNum.ZERO, fee: 0 };

  const fee = feeFor(entry, data, state.elapsed);
  const cost = SciNum.from(amount.toNumber() * entry.price * (1 + fee));
  const have = state.resources.honeydew ?? SciNum.ZERO;
  if (SciNum.lt(have, cost)) return { ok: false, reason: '蜜露不足', honeydew: cost, fee };

  state.resources.honeydew = SciNum.sub(have, cost);
  state.resources[resId] = SciNum.add(state.resources[resId] ?? SciNum.ZERO, amount);
  market.volume = SciNum.add(market.volume, cost);

  entry.price = Math.min(entry.basePrice * data.config.market.clampHigh, entry.price * (1 + 0.02));
  entry.lastTradeAt = state.elapsed;
  entry.tradesInWindow++;

  return { ok: true, honeydew: cost, fee };
}

/** 涨跌幅（UI 显示用） */
export function priceDelta(entry: MarketEntry): number {
  return entry.price / entry.basePrice - 1;
}
