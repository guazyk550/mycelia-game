/**
 * 孢子化（Prestige 第一层）与跨世代保留规则。
 *
 * 保留（GDD §35）：成就、图鉴、菌株解锁、挑战记录、机制/隐藏类升级、科技、孢子基因。
 * 重置：可见资源、网络、节点、建造队列。
 *
 * 门槛：必须"曾经产出过共生核心"—— 核心腔是孢子化的门票，这保证了玩家在重置前
 * 至少走通过一次完整的中期生产链（晶格 + 健康土壤）。
 */

import { SciNum } from '../math/scinum.ts';
import { createNewGame, type GameState } from '../state.ts';
import { computeModifiers, networkValue, sporogeneGain } from '../economy/engine.ts';
import type { GameData } from '../types.ts';
import { challengeEffects } from '../challenges/challenge-engine.ts';
import { lawBonuses } from '../meta/laws.ts';

export interface PrestigeReport {
  gain: SciNum;
  newCount: number;
  totalSporogene: SciNum;
  keptUpgrades: number;
  keptTechs: number;
  keptAchievements: number;
  resourcesLost: number;
  nodesLost: number;
  /** 孢子化后的层级（首次孢子化即第 1 层） */
  layer: number;
  /** 跨世代保留的自动化规则数（P3 虫巢意识解锁的能力不应因重置丢失） */
  keptAutoRules: number;
  /** 跨世代保留的任务奖励加成数 */
  keptQuestBonuses: number;
}

export interface PrestigeCheck {
  allowed: boolean;
  reason: string;
  gain: SciNum;
  /** 成熟度（本轮时长决定的收益折扣） */
  maturity: number;
  networkValue: SciNum;
}

export function checkPrestige(state: GameState, data: GameData): PrestigeCheck {
  const mods = computeModifiers(state, data);
  const gain = sporogeneGain(state, data, mods);
  const value = networkValue(state, data);
  const roundTime = Math.max(0, state.elapsed - state.prestige.roundStartedAt);
  // 法则「速熟律」抬高成熟度下限（改的是"多久算长够"这条定义）
  const maturityFloor = 0.2 + lawBonuses(state, data).maturityFloorAdd;
  const maturity = Math.max(Math.min(1, maturityFloor), Math.min(1, Math.sqrt(roundTime / 600)));

  // 挑战 noPrestige：禁止孢子化（想重置得先把挑战打完或放弃）
  if (challengeEffects(state, data).noPrestige) {
    return { allowed: false, reason: '当前挑战禁止孢子化 —— 打完它或主动放弃', gain, maturity, networkValue: value };
  }

  if (!SciNum.gt(state.totalProduced.core ?? SciNum.ZERO, SciNum.ZERO)) {
    return {
      allowed: false,
      reason: '尚未产出过共生核心 —— 核心腔是孢子化的门票（晶格 + 电信号 + 健康土壤）',
      gain,
      maturity,
      networkValue: value,
    };
  }
  if (state.graph.size() === 0) {
    return { allowed: false, reason: '网络为空', gain, maturity, networkValue: value };
  }
  return { allowed: true, reason: '', gain, maturity, networkValue: value };
}

/** 执行孢子化：返回**新状态**（不修改传入的 state） */
export function doPrestige(state: GameState, data: GameData): { state: GameState; report: PrestigeReport } {
  const mods = computeModifiers(state, data);
  const gain = sporogeneGain(state, data, mods);
  const fresh = createNewGame(data);

  // ---- 跨世代保留
  fresh.prestige = {
    count: state.prestige.count + 1,
    // 孢子化本身就是第 1 层：第一次孢子化后层级至少为 1（P2–P5 由 layers.advanceLayer 推进）
    level: Math.max(1, state.prestige.level),
    sporogene: SciNum.add(state.prestige.sporogene, gain),
    totalSporogene: SciNum.add(state.prestige.totalSporogene, gain),
    strain: state.prestige.strain,
    roundStartedAt: state.elapsed,
    // 切换冷却**不因孢子化而重置**（否则「打不过就换个菌株」会变成常规操作）
    lastStrainSwitchAt: state.prestige.lastStrainSwitchAt,
  };
  // 挑战 noCarryover：本次孢子化不保留任何"外部加成"（科技与机制升级全部清空）
  const noCarry = challengeEffects(state, data).noCarryover;
  fresh.achievements = { ...state.achievements };
  fresh.techs = noCarry ? {} : { ...state.techs };

  let keptUpgrades = 0;
  for (const [id, lvl] of Object.entries(state.upgrades)) {
    const cat = data.upgrades.get(id)?.def.cat;
    // 机制类与隐藏类升级是永久机制（基因树的简化替身，完整基因树在 PHASE 4 批次 C）
    if (!noCarry && (cat === 'mechanic' || cat === 'hidden')) {
      fresh.upgrades[id] = lvl;
      keptUpgrades++;
    }
  }

  // 时间与统计延续，避免 UI 显示"回到 0 秒"
  fresh.elapsed = state.elapsed;
  fresh.tick = state.tick;
  fresh.stats = {
    ...state.stats,
    nodeUpgrades: { ...state.stats.nodeUpgrades },
    strainCodex: [...(state.stats.strainCodex ?? [])],
  };

  // P3 虫巢意识解锁的自动化规则与配置、以及任务奖励带来的永久加成，
  // 都属于"机制"而非"本轮进度"—— 重置会剥夺玩家已经获得的能力，属于设计事故。
  fresh.autoRules = state.autoRules.map((r) => ({ ...r, cond: { ...r.cond }, act: { ...r.act } }));
  fresh.autoConfig = { ...state.autoConfig };
  fresh.questBonuses = state.questBonuses.map((e) => ({ ...e }));

  return {
    state: fresh,
    report: {
      gain,
      newCount: fresh.prestige.count,
      totalSporogene: fresh.prestige.sporogene,
      keptUpgrades,
      keptTechs: Object.keys(fresh.techs).length,
      keptAchievements: Object.keys(fresh.achievements).length,
      resourcesLost: Object.values(state.resources).filter((v) => v.isPositive()).length,
      nodesLost: state.graph.size(),
      layer: fresh.prestige.level,
      keptAutoRules: fresh.autoRules.length,
      keptQuestBonuses: fresh.questBonuses.length,
    },
  };
}
