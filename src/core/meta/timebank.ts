/**
 * 惊喜机制之一：时间银行。
 *
 * 机制：网络每秒把一小部分"时间"存进银行（默认 5%），银行最多存 8 小时。
 * 随时可以取出 —— 取出时按**当前速率**一次性结算存下来的那些秒数，但有 25% 损耗。
 *
 * 为什么它是个有趣的机制（而不是又一个资源）：
 *   · 它奖励"先建好网络再取钱"的判断力：取出时的速率越高，同样的储存秒数越值钱；
 *   · 损耗让它不是纯白送，玩家需要在"现在用"与"再攒一会儿"之间做决策；
 *   · 它与离线收益互补：离线是"我不在时也长"，时间银行是"我在时也存着"。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameData } from '../types.ts';
import type { GameState } from '../state.ts';

export interface TimeBankView {
  /** 是否已解锁 */
  unlocked: boolean;
  /** 已储存秒数 */
  storedSec: number;
  /** 上限秒数 */
  capSec: number;
  /** 储存进度 0–1 */
  fill: number;
  /** 若现在取出，各资源分别能拿到多少（已扣损耗） */
  preview: { res: string; amount: SciNum }[];
  /** 取出损耗比例 */
  loss: number;
}

/** 是否已解锁时间银行（需要对应科技） */
export function timeBankUnlocked(state: GameState, data: GameData): boolean {
  const tech = data.config.timeBank.unlockTech;
  return !!state.techs[tech] || (state.timeBank?.storedSec ?? 0) > 0;
}

export function capSecOf(data: GameData): number {
  return Math.max(0, data.config.timeBank.capHours) * 3600;
}

/** 每 tick 累积储存 */
export function tickTimeBank(state: GameState, data: GameData, dt: number): void {
  if (!state.timeBank) return;
  const cap = capSecOf(data);
  if (cap <= 0) return;
  const add = dt * data.config.timeBank.depositRatePerSec;
  state.timeBank.storedSec = Math.min(cap, state.timeBank.storedSec + add);
}

/** 面板用视图：包含"现在取出能拿到什么" */
export function timeBankView(state: GameState, data: GameData): TimeBankView {
  const capSec = capSecOf(data);
  const storedSec = state.timeBank?.storedSec ?? 0;
  const loss = data.config.timeBank.withdrawLoss;
  const keep = Math.max(0, 1 - loss);

  const preview: { res: string; amount: SciNum }[] = [];
  if (storedSec > 0) {
    for (const [res, rate] of Object.entries(state.ratePerSec)) {
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const amount = SciNum.mul(SciNum.from(rate), SciNum.from(storedSec * keep));
      if (amount.isPositive()) preview.push({ res, amount });
    }
    preview.sort((a, b) => b.amount.toNumber() - a.amount.toNumber());
  }

  return {
    unlocked: timeBankUnlocked(state, data),
    storedSec,
    capSec,
    fill: capSec > 0 ? Math.min(1, storedSec / capSec) : 0,
    preview,
    loss,
  };
}

export interface WithdrawResult {
  ok: boolean;
  reason: string;
  state?: GameState;
  gained: { res: string; amount: SciNum }[];
}

/**
 * 取出时间银行。**不修改传入的 state**。
 * 一次性结算储存在银行里的那些秒数（按当前速率），扣掉损耗。
 */
export function withdrawTimeBank(state: GameState, data: GameData): WithdrawResult {
  const view = timeBankView(state, data);
  if (view.storedSec <= 0) return { ok: false, reason: '银行里还没有储存', gained: [] };
  if (view.preview.length === 0) return { ok: false, reason: '当前没有任何正产出可以结算', gained: [] };

  const next = { ...state } as GameState;
  next.resources = { ...state.resources };
  next.timeBank = { ...(state.timeBank ?? { storedSec: 0 }) };

  const gained: { res: string; amount: SciNum }[] = [];
  for (const p of view.preview) {
    const cur = next.resources[p.res] ?? SciNum.ZERO;
    // 资源上限（如果有）同样适用于取出
    const cap = data.resources.get(p.res)?.def.cap;
    let amount = p.amount;
    if (cap) {
      const capNum = SciNum.from(String(cap));
      const room = SciNum.sub(capNum, cur);
      if (!room.isPositive()) continue;
      if (SciNum.gt(amount, room)) amount = room;
    }
    next.resources[p.res] = SciNum.add(cur, amount);
    next.totalProduced[p.res] = SciNum.add(next.totalProduced[p.res] ?? SciNum.ZERO, amount);
    gained.push({ res: p.res, amount });
  }

  next.timeBank = { storedSec: 0 };
  next.stats = { ...state.stats, timeBankWithdraws: (state.stats.timeBankWithdraws ?? 0) + 1 };

  return { ok: true, reason: '', state: next, gained };
}
