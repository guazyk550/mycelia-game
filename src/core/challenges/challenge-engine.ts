/**
 * 挑战系统 —— 30 条"改写规则"的玩法（GDD §30）。
 *
 * 设计要点：
 *   1. 挑战不是"难度选项"，而是**规则替换**：禁用某个节点类、把配方输入输出对调、
 *      把催化矩阵打乱……完成它，你就真的学会了在没有那条规则的情况下玩。
 *   2. **未实现的 modifier 必须显式报错，绝不静默忽略**（GDD 第二十二条）。
 *      因此本模块维护 IMPLEMENTED 集合，startChallenge 会拒绝含未实现规则的挑战，
 *      并在数据校验阶段把它们全部列出来。
 *   3. 挑战是独立存档分支：开始挑战会先快照当前状态，失败/放弃则回滚 ——
 *      否则"试一下"变成不可逆的赌博，没人敢点。
 */

import { SciNum } from '../math/scinum.ts';
import type { ChallengeDef, GameData, ModifierDef } from '../types.ts';
import type { ChallengeState, GameState } from '../state.ts';
import { createNewGame } from '../state.ts';
import type { ModifierSet } from '../economy/engine.ts';

/** 已被挑战引擎**真正接入**的 modifier kind（其余会显式拒绝，而不是装作生效） */
export const IMPLEMENTED_CHALLENGE_KINDS: ReadonlySet<string> = new Set([
  'richnessCap',
  'richnessFloorLow',
  'banClass',
  'banResource',
  'noLight',
  'nodeCapMax',
  'linkCapMax',
  'outDegreeMax',
  'noAutomation',
  'noOffline',
  'noPrestige',
  'costGrowthAdd',
  'depletionMul',
  'outputPenalty',
  'buildSpeedMul',
  'eventRateMul',
  'marketClosed',
  'layersOnly',
  'resourceZero',
  'resourceTheft',
  'nodeDecay',
  'noCarryover',
  'timeLimitSec',
  'reverseRecipes',
  'randomRelink',
  'matrixShuffle',
  'richnessSimmer',
  // 依赖敌意系统的两项（敌意已在 state.stats.hostility 实装）
  'hostilityNoDecay',
  'toxinSelfDamageMul',
]);

export interface ChallengeProgress {
  id: string;
  def: ChallengeDef;
  /** 当前是否进行中 */
  active: boolean;
  /** 已完成过 */
  completed: boolean;
  /** 目标进度 0–1 */
  progress: number;
  /** 目标描述（人类可读） */
  goalText: string;
  /** 奖励描述 */
  rewardText: string;
  /** 距时限结束还剩秒数（无时限为 null） */
  secondsLeft: number | null;
  /** 含未实现的规则（不允许开始） */
  blocked: boolean;
  blockedReason: string;
}

export function emptyChallengeState(): ChallengeState {
  return { runtime: null, completed: {}, failures: 0 };
}

/** 便捷查询：某条 kind 的数值参数 */
function paramOf(def: ChallengeDef, kind: string): number | undefined {
  const m = def.modifiers.find((x) => x.kind === kind);
  if (!m) return undefined;
  return typeof m.value === 'number' ? m.value : undefined;
}

function paramStr(def: ChallengeDef, kind: string): string | undefined {
  const m = def.modifiers.find((x) => x.kind === kind);
  if (!m) return undefined;
  return typeof m.value === 'string' ? m.value : undefined;
}

// ---------------------------------------------------------------- 校验

/** 挑战里出现但引擎未接入的 kind（数据校验与 UI 都用它） */
export function unimplementedKinds(def: ChallengeDef): string[] {
  return [...new Set(def.modifiers.map((m: ModifierDef) => m.kind))].filter(
    (k) => !IMPLEMENTED_CHALLENGE_KINDS.has(k),
  );
}

// ---------------------------------------------------------------- 开始 / 放弃

export interface StartResult {
  ok: boolean;
  reason: string;
  challenge?: ChallengeState;
}

/**
 * 开始挑战。**不修改传入的 state**。
 * 会重置到一个干净的开局（挑战必须是可比的），并保存快照以便放弃时回滚。
 */
export function startChallenge(state: GameState, data: GameData, challengeId: string): StartResult {
  const def = data.challenges.get(challengeId);
  if (!def) return { ok: false, reason: `未知挑战：${challengeId}` };

  const missing = unimplementedKinds(def);
  if (missing.length > 0) {
    return { ok: false, reason: `该挑战使用了尚未接入的规则：${missing.join('、')}` };
  }

  const cs = state.challenges ?? emptyChallengeState();
  if (cs.runtime && !cs.runtime.done) return { ok: false, reason: '已经有一条挑战在进行中' };
  if (cs.completed[challengeId]) return { ok: false, reason: '这条挑战已经完成过（奖励是永久的）' };

  // 挑战从干净开局起算：否则玩家可以带着巨量资源开始，"限制"就失去意义
  const fresh = createNewGame(data);
  fresh.elapsed = state.elapsed;
  fresh.tick = state.tick;
  fresh.stats = { ...state.stats, hostility: 0 };
  fresh.achievements = { ...state.achievements };
  fresh.techs = { ...state.techs };
  fresh.upgrades = { ...state.upgrades };
  fresh.prestige = { ...state.prestige };
  // 挑战期间不保留旧网络与旧资源（fresh 已经是干净开局）
  fresh.challenges = { ...cs, runtime: null };
  fresh.challenges.runtime = {
    id: challengeId,
    startedAt: state.elapsed,
    snapshot: snapshotOf(state),
    seed: 0x9e3779b9 ^ (challengeId.length << 8) ^ Math.floor(state.elapsed),
    relinked: 0,
    shuffled: 0,
    stolen: SciNum.ZERO,
    done: false,
  };

  return { ok: true, reason: '', challenge: fresh.challenges };
}

/** 轻量快照：只保留回滚需要的东西（全量深拷贝会拖慢开始挑战的手感） */
function snapshotOf(state: GameState): GameState {
  return {
    ...state,
    resources: { ...state.resources },
    totalProduced: { ...state.totalProduced },
    ratePerSec: { ...state.ratePerSec },
    upgrades: { ...state.upgrades },
    buildQueue: { ...state.buildQueue },
    unlockedLayers: [...state.unlockedLayers],
    stats: { ...state.stats },
  };
}

export interface AbandonResult {
  ok: boolean;
  reason: string;
  state?: GameState;
}

/** 放弃挑战：回滚到开始前的快照，并记录一次失败 */
export function abandonChallenge(state: GameState, data: GameData): AbandonResult {
  void data;
  const cs = state.challenges ?? emptyChallengeState();
  if (!cs.runtime || cs.runtime.done) return { ok: false, reason: '当前没有进行中的挑战' };

  const back = cs.runtime.snapshot;
  if (!back) {
    // 回滚点只存在内存中：挑战期间关掉游戏后就没有了。
    // 此时诚实地退回干净开局，而不是假装已经把进度还给你。
    const fresh = createNewGame(data);
    return {
      ok: true,
      reason: '回滚点已丢失（挑战期间关闭过游戏），已退回干净开局',
      state: { ...fresh, challenges: { ...cs, runtime: null, failures: cs.failures + 1 } },
    };
  }
  const next: GameState = {
    ...back,
    challenges: { ...cs, runtime: null, failures: cs.failures + 1 },
  };
  return { ok: true, reason: '', state: next };
}

// ---------------------------------------------------------------- 目标与结算

/** 目标是否达成 */
export function challengeGoalMet(state: GameState, data: GameData): boolean {
  const cs = state.challenges;
  if (!cs?.runtime || cs.runtime.done) return false;
  const def = data.challenges.get(cs.runtime.id);
  if (!def) return false;

  const goal = def.goal;
  switch (goal.kind) {
    case 'resource': {
      const res = goal.res ?? '';
      const need = SciNum.from(goal.amount ?? '0');
      const have = res === 'sporogene' ? state.prestige.sporogene : state.resources[res] ?? SciNum.ZERO;
      return SciNum.gte(have, need);
    }
    // 注意：这里用数据表真实的 kind 名（resource / nodes / time / prestige），
    // 而不是自造一套命名 —— 早期版本写成 nodesBuilt/prestigeLevel，结果
    // ch_mirror_paradox / ch_locust / ch_second_life 等 5 条挑战的目标永远无法达成。
    case 'nodes':
      return state.graph.size() >= Number(goal.value ?? 1);
    case 'time': {
      // 存活满 N 秒（从挑战开始算）
      const rt = cs.runtime;
      return !!rt && state.elapsed - rt.startedAt >= Number(goal.value ?? 0);
    }
    case 'prestige':
      return state.prestige.level >= Number(goal.value ?? 1);
    case 'nodesBuilt':
      return state.stats.nodesBuilt >= Number(goal.value ?? 1);
    case 'prestigeLevel':
      return state.prestige.level >= Number(goal.value ?? 1);
    case 'achievements':
      return Object.keys(state.achievements).length >= Number(goal.value ?? 1);
    default:
      // 未实现的判定形态同样是显式失败，而不是"永远不达成"
      return false;
  }
}

export interface SettleResult {
  ok: boolean;
  reason: string;
  state?: GameState;
  challenge?: ChallengeDef;
  rewardText?: string;
}

/**
 * 结算挑战：发奖（永久效果）并清掉运行时。
 * 时限类挑战超时会走这里失败分支。
 */
export function settleChallenge(state: GameState, data: GameData, timedOut = false): SettleResult {
  const cs = state.challenges ?? emptyChallengeState();
  if (!cs.runtime || cs.runtime.done) return { ok: false, reason: '当前没有进行中的挑战' };
  const def = data.challenges.get(cs.runtime.id);
  if (!def) return { ok: false, reason: '挑战定义丢失' };

  if (timedOut) {
    const back = cs.runtime.snapshot;
    if (!back) {
      const fresh = createNewGame(data);
      return {
        ok: false,
        reason: `超时失败：${def.name}`,
        state: { ...fresh, challenges: { ...cs, runtime: null, failures: cs.failures + 1 } },
      };
    }
    return {
      ok: false,
      reason: `超时失败：${def.name}`,
      state: { ...back, challenges: { ...cs, runtime: null, failures: cs.failures + 1 } },
    };
  }

  if (!challengeGoalMet(state, data)) return { ok: false, reason: '目标尚未达成' };

  // 奖励通过 questBonuses 通道发放：它与升级/科技走同一套 applyEffect，
  // 因此"奖励真的生效"由既有的 computeModifiers 保证，不需要新机制。
  const next: GameState = { ...state };
  next.challenges = {
    ...cs,
    runtime: null,
    completed: { ...cs.completed, [def.id]: true },
  };
  // grantResource 是"直接发放"型奖励（隐藏奖励常见形态）：它不进永久加成通道，
  // 而是当场把资源加到背包里 —— 否则"获得虚空孢子"这种奖励会变成一句空话。
  if (def.reward.kind === 'grantResource') {
    const res = def.reward.res ?? '';
    const amount = SciNum.from(String(def.reward.value ?? 1));
    if (res && data.resources.has(res)) {
      next.resources = { ...next.resources };
      next.resources[res] = SciNum.add(next.resources[res] ?? SciNum.ZERO, amount);
    }
  } else {
    next.questBonuses = [...state.questBonuses, def.reward];
  }
  if (def.reward.kind === 'unlock' && typeof def.reward.value === 'string') {
    next.stats = { ...state.stats, challengesCompleted: [...state.stats.challengesCompleted, def.id] };
  } else {
    next.stats = { ...state.stats, challengesCompleted: [...state.stats.challengesCompleted, def.id] };
  }

  return { ok: true, reason: '', state: next, challenge: def, rewardText: def.reward.desc };
}

// ---------------------------------------------------------------- 进度

export function listChallenges(state: GameState, data: GameData): ChallengeProgress[] {
  const cs = state.challenges ?? emptyChallengeState();
  const out: ChallengeProgress[] = [];

  for (const [id, def] of data.challenges) {
    const active = cs.runtime?.id === id && !cs.runtime.done;
    const completed = !!cs.completed[id];
    const missing = unimplementedKinds(def);

    let progress = 0;
    if (active) {
      const goal = def.goal;
      if (goal.kind === 'resource') {
        const res = goal.res ?? '';
        const need = SciNum.from(goal.amount ?? '0');
        const have = res === 'sporogene' ? state.prestige.sporogene : state.resources[res] ?? SciNum.ZERO;
        progress = need.isZero() ? 1 : Math.min(1, SciNum.div(have, need).toNumber());
      }
    } else if (completed) {
      progress = 1;
    }

    const limit = active ? paramOf(def, 'timeLimitSec') : undefined;
    const secondsLeft =
      limit !== undefined && cs.runtime ? Math.max(0, limit - (state.elapsed - cs.runtime.startedAt)) : null;

    out.push({
      id,
      def,
      active,
      completed,
      progress: Number.isFinite(progress) ? progress : 0,
      goalText: describeGoal(def),
      rewardText: def.reward.desc ?? def.reward.kind,
      secondsLeft,
      blocked: missing.length > 0,
      blockedReason: missing.length > 0 ? `尚未接入：${missing.join('、')}` : '',
    });
  }

  // 进行中的排最前，其次未完成，最后已完成
  return out.sort((a, b) => Number(b.active) - Number(a.active) || Number(a.completed) - Number(b.completed));
}

export function describeGoal(def: ChallengeDef): string {
  const g = def.goal;
  switch (g.kind) {
    case 'resource': {
      const name = g.res === 'sporogene' ? '孢子基因' : g.res ?? '?';
      return `累计持有 ${name} ≥ ${SciNum.format(SciNum.from(g.amount ?? '0'))}`;
    }
    case 'nodes':
      return `同时拥有 ${g.value ?? 1} 个节点`;
    case 'time': {
      const v = Number(g.value ?? 0);
      return `在挑战中存活 ${Math.floor(v / 60)} 分 ${v % 60} 秒`;
    }
    case 'prestige':
      return `达到第 ${g.value ?? 1} 层`;
    case 'prestigeLevel':
      return `达到第 ${g.value ?? 1} 层`;
    case 'nodesBuilt':
      return `累计建造 ${g.value ?? 1} 个节点`;
    case 'achievements':
      return `解锁 ${g.value ?? 1} 个成就`;
    default:
      return `目标：${g.kind}`;
  }
}

// ---------------------------------------------------------------- 挑战对游戏的作用

/**
 * 挑战对本次 tick / 建造 / 系统的全部影响。
 * 各系统只查询自己关心的字段，避免把挑战逻辑散落到引擎各处。
 */
export interface ChallengeEffects {
  activeId: string | null;
  def: ChallengeDef | null;
  banClasses: Set<string>;
  banResources: Set<string>;
  /** 禁止建造的层（layersOnly 时只有这些层可用） */
  allowedLayers: Set<string> | null;
  nodeCapMax: number | null;
  linkCapMax: number | null;
  outDegreeMax: number | null;
  noAutomation: boolean;
  noOffline: boolean;
  noPrestige: boolean;
  marketClosed: boolean;
  reverseRecipes: boolean;
  noCarryover: boolean;
  hostilityNoDecay: boolean;
  richnessSimmer: boolean;
  nodeDecayPerSec: number;
  theftChancePerSec: number;
  relinkEverySec: number | null;
  shuffleEverySec: number | null;
  richnessCapMul: number | null;
  richnessFloorMul: number | null;
  eventRateMul: number;
  toxinSelfDamageMul: number;
  timeLimitSec: number | null;
  /** 成本增长率加值（来自 costGrowthAdd） */
  costGrowthAdd: number;
  /** 建造速度倍率（来自 buildSpeedMul，1 = 不变） */
  buildSpeedMul: number;
  /** 逐资源产出惩罚（来自 outputPenalty） */
  outputPenalties: { res: string; amount: number }[];
  /** 土壤损伤倍率（来自 depletionMul） */
  depletionMul: number;
}

export function challengeEffects(state: GameState, data: GameData): ChallengeEffects {
  const base: ChallengeEffects = {
    activeId: null,
    def: null,
    banClasses: new Set(),
    banResources: new Set(),
    allowedLayers: null,
    nodeCapMax: null,
    linkCapMax: null,
    outDegreeMax: null,
    noAutomation: false,
    noOffline: false,
    noPrestige: false,
    marketClosed: false,
    reverseRecipes: false,
    noCarryover: false,
    hostilityNoDecay: false,
    richnessSimmer: false,
    nodeDecayPerSec: 0,
    theftChancePerSec: 0,
    relinkEverySec: null,
    shuffleEverySec: null,
    richnessCapMul: null,
    richnessFloorMul: null,
    eventRateMul: 1,
    toxinSelfDamageMul: 1,
    timeLimitSec: null,
    costGrowthAdd: 0,
    buildSpeedMul: 1,
    outputPenalties: [],
    depletionMul: 1,
  };

  const cs = state.challenges;
  if (!cs?.runtime || cs.runtime.done) return base;
  const def = data.challenges.get(cs.runtime.id);
  if (!def) return base;

  base.activeId = def.id;
  base.def = def;

  for (const m of def.modifiers) {
    const v = typeof m.value === 'number' ? m.value : 0;
    switch (m.kind) {
      case 'banClass':
        if (typeof m.value === 'string') base.banClasses.add(m.value);
        break;
      case 'banResource':
        if (typeof m.value === 'string') base.banResources.add(m.value);
        break;
      case 'noLight':
        base.banResources.add('light');
        break;
      case 'layersOnly':
        if (typeof m.value === 'string') base.allowedLayers = new Set([m.value]);
        break;
      case 'nodeCapMax':
        base.nodeCapMax = v;
        break;
      case 'linkCapMax':
        base.linkCapMax = v;
        break;
      case 'outDegreeMax':
        base.outDegreeMax = v;
        break;
      case 'noAutomation':
        base.noAutomation = true;
        break;
      case 'noOffline':
        base.noOffline = true;
        break;
      case 'noPrestige':
        base.noPrestige = true;
        break;
      case 'marketClosed':
        base.marketClosed = true;
        break;
      case 'reverseRecipes':
        base.reverseRecipes = true;
        break;
      case 'noCarryover':
        base.noCarryover = true;
        break;
      case 'hostilityNoDecay':
        base.hostilityNoDecay = true;
        break;
      case 'richnessSimmer':
        base.richnessSimmer = true;
        break;
      case 'resourceZero':
        if (typeof m.value === 'string') base.banResources.add(m.value);
        break;
      case 'nodeDecay':
        base.nodeDecayPerSec = v / 100;
        break;
      case 'resourceTheft':
        base.theftChancePerSec = v / 100;
        break;
      case 'randomRelink':
        base.relinkEverySec = v;
        break;
      case 'matrixShuffle':
        base.shuffleEverySec = v;
        break;
      case 'richnessCap':
        base.richnessCapMul = v / 100;
        break;
      case 'richnessFloorLow':
        base.richnessFloorMul = v / 100;
        break;
      case 'eventRateMul':
        base.eventRateMul = v;
        break;
      case 'toxinSelfDamageMul':
        base.toxinSelfDamageMul = v;
        break;
      case 'timeLimitSec':
        base.timeLimitSec = v;
        break;
      case 'costGrowthAdd':
        base.costGrowthAdd += v;
        break;
      case 'buildSpeedMul':
        base.buildSpeedMul = v;
        break;
      case 'outputPenalty':
        if (typeof m.res === 'string') base.outputPenalties.push({ res: m.res, amount: v });
        break;
      case 'depletionMul':
        base.depletionMul = v;
        break;
      default:
        // IMPLEMENTED 集合已在 startChallenge 拦截，这里只是兜底
        break;
    }
  }

  return base;
}

/** 挑战是否已超时（时限类） */
export function challengeTimedOut(state: GameState, data: GameData): boolean {
  const fx = challengeEffects(state, data);
  if (fx.timeLimitSec === null) return false;
  const cs = state.challenges;
  if (!cs?.runtime) return false;
  return state.elapsed - cs.runtime.startedAt >= fx.timeLimitSec;
}

/** 把挑战的"修饰符类"效果合并进 ModifierSet（引擎在 computeModifiers 末尾调用） */
export function applyChallengeModifiers(state: GameState, data: GameData, m: ModifierSet): void {
  const fx = challengeEffects(state, data);
  if (!fx.activeId || !fx.def) return;

  // 直接映射到修饰符的几项（统一从 fx 读，避免与 challengeEffects 的解析逻辑漂移）
  if (fx.depletionMul !== 1) m.depletionMul += fx.depletionMul - 1;
  if (fx.costGrowthAdd !== 0) m.costGrowthAdd += fx.costGrowthAdd;
  if (fx.buildSpeedMul !== 1) m.buildSpeed -= fx.buildSpeedMul - 1;
  for (const p of fx.outputPenalties) m.byRes[p.res] = (m.byRes[p.res] ?? 0) - p.amount;

  // 禁产资源（resourceZero / banResource）：把该资源产出压到 0
  for (const res of fx.banResources) m.byRes[res] = -(1 + (m.byRes[res] ?? 0));
}

/** 建造检查：返回不可建造的原因（空串 = 可以建） */
export function challengeBlocksBuild(
  state: GameState,
  data: GameData,
  typeId: string,
  nodeClass: string,
  layerId: string,
): string {
  const fx = challengeEffects(state, data);
  if (!fx.activeId) return '';
  if (fx.banClasses.has(nodeClass)) return `挑战「${fx.def?.name}」禁止建造 ${nodeClass} 类节点`;
  if (fx.allowedLayers && !fx.allowedLayers.has(layerId)) return `挑战只允许在 ${[...fx.allowedLayers].join('/')} 层建造`;
  if (fx.nodeCapMax !== null && state.graph.size() >= fx.nodeCapMax) return `挑战限制节点总数 ≤ ${fx.nodeCapMax}`;
  void typeId;
  return '';
}

/** 连线检查：返回不可连线的原因（空串 = 可以连） */
export function challengeBlocksLink(state: GameState, data: GameData, fromId: string): string {
  const fx = challengeEffects(state, data);
  if (!fx.activeId) return '';
  if (fx.linkCapMax !== null && state.graph.links.size >= fx.linkCapMax) return `挑战限制连线总数 ≤ ${fx.linkCapMax}`;
  if (fx.outDegreeMax !== null) {
    let out = 0;
    for (const l of state.graph.links.values()) if (l.from === fromId) out++;
    if (out >= fx.outDegreeMax) return `挑战限制每个节点出度 ≤ ${fx.outDegreeMax}`;
  }
  return '';
}
