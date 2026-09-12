/**
 * 核心类型定义 —— 与 data/*.json 的结构一一对应。
 * 数据表是事实来源；此文件只描述形状，不含任何平衡数值。
 */

// ---------------------------------------------------------------- 资源

export interface TierDef {
  id: number;
  name: string;
  nameEn: string;
  color: string;
  desc: string;
}

export interface ChainDef {
  id: string;
  name: string;
  desc: string;
  pace: string;
  risk: string;
}

export interface ResourceDef {
  id: string;
  name: string;
  nameEn: string;
  tier: number;
  hidden: boolean;
  startAmount: string;
  cap: string | null;
  color: string;
  desc: string;
  tradeable: boolean;
  basePrice: string | null;
  /**
   * 供 AI 策略使用的建议保留量（不影响游戏规则）。
   * 孢子是早期唯一不可再生的扩张货币，必须为「孢子囊(25) + 糖化腔(12)」留出预算，
   * 否则策略会把孢子全花在采集节点上，而孢子经济永远无法启动。
   */
  strategicReserve?: string;
  tags: string[];
  chains: string[];
}

export interface ResourceTable {
  tableVersion: number;
  tiers: TierDef[];
  chains: ChainDef[];
  resources: ResourceDef[];
}

// ---------------------------------------------------------------- 节点

export type NodeClass =
  | 'extractor'
  | 'metabolizer'
  | 'sporifier'
  | 'symbiont'
  | 'transmitter'
  | 'special'
  | 'meta';

export interface StructuralEffect {
  linkFluxMul?: number;
  mirrorAdjacent?: number;
}

export interface GlobalEffect {
  allProductionMul?: number;
}

export interface RecipeDef {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  enzymePerSec: string;
  /** 每秒对所在地块富饶度的扣除 */
  depletion: number;
  /** 受昼夜调制的配方（如光合） */
  modulatedBy?: string;
  structural?: StructuralEffect;
  global?: GlobalEffect;
}

export interface UnlockDef {
  type: 'start' | 'resource' | 'layer' | 'tech' | 'prestige' | 'quest';
  resource?: string;
  amount?: string;
  layer?: string;
  level?: number;
  id?: string;
}

export interface NodeDef {
  id: string;
  name: string;
  nameEn: string;
  class: NodeClass;
  catalystTag: string;
  tier: number;
  layer: string;
  cost: Record<string, string>;
  costGrowth: number;
  buildTime: number;
  recipe: RecipeDef;
  unlock: UnlockDef;
  requires?: { connectivity?: number; richness?: number };
  upgradableTo: string | null;
  desc: string;
}

export interface LayerDef {
  id: string;
  name: string;
  nameEn: string;
  order: number;
  richnessBase: number;
  richnessFloor: number;
  nodeCap: number;
  depthMul: string;
  unlock: UnlockDef;
  desc: string;
}

export interface NodeTable {
  tableVersion: number;
  layers: LayerDef[];
  nodes: NodeDef[];
}

// ---------------------------------------------------------------- 催化矩阵

export interface CatalystRule {
  upstreamTag: string;
  downstreamClass: string | '*';
  rateMul: number;
  enzymeDiscount: number;
  stability: number;
  note: string;
}

export interface CatalystTable {
  tableVersion: number;
  evaluation: Record<string, unknown>;
  default: { rateMul: number; enzymeDiscount: number; stability: number; note: string };
  rules: CatalystRule[];
}

// ---------------------------------------------------------------- 升级 / 科技 / 成就

export interface EffectDef {
  kind: string;
  value?: number | string;
  node?: string | null;
  res?: string | null;
  class?: NodeClass | null;
  /** 人类可读的效果说明（UI 展示用；部分数据表条目带它） */
  desc?: string;
}

export interface UpgradeDef {
  id: string;
  name: string;
  cat: 'node' | 'global' | 'mechanic' | 'hidden';
  target: string | null;
  maxLevel: number;
  cost: Record<string, string>;
  growth: number;
  effect: EffectDef;
  desc: string;
}

export interface UpgradeTable {
  tableVersion: number;
  effectKinds: string[];
  upgrades: UpgradeDef[];
}

export interface TechDef {
  id: string;
  name: string;
  branch: string;
  tier: number;
  cost: Record<string, string>;
  requires: string[];
  effect: EffectDef;
  desc: string;
}

export interface TechTable {
  tableVersion: number;
  branches: { id: string; name: string; color: string; desc: string }[];
  techs: TechDef[];
}

export interface ConditionDef {
  kind: string;
  res?: string;
  amount?: string;
  value?: number | string;
}

export interface AchievementDef {
  id: string;
  name: string;
  cat: string;
  cond: ConditionDef;
  hidden: boolean;
  effect: EffectDef | null;
  desc: string;
}

export interface AchievementTable {
  tableVersion: number;
  categories: { id: string; name: string; desc: string }[];
  achievements: AchievementDef[];
}

// ---------------------------------------------------------------- 挑战 / 事件 / 任务

export interface ModifierDef {
  kind: string;
  value?: number | string;
  res?: string;
  amount?: number | string;
  class?: NodeClass;
}

export interface ChallengeDef {
  id: string;
  name: string;
  cat: string;
  modifiers: ModifierDef[];
  goal: ConditionDef;
  /** 奖励走 questBonuses 通道发放（EffectDef 结构） */
  reward: EffectDef;
  desc: string;
}

export interface ChallengeTable {
  tableVersion: number;
  modifierKinds: string[];
  challenges: ChallengeDef[];
}

export interface EventDef {
  id: string;
  name: string;
  kind: 'positive' | 'neutral' | 'negative';
  weight: number;
  duration: number;
  modifiers: ModifierDef[];
  mitigation: string[];
  offline: boolean;
  chainTag: string | null;
  desc: string;
}

export interface EventTable {
  tableVersion: number;
  design: Record<string, unknown>;
  modifierKinds: string[];
  events: EventDef[];
}

export interface QuestDef {
  id: string;
  name: string;
  cat: string;
  goal: ConditionDef & { node?: string; layer?: string; count?: number };
  reward: { kind: string; res?: string; amount?: string; value?: string | number; desc?: string; target?: string };
  requires: string[];
  desc: string;
  /**
   * 玩家卡住时真正需要的那句话：**怎么做**。
   * 起因：引导只写"产出共生核心"，而 core 的前置是 500 酶 → 压机 → 5 晶格 → 核心腔，
   * 中间隔了三个节点和大量资源。desc 负责氛围，hint 负责活下去。
   */
  hint?: string;
}

export interface QuestTable {
  tableVersion: number;
  categories: { id: string; name: string; desc: string }[];
  quests: QuestDef[];
}

// ---------------------------------------------------------------- 全局配置

export interface GameConfig {
  tableVersion: number;
  simulation: {
    tickRateMs: number;
    maxCatchUpTicks: number;
    maxStepsPerFrame: number;
    deterministicSeed: number;
  };
  newGame: {
    startingResources: Record<string, string>;
    freeNodes: { node: string; layer: string; x: number; y: number }[];
    startLayer: string;
    unlockedResources: string[];
  };
  prestige: {
    networkValueBase: string;
    exponent: number;
    softCapMultiplier: number;
    minGain: number;
    strainCooldownHours: number;
    levelThresholds: Record<string, Record<string, string>>;
  };
  market: {
    theta: number;
    sigma: number;
    depthBase: string;
    feeBase: number;
    feeRampPerFastTrade: number;
    feeRampWindowSec: number;
    clampLow: number;
    clampHigh: number;
  };
  timeBank: {
    /** 储存上限（小时） */
    capHours: number;
    /** 每秒把多少秒存进去（0.05 = 存 5% 的时间） */
    depositRatePerSec: number;
    /** 取出时的损耗比例 */
    withdrawLoss: number;
    /** 解锁所需科技 */
    unlockTech: string;
  };
  events: {
    /** 事件平均间隔（秒）；挑战的 eventRateMul 会缩短它 */
    meanIntervalSec: number;
    /** 同时生效的事件上限 */
    maxActive: number;
    perHostility: {
      /** 每 10 点敌意让负面事件权重提升的比例 */
      negWeightMulPer10: number;
      /** 敌意超过该值后开始出现围剿类事件 */
      siegeThreshold: number;
    };
    /** 敌意每秒自然衰减（hostilityNoDecay 挑战会禁用它） */
    neutralDecayPerSec: number;
    /** 签一份契约能降低的敌意 */
    contractRelief: number;
  };
  offline: {
    baseEfficiency: number;
    maxEfficiency: number;
    softCapStartHours: number;
    softCapFullHours: number;
    softCapFloor: number;
    hardCapHours: number;
    maxEventCount: number;
  };
  combo: {
    windowSec: number;
    decaySec: number;
    maxStack: number;
    perStackBonus: number;
    validActions: string[];
  };
  crit: { baseChance: number; baseMultiplier: number };
  soil: {
    richnessMulFloor: number;
    repairBase: number;
    rotationBonusPerSwap: number;
    rotationMaxSwaps: number;
  };
  time: {
    dayLengthSec: number;
    seasonLengthSec: number;
    seasonMultipliers: Record<string, Record<string, number>>;
  };
  automation: {
    tierIntervalSec: Record<string, number>;
    ruleMaxPerTick: number;
    defaultRuleSlots: number;
  };
  antiCheat: {
    maxSingleDeltaSec: number;
    maxOfflineSec: number;
    clockBackToleranceSec: number;
    saveChecksum: string;
  };
  save: { autoSaveIntervalSec: number; slots: number; version: number };
  debug: { assertInvariants: boolean; logNanSource: boolean };
}

// ---------------------------------------------------------------- 原始表集合与索引后的数据

export interface RawTables {
  resources: ResourceTable;
  nodes: NodeTable;
  catalystMatrix: CatalystTable;
  upgrades: UpgradeTable;
  tech: TechTable;
  challenges: ChallengeTable;
  achievements: AchievementTable;
  events: EventTable;
  quests: QuestTable;
  strains: StrainTable;
  laws: LawTable;
  gameConfig: GameConfig;
}

/** 预解析（字符串 → SciNum）后的节点配方 */
export interface ParsedRecipe {
  inputs: { res: string; rate: import('./math/scinum.ts').SciNum }[];
  outputs: { res: string; rate: import('./math/scinum.ts').SciNum }[];
  enzymePerSec: import('./math/scinum.ts').SciNum;
  depletion: number;
  modulatedBy?: string;
  structural?: StructuralEffect;
  global?: GlobalEffect;
}

/** 菌株定义（data/strains.json） */
export interface StrainDef {
  id: string;
  name: string;
  /** 画布/面板上的标识字符 */
  glyph: string;
  /** 色相 0–360 */
  hue: number;
  /** 需要的 Prestige 层级（0 = 开局可选） */
  unlockLevel: number;
  /** 表达成本（消耗的基因片段） */
  geneCost: string;
  tagline: string;
  desc: string;
  /** 人类可读的规则改写清单（UI 展示，也是"菌株必须改规则"的自我约束） */
  ruleChanges: string[];
  effects: EffectDef[];
  drawbacks: EffectDef[];
  /** 需要引擎特殊处理的开关，见 strains.json 的 specialKinds */
  specials: string[];
}

/** 生态法则定义（data/laws.json） */
export interface LawDef {
  id: string;
  name: string;
  desc: string;
  cost: string;
  maxStacks: number;
  /** 是否需要指定目标（如"哪一类资源"） */
  needsTarget: boolean;
  targetKind?: string;
  effect: EffectDef;
}

export interface LawTable {
  tableVersion: number;
  effectKinds: string[];
  laws: LawDef[];
}

export interface ParsedStrain {
  def: StrainDef;
  geneCost: import('./math/scinum.ts').SciNum;
}

export interface StrainTable {
  tableVersion: number;
  specialKinds: string[];
  strains: StrainDef[];
}

export interface ParsedNode {
  def: NodeDef;
  cost: { res: string; amount: import('./math/scinum.ts').SciNum }[];
  recipe: ParsedRecipe;
  buildTime: number;
  costGrowth: number;
}

export interface ParsedResource {
  def: ResourceDef;
  startAmount: import('./math/scinum.ts').SciNum;
  cap: import('./math/scinum.ts').SciNum | null;
  basePrice: import('./math/scinum.ts').SciNum | null;
  strategicReserve: import('./math/scinum.ts').SciNum;
}

export interface ParsedUpgrade {
  def: UpgradeDef;
  cost: { res: string; amount: import('./math/scinum.ts').SciNum }[];
}

export interface ParsedTech {
  def: TechDef;
  cost: { res: string; amount: import('./math/scinum.ts').SciNum }[];
}

/** 索引 + 预解析后的完整数据集（运行时唯一的数据入口） */
export interface GameData {
  raw: RawTables;
  resources: Map<string, ParsedResource>;
  nodes: Map<string, ParsedNode>;
  layers: Map<string, LayerDef>;
  layerOrder: LayerDef[];
  upgrades: Map<string, ParsedUpgrade>;
  techs: Map<string, ParsedTech>;
  strains: Map<string, ParsedStrain>;
  laws: Map<string, LawDef>;
  challenges: Map<string, ChallengeDef>;
  achievements: Map<string, AchievementDef>;
  events: EventDef[];
  quests: Map<string, QuestDef>;
  config: GameConfig;
  /** 催化索引：key = `${catalystTag}>${nodeClass}`，值为命中的规则（含 '*' 回落） */
  catalystIndex: Map<string, CatalystRule>;
  catalystDefault: CatalystRule;
  /** 有效的 effect / modifier 词表（用于运行时告警） */
  effectKinds: Set<string>;
}
