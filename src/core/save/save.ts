/**
 * 存档：序列化 / 反序列化 / 校验 / 版本迁移。
 *
 * 设计约束（GDD §24）：
 *   · 存档是纯 JSON，可导出/导入为文本；
 *   · 带 version 与 checksum（FNV-1a）；校验失败**不静默删档**，而是让调用方进入只读沙盒；
 *   · 加载时扫描全部数值，NaN/Infinity/负数会被夹紧并记录警告，而不是让坏档把游戏带崩；
 *   · 迁移链式执行 v1 → v2 → …，未知的高版本直接拒绝。
 */

import { SciNum } from '../math/scinum.ts';
import { NetworkGraph, type LinkInstance, type NodeInstance } from '../network/graph.ts';
import { makeRule, validateRule, type AutoRule } from '../automation/rules.ts';
import type { ActiveEvent, GameState } from '../state.ts';
import type { GameData } from '../types.ts';
import { snapToTile } from '../network/occupancy.ts';

export const CURRENT_SAVE_VERSION = 1;

export interface SerializedState {
  version: number;
  tick: number;
  elapsed: number;
  resources: Record<string, string>;
  totalProduced: Record<string, string>;
  nodes: NodeInstance[];
  links: LinkInstance[];
  buildQueue: Record<string, number>;
  unlockedLayers: string[];
  upgrades: Record<string, number>;
  techs: string[];
  achievements: string[];
  activeEvents: ActiveEvent[];
  prestige: {
    count: number;
    level: number;
    sporogene: string;
    totalSporogene: string;
    strain: string | null;
    roundStartedAt: number;
    /** 上次切换菌株的时刻（elapsed 秒）；-1 = 从未切换（无冷却） */
    lastStrainSwitchAt?: number;
  };
  combo: { stacks: number; lastActionAt: number };
  stats: GameState['stats'];
  seq: { node: number; link: number };
  autoRules: AutoRule[];
  autoConfig: GameState['autoConfig'];
  questBonuses: GameState['questBonuses'];
  market: GameState['market'];
  /** 时间银行（惊喜机制） */
  timeBank?: { storedSec: number };
  /** 玩家自定义催化规则（惊喜机制） */
  customRules?: { upstreamTag: string; downstreamClass: string; rateMul: number }[];
  /** 生态法则（Meta 层） */
  laws?: { id: string; target: string | null; stacks: number }[];
  /** 挑战状态（snapshot 不落盘：回滚点只活在内存里） */
  challenges?: {
    runtime: {
      id: string;
      startedAt: number;
      seed: number;
      relinked: number;
      shuffled: number;
      stolen: string;
      done: boolean;
    } | null;
    completed: Record<string, true>;
    failures: number;
  };
}

export interface SaveFile {
  version: number;
  /** 墙钟时间（ms）—— 离线结算用 */
  savedAt: number;
  /** 累计游戏内秒数 */
  gameTime: number;
  checksum: string;
  state: SerializedState;
}

// ---------------------------------------------------------------- 校验和

/** FNV-1a 32 位（够用且零依赖；不追求密码学强度） */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function computeChecksum(state: SerializedState): string {
  return fnv1a(JSON.stringify(state));
}

// ---------------------------------------------------------------- 序列化

export function serializeState(state: GameState): SerializedState {
  const resources: Record<string, string> = {};
  const totalProduced: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.resources)) resources[k] = v.serialize();
  for (const [k, v] of Object.entries(state.totalProduced)) totalProduced[k] = v.serialize();

  return {
    version: CURRENT_SAVE_VERSION,
    tick: state.tick,
    elapsed: state.elapsed,
    resources,
    totalProduced,
    nodes: [...state.graph.nodes.values()].map((n) => ({ ...n })),
    links: [...state.graph.links.values()].map((l) => ({ ...l })),
    buildQueue: { ...state.buildQueue },
    unlockedLayers: [...state.unlockedLayers],
    upgrades: { ...state.upgrades },
    techs: Object.keys(state.techs),
    achievements: Object.keys(state.achievements),
    activeEvents: state.activeEvents.map((e) => ({ ...e })),
    prestige: {
      count: state.prestige.count,
      level: state.prestige.level,
      sporogene: state.prestige.sporogene.serialize(),
      totalSporogene: state.prestige.totalSporogene.serialize(),
      strain: state.prestige.strain,
      roundStartedAt: state.prestige.roundStartedAt,
      lastStrainSwitchAt: state.prestige.lastStrainSwitchAt,
    },
    combo: { ...state.combo },
    stats: { ...state.stats, nodeUpgrades: { ...state.stats.nodeUpgrades } },
    seq: { ...state.seq },
    autoRules: state.autoRules.map((r) => ({ ...r, cond: { ...r.cond }, act: { ...r.act } })),
    autoConfig: { ...state.autoConfig },
    questBonuses: state.questBonuses.map((e) => ({ ...e })),
    timeBank: { storedSec: state.timeBank.storedSec },
    customRules: state.customRules.map((r) => ({ ...r })),
    laws: state.laws.map((l) => ({ ...l })),
    challenges: {
      runtime: state.challenges.runtime
        ? {
            id: state.challenges.runtime.id,
            startedAt: state.challenges.runtime.startedAt,
            seed: state.challenges.runtime.seed,
            relinked: state.challenges.runtime.relinked,
            shuffled: state.challenges.runtime.shuffled,
            stolen: state.challenges.runtime.stolen.serialize(),
            done: state.challenges.runtime.done,
          }
        : null,
      completed: { ...state.challenges.completed },
      failures: state.challenges.failures,
    },
    market: {
      entries: Object.fromEntries(Object.entries(state.market.entries).map(([k, v]) => [k, { ...v }])),
      volume: state.market.volume,
      lastTick: state.market.lastTick,
    },
  };
}

export interface LoadResult {
  ok: boolean;
  /** 校验失败（篡改/损坏）—— 调用方应进入只读沙盒而不是覆盖存档 */
  tampered: boolean;
  warnings: string[];
  state: GameState | null;
  gameTime: number;
  savedAt: number;
}

/** 把任意数值夹到合法区间；返回被修正的项数 */
function sanitizeAmount(v: SciNum, where: string, warnings: string[]): SciNum {
  if (!v.isFinite()) {
    warnings.push(`${where}: 非有限值，已重置为 0`);
    return SciNum.ZERO;
  }
  if (v.isNegative()) {
    warnings.push(`${where}: 负值，已夹紧为 0`);
    return SciNum.ZERO;
  }
  return v;
}

export function deserializeState(
  file: SaveFile,
  data: GameData,
  options: { skipChecksum?: boolean } = {},
): LoadResult {
  const warnings: string[] = [];
  const state = file.state;
  if (!state || typeof state !== 'object') {
    return { ok: false, tampered: false, warnings: ['存档结构缺失'], state: null, gameTime: 0, savedAt: 0 };
  }

  const tampered = !options.skipChecksum && file.checksum !== computeChecksum(state);
  if (tampered) return { ok: false, tampered: true, warnings: ['校验和不匹配（存档可能被修改）'], state: null, gameTime: file.gameTime ?? 0, savedAt: file.savedAt ?? 0 };

  if (file.version > CURRENT_SAVE_VERSION) {
    return { ok: false, tampered: false, warnings: [`存档版本 ${file.version} 高于当前支持的 ${CURRENT_SAVE_VERSION}`], state: null, gameTime: 0, savedAt: 0 };
  }

  // ---- 迁移链（目前只有 v1；后续版本在这里追加 v1→v2 的转换）
  let migrated = state;

  const graph = new NetworkGraph();
  const nodeIds = new Set<string>();
  for (const n of migrated.nodes ?? []) {
    if (!data.nodes.has(n.typeId)) {
      warnings.push(`节点 ${n.id} 的类型 ${n.typeId} 不存在，已跳过`);
      continue;
    }
    const richness = Number.isFinite(n.richness) ? Math.max(0, Math.min(200, n.richness)) : 60;
    // 坐标也必须夹紧并吸附到占位网格：NaN 坐标会让节点渲染到不可见的位置
    // （玩家看得到节点数在涨，却点不到任何一个），同时防止篡改后节点堆叠。
    const snapped = snapToTile(Number.isFinite(n.x) ? n.x : 0, Number.isFinite(n.y) ? n.y : 0);
    graph.addNode({ ...n, x: snapped.x, y: snapped.y, richness });
    nodeIds.add(n.id);
  }
  for (const l of migrated.links ?? []) {
    if (!nodeIds.has(l.from) || !nodeIds.has(l.to)) {
      warnings.push(`连线 ${l.id} 指向已不存在的节点，已跳过`);
      continue;
    }
    try {
      graph.addLink({ ...l });
    } catch (e) {
      warnings.push(`连线 ${l.id} 无效：${(e as Error).message}`);
    }
  }

  const resources: Record<string, SciNum> = {};
  for (const [id, def] of data.resources) {
    const raw = migrated.resources?.[id];
    const v = raw === undefined ? def.startAmount : SciNum.from(raw);
    resources[id] = sanitizeAmount(v, `资源 ${id}`, warnings);
  }
  const totalProduced: Record<string, SciNum> = {};
  for (const [id, raw] of Object.entries(migrated.totalProduced ?? {})) {
    totalProduced[id] = sanitizeAmount(SciNum.from(raw), `累计产出 ${id}`, warnings);
  }

  const state2: GameState = {
    version: CURRENT_SAVE_VERSION,
    tick: Math.max(0, Math.floor(migrated.tick ?? 0)),
    elapsed: Math.max(0, migrated.elapsed ?? 0),
    resources,
    totalProduced,
    ratePerSec: {},
    graph,
    seq: migrated.seq ?? { node: nodeIds.size, link: 0 },
    buildQueue: migrated.buildQueue ?? {},
    unlockedLayers: (migrated.unlockedLayers ?? []).filter((id) => data.layers.has(id)),
    upgrades: Object.fromEntries(
      Object.entries(migrated.upgrades ?? {}).filter(([id]) => data.upgrades.has(id)),
    ),
    techs: Object.fromEntries((migrated.techs ?? []).filter((id) => data.techs.has(id)).map((id) => [id, true as const])),
    achievements: Object.fromEntries(
      (migrated.achievements ?? []).filter((id) => data.achievements.has(id)).map((id) => [id, true as const]),
    ),
    activeEvents: migrated.activeEvents ?? [],
    timeBank: { storedSec: Math.max(0, migrated.timeBank?.storedSec ?? 0) },
    customRules: (migrated.customRules ?? []).map((r) => ({ upstreamTag: r.upstreamTag, downstreamClass: r.downstreamClass, rateMul: r.rateMul })),
    laws: (migrated.laws ?? []).map((l) => ({ id: l.id, target: l.target ?? null, stacks: Math.max(1, l.stacks ?? 1) })),
    challenges: {
      // 回滚快照不跨会话：挑战期间关掉游戏后就只能退回干净开局
      runtime: migrated.challenges?.runtime
        ? {
            id: migrated.challenges.runtime.id,
            startedAt: migrated.challenges.runtime.startedAt ?? 0,
            seed: migrated.challenges.runtime.seed ?? 0,
            relinked: migrated.challenges.runtime.relinked ?? 0,
            shuffled: migrated.challenges.runtime.shuffled ?? 0,
            stolen: SciNum.from(migrated.challenges.runtime.stolen ?? '0'),
            done: migrated.challenges.runtime.done ?? false,
            snapshot: null,
          }
        : null,
      completed: migrated.challenges?.completed ?? {},
      failures: migrated.challenges?.failures ?? 0,
    },
    prestige: {
      count: migrated.prestige?.count ?? 0,
      level: migrated.prestige?.level ?? 0,
      sporogene: sanitizeAmount(SciNum.from(migrated.prestige?.sporogene ?? '0'), '孢子基因', warnings),
      totalSporogene: sanitizeAmount(SciNum.from(migrated.prestige?.totalSporogene ?? '0'), '累计孢子基因', warnings),
      strain: migrated.prestige?.strain ?? null,
      roundStartedAt: migrated.prestige?.roundStartedAt ?? 0,
      lastStrainSwitchAt: migrated.prestige?.lastStrainSwitchAt ?? -1,
    },
    combo: migrated.combo ?? { stacks: 0, lastActionAt: 0 },
    stats: {
      catalystUses: migrated.stats?.catalystUses ?? 0,
      nodesBuilt: migrated.stats?.nodesBuilt ?? 0,
      linksBuilt: migrated.stats?.linksBuilt ?? 0,
      upgradesBought: migrated.stats?.upgradesBought ?? 0,
      techsUnlocked: migrated.stats?.techsUnlocked ?? 0,
      crits: migrated.stats?.crits ?? 0,
      nodeUpgrades: migrated.stats?.nodeUpgrades ?? {},
      strainsUsed: migrated.stats?.strainsUsed ?? 0,
      strainCodex: migrated.stats?.strainCodex ?? [],
      strainSwitchCount: migrated.stats?.strainSwitchCount ?? 0,
      maxPrestigeLevel: migrated.stats?.maxPrestigeLevel ?? 0,
      lawsApplied: migrated.stats?.lawsApplied ?? 0,
      timeBankWithdraws: migrated.stats?.timeBankWithdraws ?? 0,
      customRulesMade: migrated.stats?.customRulesMade ?? 0,
      lastChainTag: migrated.stats?.lastChainTag ?? null,
      chainStreak: migrated.stats?.chainStreak ?? 0,
      echoesFound: migrated.stats?.echoesFound ?? 0,
      hostility: migrated.stats?.hostility ?? 0,
      genesUnlocked: migrated.stats?.genesUnlocked ?? 0,
      idleNoClickSec: migrated.stats?.idleNoClickSec ?? 0,
      eventsSeen: migrated.stats?.eventsSeen ?? [],
      contractsSigned: migrated.stats?.contractsSigned ?? 0,
      speciesKnown: migrated.stats?.speciesKnown ?? 0,
      codexEntries: migrated.stats?.codexEntries ?? 0,
      challengesCompleted: migrated.stats?.challengesCompleted ?? [],
      maxOfflineHours: migrated.stats?.maxOfflineHours ?? 0,
      maxAutoTier: migrated.stats?.maxAutoTier ?? 0,
      seasonCycles: migrated.stats?.seasonCycles ?? 0,
      tilesRepaired: migrated.stats?.tilesRepaired ?? 0,
      reverseRecipeUsed: migrated.stats?.reverseRecipeUsed ?? false,
      questsCompleted: migrated.stats?.questsCompleted ?? [],
    },
    topoDirty: true,
    autoRules: (migrated.autoRules ?? [])
      .map((r) => ({ ...makeRule({ id: r.id ?? `rule-${Math.random().toString(36).slice(2, 8)}` }), ...r }))
      .filter((r) => {
        const problem = validateRule(r, data);
        if (problem) warnings.push(`规则「${r.name}」已停用：${problem}`);
        return problem === null;
      }),
    autoConfig: {
      autoPrestigeThreshold: migrated.autoConfig?.autoPrestigeThreshold ?? '10',
    },
    questBonuses: (migrated.questBonuses ?? []).filter((e) => e && typeof e.kind === 'string'),
    market: migrated.market ?? { entries: {}, volume: SciNum.ZERO, lastTick: 0 },
  };
  void migrated;

  return { ok: true, tampered: false, warnings, state: state2, gameTime: file.gameTime ?? 0, savedAt: file.savedAt ?? 0 };
}

export function makeSaveFile(state: GameState, nowMs: number): SaveFile {
  const serialized = serializeState(state);
  return {
    version: CURRENT_SAVE_VERSION,
    savedAt: nowMs,
    gameTime: state.elapsed,
    checksum: computeChecksum(serialized),
    state: serialized,
  };
}

export function saveToJson(state: GameState, nowMs: number): string {
  return JSON.stringify(makeSaveFile(state, nowMs));
}

export function loadFromJson(text: string, data: GameData): LoadResult {
  let file: SaveFile;
  try {
    file = JSON.parse(text) as SaveFile;
  } catch (e) {
    return { ok: false, tampered: false, warnings: [`存档解析失败：${(e as Error).message}`], state: null, gameTime: 0, savedAt: 0 };
  }
  return deserializeState(file, data);
}
