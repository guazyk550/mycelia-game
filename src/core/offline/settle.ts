/**
 * 离线结算（GDD §20）。
 *
 * 做法：把离线时长切成有限段，用**真实 engine** 复跑这段时间 —— 而不是套一个
 * "产出率 × 时间"的近似公式。这样离线收益与实际在线行为一致（缺料照样停工、
 * 土壤照样枯竭），也让"离线期间发生了什么"的事件有真实依据。
 *
 * 反作弊：
 *   · 墙钟回拨或异常未来时间 → 收益记 0 并标记 clockAnomaly；
 *   · 硬上限 offline.hardCapHours（默认 12h）；
 *   · 效率曲线有软衰减（前 2h 满额，8h 降到 50%，之后略回升），并受科技/升级加成。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { GameData } from '../types.ts';
import { computeModifiers, tick } from '../economy/engine.ts';
import { challengeEffects } from '../challenges/challenge-engine.ts'; // challenge-effects-import
import { lawBonuses } from '../meta/laws.ts';

export interface OfflineReport {
  /** 真实离线秒数（未裁剪） */
  rawSec: number;
  /** 计入结算的秒数（已套用硬上限） */
  settledSec: number;
  efficiency: number;
  gained: Record<string, SciNum>;
  /** 离线期间发生的事件描述（用于"回来看看发生了什么"） */
  events: string[];
  clockAnomaly: boolean;
  /** 结算用时（ms），用于诊断 */
  settleMs: number;
}

/** 软衰减：前 2 小时满额，8 小时降到下限，之后略回升（奖励长时间离线） */
export function offlineSoftCap(hours: number, cfg: { softCapStartHours: number; softCapFullHours: number; softCapFloor: number; hardCapHours: number }): number {
  if (hours <= cfg.softCapStartHours) return 1;
  if (hours <= cfg.softCapFullHours) {
    const t = (hours - cfg.softCapStartHours) / (cfg.softCapFullHours - cfg.softCapStartHours);
    return 1 - (1 - cfg.softCapFloor) * t;
  }
  if (hours <= cfg.hardCapHours) {
    const t = (hours - cfg.softCapFullHours) / Math.max(0.0001, cfg.hardCapHours - cfg.softCapFullHours);
    return cfg.softCapFloor + 0.1 * t;
  }
  return cfg.softCapFloor + 0.1;
}

/** 确定性伪随机（同种子同结果，便于复现与测试） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function settleOffline(
  state: GameState,
  data: GameData,
  savedAtMs: number,
  nowMs: number,
): OfflineReport {
  const cfg = data.config.offline;
  const antiCheat = data.config.antiCheat;
  const t0 = performance.now();

  // 挑战 noOffline：离线收益归零（玩家必须在线面对这条限制）
  if (challengeEffects(state, data).noOffline) {
    const rawSec = Math.max(0, (nowMs - savedAtMs) / 1000);
    return {
      rawSec,
      settledSec: 0,
      efficiency: 0,
      gained: {},
      events: ['当前挑战禁止离线收益 —— 这段时间没有被结算'],
      clockAnomaly: false,
      settleMs: Math.round((performance.now() - t0) * 100) / 100,
    };
  }

  // 法则「长眠律」让离线上限延后（改的是边界，而不是效率）
  const lawHoursAdd = lawBonuses(state, data).offlineHoursAdd;
  const effectiveHardCapSec = (cfg.hardCapHours + lawHoursAdd) * 3600;

  const rawMs = nowMs - savedAtMs;
  const rawSec = rawMs / 1000;

  // ---- 反作弊：时间回拨 / 异常未来时间
  if (rawSec < -antiCheat.clockBackToleranceSec) {
    return {
      rawSec,
      settledSec: 0,
      efficiency: 0,
      gained: {},
      events: ['检测到系统时间回拨：本次不结算离线收益（存档未受影响）'],
      clockAnomaly: true,
      settleMs: performance.now() - t0,
    };
  }
  const cappedSec = Math.min(Math.max(0, rawSec), effectiveHardCapSec, antiCheat.maxOfflineSec);
  if (cappedSec < 5) {
    return { rawSec, settledSec: cappedSec, efficiency: 1, gained: {}, events: [], clockAnomaly: false, settleMs: performance.now() - t0 };
  }

  const mods = computeModifiers(state, data);
  const efficiency = Math.min(cfg.baseEfficiency + mods.offlineEfficiency, cfg.maxEfficiency) *
    offlineSoftCap(cappedSec / 3600, cfg);

  // ---- 分段复跑：最多 600 段（12 小时 → 每段约 72 秒）
  const steps = Math.max(1, Math.min(600, Math.ceil(cappedSec / 60)));
  const dt = cappedSec / steps;
  const before: Record<string, SciNum> = {};
  for (const [id, v] of Object.entries(state.resources)) before[id] = v;

  const rng = mulberry32(data.config.simulation.deterministicSeed ^ Math.round(cappedSec));
  for (let i = 0; i < steps; i++) {
    tick(state, data, dt, { mods, rng });
  }

  // ---- 效率与"离线折扣"：把增益按 (efficiency - 1) 追加/扣减
  // 说明：tick 已经按 100% 跑了一遍，这里把差额补给玩家（>1 时奖励，<1 时扣减）。
  const gained: Record<string, SciNum> = {};
  for (const [id, after] of Object.entries(state.resources)) {
    const delta = SciNum.sub(after, before[id] ?? SciNum.ZERO);
    if (delta.isZero()) continue;
    // 只对正增长套用效率（消耗不受"效率"影响，否则缺料会算出负数收益）
    const adjusted = delta.isPositive() ? SciNum.mul(delta, efficiency) : delta;
    if (!SciNum.eq(adjusted, delta)) {
      state.resources[id] = SciNum.max(SciNum.ZERO, SciNum.add(before[id] ?? SciNum.ZERO, adjusted));
    }
    gained[id] = adjusted;
  }

  // ---- 离线事件（用真实事件表，只挑允许离线发生的正面/中性事件，以及减半的负面事件）
  const events: string[] = [];
  const offlinePool = data.events.filter((e) => e.offline);
  const maxEvents = Math.min(cfg.maxEventCount, Math.floor(cappedSec / 1800)); // 每 30 分钟一个
  for (let i = 0; i < maxEvents; i++) {
    const pool = offlinePool.filter((e) => (e.kind === 'negative' ? rng() < 0.35 : true));
    if (pool.length === 0) break;
    const pick = pool[Math.floor(rng() * pool.length)]!;
    events.push(`${pick.name}：${pick.desc}`);
  }

  // 土壤在离线期间不会被抽干（保护性规则：负面地形变化在离线减半）
  for (const node of state.graph.nodes.values()) {
    const layer = data.layers.get(node.layerId);
    if (layer) node.richness = Math.max(node.richness, layer.richnessFloor);
  }

  return {
    rawSec,
    settledSec: cappedSec,
    efficiency,
    gained,
    events,
    clockAnomaly: false,
    settleMs: performance.now() - t0,
  };
}
