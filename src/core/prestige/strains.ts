/**
 * 菌株（Build）系统 —— 6 种流派的规则改写。
 *
 * 设计约束（来自 GDD §32 与数据表校验规则）：
 *   1. 菌株必须**改写规则**，不只是加数值 —— 否则只是"选一个大数字"；
 *   2. 每种菌株都有明确代价（drawbacks），不存在无脑最优解；
 *   3. 切换有冷却（game-config.prestige.strainCooldownHours，默认 24 游戏小时），
 *      冷却不随孢子化重置 —— 否则"打不过就换一个"会变成常规操作。
 *
 * 本模块只负责"选择与解锁"；效果如何作用于产出、成本、土壤、离线，
 * 由 computeModifiers 与 engine 里的 specials 分支负责。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameData, ParsedStrain, StrainDef } from '../types.ts';
import type { GameState } from '../state.ts';

export interface StrainAvailability {
  def: StrainDef;
  /** 已满足解锁层级 */
  levelOk: boolean;
  /** 正在使用 */
  active: boolean;
  /** 表达成本（基因片段） */
  geneCost: SciNum;
  /** 当前持有是否够付 */
  affordable: boolean;
  /** 冷却剩余秒数（0 = 可切换） */
  cooldownLeft: number;
  /** 是否可切换到它（含所有条件） */
  selectable: boolean;
  /** 不可选的原因（可直接显示给玩家） */
  reason: string;
}

/** 切换冷却总时长（秒） */
export function strainCooldownSec(data: GameData): number {
  const hours = data.config.prestige.strainCooldownHours;
  return Math.max(0, hours) * 3600;
}

/** 冷却剩余秒数 */
export function strainCooldownLeft(state: GameState, data: GameData): number {
  const total = strainCooldownSec(data);
  if (total <= 0) return 0;
  const last = state.prestige.lastStrainSwitchAt;
  // 从未切换过则没有冷却
  if (last < 0) return 0;
  return Math.max(0, total - (state.elapsed - last));
}

/**
 * 列出全部菌株的当前可用状态。
 * 注意：即使已解锁且付得起，冷却中也不可选 —— UI 会显示剩余时间。
 */
export function listStrains(state: GameState, data: GameData): StrainAvailability[] {
  const cooldownLeft = strainCooldownLeft(state, data);
  const out: StrainAvailability[] = [];

  for (const strain of data.strains.values()) {
    const def = strain.def;
    const levelOk = state.prestige.level >= def.unlockLevel;
    const active = state.prestige.strain === def.id;
    const geneCost = strain.geneCost;
    const affordable = SciNum.gte(state.resources['gene'] ?? SciNum.ZERO, geneCost);

    let selectable = true;
    let reason = '';
    if (active) {
      selectable = false;
      reason = '正在表达';
    } else if (!levelOk) {
      selectable = false;
      reason = `需要第 ${def.unlockLevel} 层孢子化`;
    } else if (!affordable) {
      selectable = false;
      reason = `需要 ${SciNum.format(geneCost)} 基因片段`;
    } else if (cooldownLeft > 0) {
      selectable = false;
      reason = `切换冷却中（剩余 ${formatDuration(cooldownLeft)}）`;
    }

    out.push({ def, levelOk, active, geneCost, affordable, cooldownLeft, selectable, reason });
  }

  // 按解锁层级排序，开局可用的排前面
  return out.sort((a, b) => a.def.unlockLevel - b.def.unlockLevel || a.def.id.localeCompare(b.def.id));
}

export interface StrainSwitchResult {
  ok: boolean;
  reason: string;
  /** 成功时返回新状态（切菌株会扣基因片段） */
  state?: GameState;
}

/**
 * 切换到指定菌株。**不修改传入的 state**，成功时返回新状态。
 *
 * 与孢子化的区别：切换菌株不重置网络与资源（只付基因片段），因此它是一次
 * "改规则"的战术选择，而不是"重开一局"。
 */
export function switchStrain(state: GameState, data: GameData, strainId: string): StrainSwitchResult {
  const strain = data.strains.get(strainId);
  if (!strain) return { ok: false, reason: `未知菌株：${strainId}` };

  const list = listStrains(state, data);
  const entry = list.find((s) => s.def.id === strainId);
  if (!entry) return { ok: false, reason: `未知菌株：${strainId}` };
  if (!entry.selectable) return { ok: false, reason: entry.reason };

  const next = { ...state } as GameState;
  next.resources = { ...state.resources };
  next.stats = { ...state.stats };

  const gene = next.resources['gene'] ?? SciNum.ZERO;
  const after = SciNum.sub(gene, strain.geneCost);
  next.resources['gene'] = after.isNegative() ? SciNum.ZERO : after;

  next.prestige = {
    ...state.prestige,
    strain: strainId,
    lastStrainSwitchAt: state.elapsed,
  };
  // 图鉴名单与 strainsUsed 必须同步更新：早期版本只加了 strainsUsed 却没写名单，
  // 于是"切换到用过的菌株"会被重复计数（六种表达类成就可能提前解锁）。
  const codex = state.stats.strainCodex ?? [];
  const firstTime = !codex.includes(strainId);
  next.stats.strainCodex = firstTime ? [...codex, strainId] : [...codex];
  next.stats.strainsUsed = next.stats.strainCodex.length;
  next.stats.strainSwitchCount = (state.stats.strainSwitchCount ?? 0) + 1;

  return { ok: true, reason: '', state: next };
}

/** 该菌株此前是否已表达过（用于「六种表达」类成就只计一次） */
function usedBefore(state: GameState, data: GameData, strainId: string): boolean {
  if (state.prestige.strain === strainId) return true;
  // 从成就/统计里反推：strainCodex 名单由 stats.strainCodex 记录
  return (state.stats.strainCodex ?? []).includes(strainId);
}

/** 记录"曾经表达过"的菌株名单（切换成功时调用，供图鉴与成就使用） */
export function markStrainInCodex(state: GameState, strainId: string): void {
  state.stats.strainCodex = state.stats.strainCodex ?? [];
  if (!state.stats.strainCodex.includes(strainId)) state.stats.strainCodex.push(strainId);
  state.stats.strainsUsed = state.stats.strainCodex.length;
}

/** 深色主题下的菌株配色（供 UI 使用） */
export function strainColor(def: StrainDef, lightness = 62): string {
  return `hsl(${def.hue}, 62%, ${lightness}%)`;
}

/** 人类可读的时长（1h 20m / 45s） */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 解析出的菌株条目（便于测试与 UI 直接拿到 SciNum 成本） */
export function getStrain(data: GameData, id: string): ParsedStrain | undefined {
  return data.strains.get(id);
}

/**
 * 当前菌株的特殊开关集合。
 * engine 与 UI 都通过它判断"这条规则是否被改写"，避免到处写字符串比较。
 */
export function activeSpecials(state: GameState, data: GameData): Set<string> {
  const id = state.prestige.strain;
  if (!id) return new Set();
  return new Set(data.strains.get(id)?.def.specials ?? []);
}

/** 当前菌株定义（没有则 null） */
export function activeStrain(state: GameState, data: GameData): StrainDef | null {
  const id = state.prestige.strain;
  if (!id) return null;
  return data.strains.get(id)?.def ?? null;
}
