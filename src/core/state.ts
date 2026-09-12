/**
 * 游戏状态容器与初始化。状态是纯数据（可序列化）；所有变更都通过 economy/engine.ts 的函数完成。
 */

import { SciNum } from './math/scinum.ts';
import { NetworkGraph, type NodeInstance } from './network/graph.ts';
import type { AutoRule } from './automation/rules.ts';
import type { MarketEntry, MarketState } from './market/market.ts';
import type { EffectDef, GameData, ModifierDef } from './types.ts';

export interface ActiveEvent {
  instanceId: string;
  eventId: string;
  startedAt: number;
  endsAt: number;
  /** 已结算的强度倍率（离线/事件抗性修正后） */
  strength: number;
  isOffline: boolean;
}

/**
 * 挑战运行时。
 *
 * `snapshot` 是"放弃挑战时回滚到哪" —— 它只活在内存里（不进存档）：
 * 挑战期间关掉游戏，回滚点就丢了，此时放弃会退回干净开局而不是假称已回滚。
 */
export interface ChallengeRuntime {
  id: string;
  startedAt: number;
  /** 回滚快照（仅内存；序列化时被丢弃） */
  snapshot: GameState | null;
  /** 确定性随机种子（randomRelink / matrixShuffle / resourceTheft 用） */
  seed: number;
  relinked: number;
  shuffled: number;
  stolen: SciNum;
  /** 是否已结算 */
  done: boolean;
}

/** 已应用的生态法则（Meta 层）—— 定义在这里以避免 state 与 meta 模块循环引用 */
export interface LawInstance {
  id: string;
  /** 目标（needsTarget 时有值，例如资源 id） */
  target: string | null;
  /** 应用次数（≤ maxStacks） */
  stacks: number;
}

export interface ChallengeState {
  runtime: ChallengeRuntime | null;
  /** 已完成（奖励永久） */
  completed: Record<string, true>;
  /** 失败/放弃次数 */
  failures: number;
}

export interface GameState {
  version: number;
  /** 已结算的 tick 数 */
  tick: number;
  /** 游戏内经过的秒数（离线收益也计入） */
  elapsed: number;
  resources: Record<string, SciNum>;
  /** 累计产出（成就与统计用） */
  totalProduced: Record<string, SciNum>;
  /** 最近一次 tick 的每秒净产出（UI 显示用） */
  ratePerSec: Record<string, number>;
  graph: NetworkGraph;
  seq: { node: number; link: number };
  /** 建造队列：nodeId → 完成时刻（elapsed 秒） */
  buildQueue: Record<string, number>;
  unlockedLayers: string[];
  /** 升级等级：upgradeId → level */
  upgrades: Record<string, number>;
  techs: Record<string, true>;
  achievements: Record<string, true>;
  activeEvents: ActiveEvent[];
  /** 挑战系统状态（PHASE 4 批次 C） */
  challenges: ChallengeState;
  /** 已应用的生态法则（PHASE 4 批次 C，Meta 层） */
  laws: LawInstance[];
  /** 时间银行（惊喜机制）：储存的时间秒数 */
  timeBank: { storedSec: number };
  /** 玩家自定义的催化规则（惊喜机制，受总量守恒限制） */
  customRules: { upstreamTag: string; downstreamClass: string; rateMul: number }[];
  prestige: {
    count: number;
    level: number;
    /** 当前持有的孢子基因 */
    sporogene: SciNum;
    /** 历史累计孢子基因 */
    totalSporogene: SciNum;
    strain: string | null;
    /** 本轮开始时刻（elapsed 秒）；孢子化收益的「成熟度」因子依赖它 */
    roundStartedAt: number;
    /** 上次切换菌株的时刻（elapsed 秒）；-1 表示从未切换（无冷却） */
    lastStrainSwitchAt: number;
  };
  combo: { stacks: number; lastActionAt: number };
  stats: {
    catalystUses: number;
    nodesBuilt: number;
    linksBuilt: number;
    upgradesBought: number;
    techsUnlocked: number;
    crits: number;
    nodeUpgrades: Record<string, number>;
    /** 以下为成就/任务条件所需的计数（PHASE 4 批次 B 引入） */
    strainsUsed: number;
    /** 曾经表达过的菌株名单（图鉴与「六种表达」成就的依据） */
    strainCodex: string[];
    /** 累计切换菌株次数 */
    strainSwitchCount: number;
    /** 达到过的最高 Prestige 层级（0 = 尚未孢子化） */
    maxPrestigeLevel: number;
    /** 累计应用法则次数 */
    lawsApplied: number;
    /** 时间银行取出次数 */
    timeBankWithdraws: number;
    /** 自定义催化规则条数 */
    customRulesMade: number;
    /** 事件链：最近一次触发的链标签与连续次数（同一链连续 3 次 → 共生回声） */
    lastChainTag: string | null;
    chainStreak: number;
    /** 共生回声总数 */
    echoesFound: number;
    /**
     * 地表文明对菌毯的敌意（0–100）。
     * 设计目的：让“被地表发现”成为一条真实压力曲线 —— 寄生流派抽得越狠、
     * 敌意涨得越快，围剿事件随之变重；而签契约、进贡可以把它压下去。
     */
    hostility: number;
    genesUnlocked: number;
    /** 无手动操作的连续秒数 */
    idleNoClickSec: number;
    /** 经历过的事件 id */
    eventsSeen: string[];
    contractsSigned: number;
    speciesKnown: number;
    codexEntries: number;
    challengesCompleted: string[];
    /** 单次最长离线小时数 */
    maxOfflineHours: number;
    /** 达到过的最高自动化层级 */
    maxAutoTier: number;
    seasonCycles: number;
    tilesRepaired: number;
    reverseRecipeUsed: boolean;
    /** 已完成任务 id（按顺序） */
    questsCompleted: string[];
  };
  /** 建造/购买带来的图变更标记（拓扑序缓存失效用） */
  topoDirty: boolean;
  /** 玩家自定义的自动化规则（tier 6 规则引擎） */
  autoRules: AutoRule[];
  /** 已完成任务带来的永久加成（由 computeModifiers 统一应用） */
  questBonuses: EffectDef[];
  /** 自动化配置 */
  autoConfig: {
    /** 达到该孢子基因收益时自动孢子化（tier 5） */
    autoPrestigeThreshold: string;
  };
  /** 菌市状态（PHASE 4 批次 B） */
  market: MarketState;
}

export function createNewGame(data: GameData): GameState {
  const resources: Record<string, SciNum> = {};
  const totalProduced: Record<string, SciNum> = {};
  for (const [id, r] of data.resources) {
    const v = data.config.newGame.startingResources[id] !== undefined
      ? SciNum.from(data.config.newGame.startingResources[id]!)
      : r.startAmount;
    resources[id] = v;
    totalProduced[id] = SciNum.ZERO;
  }

  // 菌市：只包含可交易且定义了基准价的资源
  const marketEntries: Record<string, MarketEntry> = {};
  for (const [id, res] of data.resources) {
    if (!res.def.tradeable || res.basePrice === null) continue;
    const p = res.basePrice.toNumber();
    marketEntries[id] = { price: p, basePrice: p, lastTradeAt: -1e9, tradesInWindow: 0 };
  }

  const state: GameState = {
    version: 1,
    tick: 0,
    elapsed: 0,
    resources,
    totalProduced,
    ratePerSec: {},
    graph: new NetworkGraph(),
    seq: { node: 0, link: 0 },
    buildQueue: {},
    unlockedLayers: [],
    upgrades: {},
    techs: {},
    achievements: {},
    activeEvents: [],
    challenges: { runtime: null, completed: {}, failures: 0 },
    laws: [],
    timeBank: { storedSec: 0 },
    customRules: [],
    prestige: { count: 0, level: 0, sporogene: SciNum.ZERO, totalSporogene: SciNum.ZERO, strain: null, roundStartedAt: 0, lastStrainSwitchAt: -1 },
    combo: { stacks: 0, lastActionAt: 0 },
    stats: {
      catalystUses: 0,
      nodesBuilt: 0,
      linksBuilt: 0,
      upgradesBought: 0,
      techsUnlocked: 0,
      crits: 0,
      nodeUpgrades: {},
      strainsUsed: 0,
      strainCodex: [],
      strainSwitchCount: 0,
      maxPrestigeLevel: 0,
      lawsApplied: 0,
      timeBankWithdraws: 0,
      customRulesMade: 0,
      lastChainTag: null,
      chainStreak: 0,
      echoesFound: 0,
      hostility: 0,
      genesUnlocked: 0,
      idleNoClickSec: 0,
      eventsSeen: [],
      contractsSigned: 0,
      speciesKnown: 0,
      codexEntries: 0,
      challengesCompleted: [],
      maxOfflineHours: 0,
      maxAutoTier: 0,
      seasonCycles: 0,
      tilesRepaired: 0,
      reverseRecipeUsed: false,
      questsCompleted: [],
    },
    questBonuses: [],
    topoDirty: true,
    autoRules: [],
    autoConfig: { autoPrestigeThreshold: '10' },
    market: { entries: marketEntries, volume: SciNum.ZERO, lastTick: 0 },
  };

  // 起始层解锁：起始层 + 任何 unlock.type === 'start' 的层
  for (const layer of data.layerOrder) {
    if (layer.unlock.type === 'start' || layer.id === data.config.newGame.startLayer) {
      state.unlockedLayers.push(layer.id);
    }
  }

  // 免费起始节点
  for (const f of data.config.newGame.freeNodes) {
    const def = data.nodes.get(f.node);
    if (!def) throw new Error(`createNewGame: 未知起始节点 ${f.node}`);
    const layer = data.layers.get(f.layer) ?? data.layers.get(def.def.layer)!;
    const inst: NodeInstance = {
      id: `n${state.seq.node++}`,
      typeId: f.node,
      layerId: layer.id,
      x: f.x,
      y: f.y,
      active: true,
      built: true,
      richness: layer.richnessBase,
      rotationSwaps: 0,
    };
    state.graph.addNode(inst);
    state.stats.nodesBuilt++;
  }

  return state;
}

/** 深拷贝状态（模拟器的分支探索用）；SciNum 不可变，图需要逐个复制 */
export function cloneState(state: GameState): GameState {
  const graph = new NetworkGraph();
  for (const n of state.graph.nodes.values()) graph.addNode({ ...n });
  for (const l of state.graph.links.values()) graph.addLink({ ...l });
  return {
    ...state,
    resources: { ...state.resources },
    totalProduced: { ...state.totalProduced },
    ratePerSec: { ...state.ratePerSec },
    graph,
    buildQueue: { ...state.buildQueue },
    unlockedLayers: [...state.unlockedLayers],
    upgrades: { ...state.upgrades },
    techs: { ...state.techs },
    achievements: { ...state.achievements },
    activeEvents: state.activeEvents.map((e) => ({ ...e })),
    prestige: { ...state.prestige },
    combo: { ...state.combo },
    stats: { ...state.stats, nodeUpgrades: { ...state.stats.nodeUpgrades } },
    autoRules: state.autoRules.map((r) => ({ ...r, cond: { ...r.cond }, act: { ...r.act } })),
    autoConfig: { ...state.autoConfig },
    questBonuses: state.questBonuses.map((e) => ({ ...e })),
    market: {
      entries: Object.fromEntries(Object.entries(state.market.entries).map(([k, v]) => [k, { ...v }])),
      volume: state.market.volume,
      lastTick: state.market.lastTick,
    },
  };
}

export type { ModifierDef };
