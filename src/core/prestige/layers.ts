/**
 * Prestige 多层结构（P1 孢子化 → P5 星际播种）。
 *
 * 设计区分（这是"多层"与"重复重置"的分界）：
 *   · P1 孢子化是**重置**：焚毁网络换孢子基因，代价是重来一遍；
 *   · P2–P5 是**跃迁**：消耗资源换取新的机制能力，不重置网络。
 *     用"重置"堆层数只会让玩家反复做同一件事；用"跃迁"才能让每一层
 *     真的改变游戏（菌株表达 / 虫巢中心 / 法则改写 / 平行生态）。
 *
 * 门槛来自 game-config.prestige.levelThresholds（数据驱动，且被
 * scripts/validate-data.ts 校验引用的资源真实存在）；
 * 层级名称与解锁内容写在代码里，因为它们与引擎行为强耦合 ——
 * 放进 JSON 只会诱导"改了数据但代码没实现"的不一致。
 */

import { SciNum } from '../math/scinum.ts';
import type { GameData } from '../types.ts';
import type { GameState } from '../state.ts';

export interface LayerMeta {
  level: number;
  id: string;
  name: string;
  tagline: string;
  desc: string;
  /** 达成该层后解锁的能力（人类可读） */
  unlocks: string[];
  /** 该层是否重置网络（只有 P1 是） */
  isReset: boolean;
  /** 达成后进入存档的标记键 */
  flag: string;
}

export const LAYERS: LayerMeta[] = [
  {
    level: 1,
    id: 'p1',
    name: '孢子化',
    tagline: '把自己烧成一把孢子',
    desc: '释放孢子、焚毁整个网络，把这一轮生长的总量换算成孢子基因。这是唯一会重置的层级。',
    unlocks: ['孢子基因（永久加成）', '基因片段产出', '菌株解锁进度'],
    isReset: true,
    flag: 'layer.p1',
  },
  {
    level: 2,
    id: 'p2',
    name: '基因重组',
    tagline: '把基因读成一条法则',
    desc: '把孢子基因与基因片段重组成可表达的菌株 —— 从此你的每一轮都属于某个流派，规则随之改变。',
    unlocks: ['菌株表达与切换', '流派专属规则改写'],
    isReset: false,
    flag: 'layer.p2',
  },
  {
    level: 3,
    id: 'p3',
    name: '虫巢意识',
    tagline: '网络第一次有了中心',
    desc: '菌丝网络涌现出一个中心节点：自动化规则槽 +2，且允许跨区连通 —— 你开始像指挥一个整体那样指挥它。',
    unlocks: ['自动化规则槽 +2', '虫巢枢纽', '跨区连通'],
    isReset: false,
    flag: 'layer.p3',
  },
  {
    level: 4,
    id: 'p4',
    name: '行星共生',
    tagline: '你成了这颗行星的神经',
    desc: '获得改写行星级规则的能力：可以永久修改一条配方转换率、成本曲线或催化规则。',
    unlocks: ['法则改写（每层 +1 槽）', '季节轮转加速'],
    isReset: false,
    flag: 'layer.p4',
  },
  {
    level: 5,
    id: 'p5',
    name: '星际播种',
    tagline: '把菌株射向别的世界',
    desc: '终局：把菌株封装成孢子射向其他星球，开辟一套规则完全不同的平行生态。',
    unlocks: ['平行生态槽', '星尘→法则 的跨生态兑换'],
    isReset: false,
    flag: 'layer.p5',
  },
];

export interface LayerRequirement {
  key: string;
  /** 显示名（孢子基因 / 基因片段 …） */
  label: string;
  need: SciNum;
  have: SciNum;
  ok: boolean;
}

export interface LayerInfo {
  meta: LayerMeta;
  requirements: LayerRequirement[];
  /** 已达成的层 */
  reached: boolean;
  /** 下一个可以推进的层 */
  isNext: boolean;
  /** 门槛是否全部满足 */
  ready: boolean;
  /** 不可推进的原因（可直接显示给玩家） */
  reason: string;
}

/** 读某项门槛的当前持有量：sporogene 在 prestige 上，其余都是资源 */
export function readGate(state: GameState, key: string): SciNum {
  if (key === 'sporogene') return state.prestige.sporogene;
  return state.resources[key] ?? SciNum.ZERO;
}

function spendGate(state: GameState, key: string, amount: SciNum): void {
  if (key === 'sporogene') {
    const after = SciNum.sub(state.prestige.sporogene, amount);
    state.prestige = { ...state.prestige, sporogene: after.isNegative() ? SciNum.ZERO : after };
    return;
  }
  const after = SciNum.sub(state.resources[key] ?? SciNum.ZERO, amount);
  state.resources[key] = after.isNegative() ? SciNum.ZERO : after;
}

/** 资源 id → 玩家可读的名字（找不到就用 id 本身，避免因文案缺失而崩） */
function labelOf(data: GameData, key: string): string {
  if (key === 'sporogene') return '孢子基因';
  return data.resources.get(key)?.def.name ?? key;
}

/**
 * 列出全部层级的当前状态。
 * `state.prestige.level` 表示**已达成**的层数（0 = 还没孢子化过）。
 */
export function listLayers(state: GameState, data: GameData): LayerInfo[] {
  const reachedLevel = state.prestige.level;
  const out: LayerInfo[] = [];

  for (const meta of LAYERS) {
    const raw = data.config.prestige.levelThresholds[meta.id] ?? {};
    const requirements: LayerRequirement[] = Object.entries(raw).map(([key, amount]) => {
      const need = SciNum.from(amount);
      const have = readGate(state, key);
      return { key, label: labelOf(data, key), need, have, ok: SciNum.gte(have, need) };
    });

    const reached = reachedLevel >= meta.level;
    const isNext = meta.level === reachedLevel + 1;
    const ready = requirements.every((r) => r.ok);

    let reason = '';
    if (reached) reason = '已达成';
    else if (!isNext) reason = `需要先达成第 ${meta.level - 1} 层`;
    else if (!ready) {
      const missing = requirements
        .filter((r) => !r.ok)
        .map((r) => `${r.label} ${SciNum.format(r.have)}/${SciNum.format(r.need)}`);
      reason = `还差 ${missing.join('、')}`;
    } else if (meta.isReset) reason = '可以孢子化';
    else reason = '条件已满足，可以跃迁';

    out.push({ meta, requirements, reached, isNext, ready, reason });
  }

  return out;
}

export interface AdvanceResult {
  ok: boolean;
  reason: string;
  /** 成功时返回新状态 */
  state?: GameState;
  /** 达成的层 */
  layer?: LayerMeta;
}

/**
 * 跃迁到下一层（P2–P5）。**不修改传入的 state**，成功时返回新状态。
 *
 * P1 不在此处理：那是一次重置，必须走 doPrestige（它要处理网络焚毁与收益计算）。
 */
export function advanceLayer(state: GameState, data: GameData): AdvanceResult {
  const infos = listLayers(state, data);
  const next = infos.find((i) => i.isNext);

  if (!next) return { ok: false, reason: '已经没有可推进的层级了' };
  if (next.meta.isReset) return { ok: false, reason: '第 1 层是孢子化，请在孢子面板里执行' };
  if (!next.ready) return { ok: false, reason: next.reason };

  const clone = { ...state } as GameState;
  clone.resources = { ...state.resources };
  clone.stats = { ...state.stats };
  clone.prestige = { ...state.prestige };

  // 门槛即成本：达成时消耗掉这些资源，避免"一次囤积连续跳两级"
  for (const r of next.requirements) spendGate(clone, r.key, r.need);

  clone.prestige.level = next.meta.level;
  clone.stats.maxPrestigeLevel = Math.max(state.stats.maxPrestigeLevel ?? 0, next.meta.level);

  return { ok: true, reason: '', state: clone, layer: next.meta };
}

/** 当前已达成的最高层（含未达成的 0） */
export function currentLayer(state: GameState): LayerMeta | null {
  return LAYERS.filter((l) => l.level <= state.prestige.level).pop() ?? null;
}

/** 某层是否已达成（供 UI 与引擎分支判断"机制是否可用"） */
export function hasLayer(state: GameState, level: number): boolean {
  return state.prestige.level >= level;
}
