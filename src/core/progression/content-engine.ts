/**
 * 内容引擎：随机事件 / 成就 / 任务。
 *
 * 三者共用 triggers.ts 的条件求值器，因此数据表里增加新条件类型时不需要碰引擎代码。
 * 所有引擎都是"每 N 秒跑一次"的轻量检查，不进入 tick 热路径。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameState } from '../state.ts';
import type { EffectDef, EventDef, GameData, QuestDef } from '../types.ts';
import { evaluateTrigger, type TriggerContext } from './triggers.ts';
import { challengeEffects } from '../challenges/challenge-engine.ts';
import { lawBonuses } from '../meta/laws.ts';

// ---------------------------------------------------------------- 事件

export interface EventTickResult {
  started: EventDef[];
  ended: string[];
  /** 本次是否因事件链凑满三次而获得了「共生回声」 */
  echoGained?: boolean;
}

/** 事件平均间隔（秒）；负面事件不能决定输赢，所以这个值刻意保守 */
const EVENT_MEAN_INTERVAL_SEC = 180;

export function tickEvents(
  state: GameState,
  data: GameData,
  dtSec: number,
  rng: () => number,
): EventTickResult {
  const result: EventTickResult = { started: [], ended: [] };

  // 1) 过期
  const before = state.activeEvents.length;
  state.activeEvents = state.activeEvents.filter((e) => e.endsAt > state.elapsed);
  if (state.activeEvents.length !== before) result.ended = ['（有事件结束）'];

  // 2) 触发：泊松近似（每步按 dt/均值 的概率判定），并限制同时生效数量
  // 间隔来自配置，且会被挑战的 eventRateMul 改短（"事件更频繁"之类的压力）
  // 事件间隔同时受挑战（变频繁）与法则「静默律」（变稀疏）影响
  const lawCut = lawBonuses(state, data).eventRateCut;
  const interval = Math.max(
    5,
    (data.config.events.meanIntervalSec / Math.max(0.1, challengeEffects(state, data).eventRateMul)) * (1 + lawCut),
  );
  if (state.activeEvents.length >= data.config.events.maxActive) return result;
  const chance = dtSec / interval;
  if (rng() > chance) return result;

  // 敌意越高，负面事件的权重越大（地表记得你做过什么），直到触发围剿
  const hostility = state.stats.hostility ?? 0;
  const negMul = 1 + (hostility / 10) * data.config.events.perHostility.negWeightMulPer10;
  // 过滤掉对当前局面**完全无效**的事件：触发了却什么都没变，比不触发更伤体验。
  // 仍然保留负面事件需要一定规模的门槛。
  const pool = data.events.filter((e) => {
    if (e.kind === 'negative' && state.graph.size() <= 5) return false;
    return eventHasEffect(state, data, e);
  });
  if (pool.length === 0) return result;

  const totalWeight = pool.reduce((sum, e) => sum + e.weight * (e.kind === 'negative' ? negMul : 1), 0);
  let roll = rng() * totalWeight;
  let picked: EventDef | undefined;
  for (const e of pool) {
    roll -= e.weight * (e.kind === 'negative' ? negMul : 1);
    if (roll <= 0) {
      picked = e;
      break;
    }
  }
  if (!picked) return result;

  state.activeEvents.push({
    instanceId: `e${state.activeEvents.length}-${Math.floor(state.elapsed)}`,
    eventId: picked.id,
    startedAt: state.elapsed,
    endsAt: state.elapsed + picked.duration,
    strength: 1,
    isOffline: false,
  });
  if (!state.stats.eventsSeen.includes(picked.id)) state.stats.eventsSeen.push(picked.id);

  // ---- 惊喜机制：稀有事件链。
  // 「当同一串事件连续发生三次，网络会记起曾经发生过的另一条时间线」——
  // 数据表早就这么写了，这里把它变成真的：连续三次同一 chainTag → 共生回声。
  if (picked.chainTag) {
    if (state.stats.lastChainTag === picked.chainTag) state.stats.chainStreak += 1;
    else {
      state.stats.lastChainTag = picked.chainTag;
      state.stats.chainStreak = 1;
    }
    if (state.stats.chainStreak >= 3) {
      state.stats.chainStreak = 0;
      state.stats.lastChainTag = null;
      const echo = state.resources['echo'] ?? SciNum.ZERO;
      state.resources['echo'] = SciNum.add(echo, SciNum.ONE);
      state.stats.echoesFound = (state.stats.echoesFound ?? 0) + 1;
      result.echoGained = true;
    }
  }
  // 立即效果（duration = 0 的事件）与敌意变动：这些不是"持续修饰符"，
  // 必须在这里结算，否则事件只剩一行文字（早期版本就是这样静默丢掉的）
  applyImmediateEvent(state, data, picked, rng);
  result.started.push(picked);
  return result;
}

/**
 * 事件的**立即效果**结算。
 *
 * 这些 kind 不会进入 computeModifiers（它们改变的是"此刻的状态"而非"接下来的倍率"）。
 * 之前它们被 applyEventModifier 的 default 分支静默吞掉，导致数据表里的事件
 * 大多只有文字没有效果 —— 这是 GDD 明令禁止的"静默忽略"。
 */
export function applyImmediateEvent(state: GameState, data: GameData, def: EventDef, rng: () => number): void {
  const cfg = data.config.events;
  for (const mod of def.modifiers) {
    const raw = typeof mod.value === 'number' ? mod.value : 0;
    switch (mod.kind) {
      case 'resourceGain': {
        // “获得当前持有量的 N%”（数据表用 10% 这类比例）
        const res = mod.res ?? '';
        const cur = state.resources[res] ?? SciNum.ZERO;
        if (cur.isPositive()) state.resources[res] = SciNum.add(cur, SciNum.mul(cur, raw / 100));
        break;
      }
      case 'hostilityChange':
        state.stats.hostility = Math.max(0, Math.min(100, (state.stats.hostility ?? 0) + raw));
        break;
      case 'hostilityDecide': {
        // 玩家手里有毒素 → 被当成威胁（敌意上升）；有契约点 → 被当成交易对象（敌意下降）
        const toxin = state.resources['toxin'] ?? SciNum.ZERO;
        const pact = state.resources['pact'] ?? SciNum.ZERO;
        const threat = toxin.isPositive() ? 4 : 0;
        const good = pact.isPositive() ? -6 : 0;
        state.stats.hostility = Math.max(0, Math.min(100, (state.stats.hostility ?? 0) + threat + good));
        break;
      }
      case 'richnessChange':
      case 'richnessShift': {
        for (const node of state.graph.nodes.values()) {
          const layer = data.layers.get(node.layerId);
          if (!layer) continue;
          const delta = (raw / 100) * layer.richnessBase;
          node.richness = Math.max(0, Math.min(layer.richnessBase, node.richness + delta));
        }
        break;
      }
      case 'networkValueLoss': {
        // 网络价值损失表现为“最薄弱的几个节点被震松”：这里退化为小幅产出惩罚
        for (const node of state.graph.nodes.values()) node.richness = Math.max(0, node.richness - raw * 0.01);
        break;
      }
      case 'nodeDown':
      case 'nodeDamage': {
        const nodes = [...state.graph.nodes.values()].filter((n) => n.built);
        if (nodes.length === 0) break;
        const victim = nodes[Math.floor(rng() * nodes.length)]!;
        if (mod.kind === 'nodeDown') victim.active = false;
        else victim.richness = Math.max(0, victim.richness - 10);
        break;
      }
      case 'randomRelinkCount': {
        const links = [...state.graph.links.values()];
        for (let i = 0; i < raw && links.length > 0; i++) {
          const link = links[Math.floor(rng() * links.length)]!;
          const candidates = [...state.graph.nodes.values()].filter((n) => n.id !== link.from && n.id !== link.to);
          if (candidates.length === 0) break;
          const t = candidates[Math.floor(rng() * candidates.length)]!;
          state.graph.links.delete(link.id);
          state.graph.links.set(link.id, { ...link, to: t.id });
        }
        break;
      }
      case 'outputPenaltyRandom': {
        const nodes = [...state.graph.nodes.values()].filter((n) => n.built);
        if (nodes.length === 0) break;
        const victim = nodes[Math.floor(rng() * nodes.length)]!;
        victim.richness = Math.max(0, victim.richness - raw);
        break;
      }
      // 其余 kind（marketShock / marketFeeTemp / instantTechProgress / seasonChange /
      // randomWeather / revealTile / revealHint / tradeWindow / speciesChange /
      // pactTermChange / offerQuest）依赖尚未实现的系统（天气、物种、契约、情报）——
      // 它们会被 scripts/validate-data.ts 与 checkUnimplementedEventKinds() 列为待办，
      // 而不是被当成"已经生效"。
      default:
        break;
    }
  }
  // 敌意自然衰减（hostilityNoDecay 挑战会禁用）
  if (!challengeEffects(state, data).hostilityNoDecay) {
    const decay = cfg.neutralDecayPerSec * 60; // 每次事件结算衰减 60 秒的量，避免每 tick 频繁改动
    state.stats.hostility = Math.max(0, (state.stats.hostility ?? 0) - decay);
  }
}

// ---------------------------------------------------------------- 成就

/** 检查全部成就，返回本次新解锁的 id（效果由 computeModifiers 统一应用） */
export function checkAchievements(state: GameState, data: GameData, ctx: TriggerContext): string[] {
  const unlocked: string[] = [];
  for (const [id, def] of data.achievements) {
    if (state.achievements[id]) continue;
    if (evaluateTrigger(def.cond, state, data, ctx)) {
      state.achievements[id] = true;
      unlocked.push(id);
    }
  }
  return unlocked;
}

// ---------------------------------------------------------------- 任务

export interface QuestCompletion {
  id: string;
  name: string;
  rewardText: string;
}

/** 任务目标（比成就条件多了 buildNode / layer / market 等形态） */
function questGoalMet(goal: QuestDef['goal'], state: GameState, data: GameData, ctx: TriggerContext): boolean {
  switch (goal.kind) {
    case 'buildNode': {
      const target = goal.node ?? '';
      let count = 0;
      for (const n of state.graph.nodes.values()) if (n.typeId === target) count++;
      return count >= (goal.count ?? 1);
    }
    case 'buildAny':
      return state.stats.nodesBuilt >= Number(goal.value ?? 0);
    case 'layer':
      return state.unlockedLayers.includes(goal.layer ?? '');
    case 'upgrades':
      return state.stats.upgradesBought >= Number(goal.value ?? 0);
    case 'techs':
      return Object.keys(state.techs).length >= Number(goal.value ?? 0);
    case 'prestige':
      return state.prestige.count >= Number(goal.value ?? 0);
    case 'prestigeLevel':
      return state.prestige.level >= Number(goal.value ?? 0);
    case 'strainsUsed':
      return state.stats.strainsUsed >= Number(goal.value ?? 0);
    case 'achievements':
      return Object.keys(state.achievements).length >= Number(goal.value ?? 0);
    case 'challengesDone':
      return ctx.challengesDone >= Number(goal.value ?? 0);
    case 'autoTier':
      return state.stats.maxAutoTier >= Number(goal.value ?? 0);
    case 'rules':
      return state.autoRules.filter((r) => r.enabled).length >= Number(goal.value ?? 0);
    case 'seasonCycles':
      return state.stats.seasonCycles >= Number(goal.value ?? 0);
    case 'pactDeliveries':
      return state.stats.contractsSigned >= Number(goal.value ?? 0);
    case 'tilesRepaired':
      return state.stats.tilesRepaired >= Number(goal.value ?? 0);
    case 'contracts':
      return state.stats.contractsSigned >= Number(goal.value ?? 0);
    case 'crits':
      return state.stats.crits >= Number(goal.value ?? 0);
    case 'nodes':
      return state.graph.size() >= Number(goal.value ?? 0);
    case 'links':
      return state.graph.links.size >= Number(goal.value ?? 0);
    case 'combo':
      return ctx.combo >= Number(goal.value ?? 0);
    case 'resource':
      return SciNum.gte(state.totalProduced[goal.res ?? ''] ?? SciNum.ZERO, SciNum.from(goal.amount ?? '0'));
    case 'challenge':
      return state.stats.challengesCompleted.includes(String(goal.value));
    // 尚未接入的系统（菌市/隐藏内容）在对应批次实现前一律判为未完成
    case 'market':
    case 'poorSurvival':
    case 'idleNoClick':
      return goal.kind === 'idleNoClick' ? state.stats.idleNoClickSec >= Number(goal.value ?? 0) : false;
    case 'cycles':
      return state.graph.findCycles().length >= Math.max(1, Number(goal.value ?? 1));
    case 'reverseRecipe':
      return state.stats.reverseRecipeUsed;
    default:
      return false;
  }
}

export function checkQuests(state: GameState, data: GameData, ctx: TriggerContext): QuestCompletion[] {
  const done: QuestCompletion[] = [];
  for (const [id, quest] of data.quests) {
    if (state.stats.questsCompleted.includes(id)) continue;
    if (quest.requires.some((r) => !state.stats.questsCompleted.includes(r))) continue;
    if (!questGoalMet(quest.goal, state, data, ctx)) continue;

    applyQuestReward(state, data, quest);
    state.stats.questsCompleted.push(id);
    done.push({ id, name: quest.name, rewardText: describeQuestReward(quest, data) });
  }
  return done;
}

export function describeQuestReward(quest: QuestDef, data: GameData): string {
  const r = quest.reward;
  const name = (res?: string): string => (res ? (data.resources.get(res)?.def.name ?? res) : '');
  switch (r.kind) {
    case 'resource':
      return `${name(r.res)} +${SciNum.format(SciNum.from(r.amount ?? '0'))}`;
    case 'unlock':
      return r.desc ?? `解锁 ${r.value ?? ''}`;
    case 'outputMul':
      return r.desc ?? `全局产出 +${((Number(r.value) || 0) * 100).toFixed(0)}%`;
    default:
      return r.desc ?? r.kind;
  }
}

/** 奖励发放：资源直接到账，加成类效果写入 questBonuses 由 computeModifiers 统一应用 */
function applyQuestReward(state: GameState, data: GameData, quest: QuestDef): void {
  const r = quest.reward;
  if (r.kind === 'resource' && r.res) {
    const amount = SciNum.from(r.amount ?? '0');
    state.resources[r.res] = SciNum.add(state.resources[r.res] ?? SciNum.ZERO, amount);
    state.totalProduced[r.res] = SciNum.add(state.totalProduced[r.res] ?? SciNum.ZERO, amount);
    return;
  }
  if (r.kind === 'unlock') {
    // 解锁类奖励只记录标记（具体内容在后续批次接入）
    state.questBonuses.push({ kind: 'unlock', value: String(r.value ?? '') });
    return;
  }
  if (r.kind === 'outputMul' || r.kind === 'prestigeGain' || r.kind === 'ruleSlot' || r.kind === 'richnessRepair' || r.kind === 'eventResist' || r.kind === 'critMul' || r.kind === 'offlineEfficiency' || r.kind === 'catalystBonus' || r.kind === 'richnessFloor' || r.kind === 'linkFlux' || r.kind === 'buildCostDiscount' || r.kind === 'resourceCap') {
    const effect: EffectDef = { kind: r.kind, value: typeof r.value === 'number' ? r.value : Number(r.value ?? 0) };
    state.questBonuses.push(effect);
  }
  void data;
}

/**
 * 事件对**当前局面**是否真的有影响。
 *
 * 起因：玩家反馈"每个波动值持续一点点时间，做了跟没做一模一样"。
 * 实测确认了根因 —— 像「孢子云」（孢子产出 +100%）这类事件，在玩家还没有
 * 孢子产出链时触发，效果精确等于 0；「共生共鸣」只加成共生类节点，
 * 而一个还没铺共生体的玩家同样一无所获。事件触发了、提示弹了、什么都没变。
 *
 * 判据：事件的每一条修饰符都必须能作用到**玩家实际拥有的东西**上。
 * 全局型（无 res / class 限定的 outputMul）永远有效；针对性修饰符要检查目标是否存在。
 */
export function eventHasEffect(state: GameState, data: GameData, def: EventDef): boolean {
  for (const m of def.modifiers) {
    switch (m.kind) {
      case 'outputMul': {
        // 针对某资源：该资源必须在产出链上（正在产 或 曾产出过）
        if (m.res) {
          if ((state.ratePerSec[m.res] ?? 0) > 0) return true;
          if (state.totalProduced[m.res]?.isPositive()) return true;
          continue;
        }
        // 针对某节点类：必须真的存在该类节点
        if (m.class) {
          for (const n of state.graph.nodes.values()) {
            if (data.nodes.get(n.typeId)?.def.class === m.class) return true;
          }
          continue;
        }
        // 全局产出：永远有效
        return true;
      }
      case 'richnessChange':
      case 'richnessShift':
      case 'nodeDown':
      case 'nodeDamage':
      case 'outputPenaltyRandom':
      case 'randomRelinkCount':
        return state.graph.size() > 0;
      default:
        // 其余类型（资源直接发放、敌意、市场、科技进度……）不在这里拦截
        return true;
    }
  }
  return false;
}

/** 把事件的效果翻译成一句人话（用于提示文案，让玩家知道它到底改了什么） */
export function describeEventEffect(def: EventDef, data: GameData): string {
  const parts: string[] = [];
  for (const m of def.modifiers) {
    const v = typeof m.value === 'number' ? m.value : 0;
    const sign = v >= 0 ? '+' : '';
    switch (m.kind) {
      case 'outputMul': {
        const scope = m.res
          ? (data.resources.get(m.res)?.def.name ?? m.res)
          : m.class
            ? `${m.class} 类`
            : '全局产出';
        parts.push(`${scope} ${sign}${Math.round(v * 100)}%`);
        break;
      }
      case 'resourceGain':
        parts.push(`立即获得 ${m.res ? (data.resources.get(m.res)?.def.name ?? m.res) : '资源'}`);
        break;
      case 'hostilityChange':
        parts.push(`敌意 ${sign}${v}`);
        break;
      case 'hostilityDecide':
        parts.push('敌意判定（取决于你手里的毒与契约）');
        break;
      case 'richnessChange':
      case 'richnessShift':
        parts.push(`土壤 ${sign}${v}`);
        break;
      case 'nodeDown':
        parts.push('一个节点停摆');
        break;
      case 'nodeDamage':
        parts.push('一个节点受损');
        break;
      case 'randomRelinkCount':
        parts.push(`${v} 条连线被打乱`);
        break;
      case 'outputPenaltyRandom':
        parts.push('随机一个节点减产');
        break;
      default:
        break;
    }
  }
  return parts.length > 0 ? parts.join('，') : '（效果见描述）';
}
