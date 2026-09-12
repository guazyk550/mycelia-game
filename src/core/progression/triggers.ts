/**
 * 条件求值器：成就、任务、挑战共用同一套条件语言。
 *
 * 设计：`cond.kind` 是开放字符串集合（数据表定义），未知 kind 返回 false 并记录一次警告，
 * 而不是抛错 —— 这样后续数据表新增条件类型时，旧代码只是"暂时不识别"，不会崩。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { ConditionDef, GameData } from '../types.ts';

const warned = new Set<string>();

export interface TriggerContext {
  /** 游戏内累计秒数 */
  elapsed: number;
  /** 玩家最高的单次离线小时数（没有则 0） */
  offlineHours: number;
  /** 当前连击 */
  combo: number;
  /** 本轮最长连击时长（秒） */
  comboSec: number;
  /** 暴击连击 */
  critChain: number;
  /** 完成的事件链数量 */
  eventChains: number;
  /** 已完成的挑战数 */
  challengesDone: number;
  /** 极限模式完成的挑战数 */
  hardcoreChallenges: number;
  /** 走过的地块轮作次数 */
  rotations: number;
  /** 触发过的过载次数 */
  overloads: number;
}

export const EMPTY_TRIGGER_CONTEXT: TriggerContext = {
  elapsed: 0,
  offlineHours: 0,
  combo: 0,
  comboSec: 0,
  critChain: 0,
  eventChains: 0,
  challengesDone: 0,
  hardcoreChallenges: 0,
  rotations: 0,
  overloads: 0,
};

/** 累计产出（成就看"曾经达到过"，而不是当前持有） */
function total(state: GameState, res: string): SciNum {
  return state.totalProduced[res] ?? SciNum.ZERO;
}

export function evaluateTrigger(cond: ConditionDef, state: GameState, data: GameData, ctx: TriggerContext): boolean {
  const kind = cond.kind;
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

  switch (kind) {
    // ---- 资源与生产
    case 'resource':
    case 'resourceAny':
      return SciNum.gte(total(state, cond.res ?? ''), SciNum.from(cond.amount ?? '0'));
    case 'rateAny': {
      const target = SciNum.from(cond.amount ?? '0');
      for (const rate of Object.values(state.ratePerSec)) if (SciNum.gte(SciNum.from(Math.max(0, rate)), target)) return true;
      return false;
    }
    case 'nodes':
      return state.graph.size() >= num(cond.value);
    case 'links':
      return state.graph.links.size >= num(cond.value);
    case 'classes': {
      const set = new Set<string>();
      for (const n of state.graph.nodes.values()) {
        const def = data.nodes.get(n.typeId);
        if (def) set.add(def.def.class);
      }
      return set.size >= num(cond.value);
    }
    case 'layers':
      return state.unlockedLayers.length >= num(cond.value);
    case 'richness': {
      // 达到过该富饶度（含"抽到 0"这类极限成就）
      for (const n of state.graph.nodes.values()) {
        if (num(cond.value) === 0 ? n.richness <= 0.5 : n.richness >= num(cond.value)) return true;
      }
      return false;
    }
    case 'cycles':
      return state.graph.findCycles().length >= Math.max(1, num(cond.value));

    // ---- 成长
    case 'upgrades': {
      let totalLevels = 0;
      for (const lvl of Object.values(state.upgrades)) totalLevels += lvl;
      return totalLevels >= num(cond.value);
    }
    case 'techs':
      return Object.keys(state.techs).length >= num(cond.value);
    case 'tech':
      return state.techs[String(cond.value)] === true;
    case 'achievements':
      return Object.keys(state.achievements).length >= num(cond.value);
    case 'prestige':
      return state.prestige.count >= num(cond.value);
    case 'prestigeLevel':
      return state.prestige.level >= num(cond.value);
    case 'strainsUsed':
      return state.stats.strainsUsed >= num(cond.value);
    case 'genesUnlocked':
      return state.stats.genesUnlocked >= num(cond.value);

    // ---- 操作与状态
    case 'combo':
      return ctx.combo >= num(cond.value);
    case 'comboDuration':
      return ctx.comboSec >= num(cond.value);
    case 'critChain':
      return ctx.critChain >= num(cond.value);
    case 'playTime':
      return ctx.elapsed >= num(cond.value);
    case 'offline':
      return ctx.offlineHours >= num(cond.value);
    case 'idleNoClick':
      return state.stats.idleNoClickSec >= num(cond.value);
    case 'eventsSeen':
      return state.stats.eventsSeen.length >= num(cond.value);
    case 'events':
      return state.stats.eventsSeen.length >= num(cond.value);
    case 'contracts':
      return state.stats.contractsSigned >= num(cond.value);
    case 'speciesKnown':
      return state.stats.speciesKnown >= num(cond.value);
    case 'codex':
      return state.stats.codexEntries >= num(cond.value);
    case 'eventsSeenAny':
      return state.stats.eventsSeen.length >= num(cond.value);

    // ---- 挑战与极限
    case 'challengesDone':
      return ctx.challengesDone >= num(cond.value);
    case 'hardcoreChallenges':
      return ctx.hardcoreChallenges >= num(cond.value);
    case 'challenge':
      return state.stats.challengesCompleted.includes(String(cond.value));

    // ---- 未实现 / 特殊条件：返回 false，并只警告一次
    default:
      if (!warned.has(kind)) {
        warned.add(kind);
        if (typeof console !== 'undefined') console.warn(`[triggers] 尚未实现的条件类型: ${kind}`);
      }
      return false;
  }
}

/** 供测试重置警告集合 */
export function resetTriggerWarnings(): void {
  warned.clear();
}
