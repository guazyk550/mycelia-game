/**
 * 合成表（Codex）：从数据表派生「资源 ↔ 节点 ↔ 催化」的双向关系。
 *
 * 为什么要单独派生而不是在 UI 里现算：这是纯数据变换、可单测，
 * 而且"谁产出它 / 谁消耗它 / 和谁能产生催化加成"这三件事散在三张表里
 * （nodes.recipe、nodes.catalystTag/class、catalyst-matrix.rules），
 * 在面板里拼容易写成四不像。
 *
 * 隐藏资源（voidspore / echo）不进入索引 —— 保持"发现感"是本作的设计前提。
 */

import type { SciNum } from '../math/scinum.ts';
import type { GameData } from '../types.ts';

export interface CodexProducer {
  nodeId: string;
  nodeName: string;
  rate: SciNum;
  layer: string;
  tier: number;
  catalystTag: string;
}

export interface CodexConsumer {
  nodeId: string;
  nodeName: string;
  rate: SciNum;
  nodeClass: string;
}

export interface CodexInteraction {
  /** 上游节点的催化标签 */
  tag: string;
  /** 被催化的下游节点类（'*' 表示全类） */
  targetClass: string;
  rateMul: number;
  note: string;
}

export interface CodexEntry {
  resourceId: string;
  name: string;
  tier: number;
  color: string;
  /** 谁产出它 */
  producers: CodexProducer[];
  /** 谁消耗它 */
  consumers: CodexConsumer[];
  /** 产出它的节点作为上游时，能给哪些下游类加成（= 资源参与了哪些催化互动） */
  provides: CodexInteraction[];
  /** 消耗它的节点作为下游时，会被哪些上游标签加成 */
  receives: CodexInteraction[];
}

/** 构建合成表索引（按 Tier 排序；隐藏资源不出现） */
export function buildCodex(data: GameData): CodexEntry[] {
  const entries = new Map<string, CodexEntry>();
  for (const [id, res] of data.resources) {
    if (res.def.hidden) continue;
    entries.set(id, {
      resourceId: id,
      name: res.def.name,
      tier: res.def.tier,
      color: res.def.color,
      producers: [],
      consumers: [],
      provides: [],
      receives: [],
    });
  }

  const rules = data.raw.catalystMatrix.rules;
  const providesSeen = new Map<string, Set<string>>();
  const receivesSeen = new Map<string, Set<string>>();
  const markOnce = (map: Map<string, Set<string>>, resId: string, key: string): boolean => {
    let set = map.get(resId);
    if (!set) {
      set = new Set();
      map.set(resId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    return true;
  };

  for (const node of data.nodes.values()) {
    const tag = node.def.catalystTag;
    const cls = node.def.class;

    for (const out of node.recipe.outputs) {
      const e = entries.get(out.res);
      if (!e) continue;
      e.producers.push({
        nodeId: node.def.id,
        nodeName: node.def.name,
        rate: out.rate,
        layer: node.def.layer,
        tier: node.def.tier,
        catalystTag: tag,
      });
      // 产出该资源的节点，作为上游能给哪些下游类加成
      for (const rule of rules) {
        if (rule.upstreamTag !== tag) continue;
        if (!markOnce(providesSeen, out.res, `${rule.upstreamTag}|${rule.downstreamClass}`)) continue;
        e.provides.push({
          tag: rule.upstreamTag,
          targetClass: rule.downstreamClass,
          rateMul: rule.rateMul,
          note: rule.note,
        });
      }
    }

    for (const inp of node.recipe.inputs) {
      const e = entries.get(inp.res);
      if (!e) continue;
      e.consumers.push({
        nodeId: node.def.id,
        nodeName: node.def.name,
        rate: inp.rate,
        nodeClass: cls,
      });
      // 消耗该资源的节点，作为下游会被哪些上游标签加成
      for (const rule of rules) {
        if (rule.downstreamClass !== cls && rule.downstreamClass !== '*') continue;
        if (!markOnce(receivesSeen, inp.res, `${rule.upstreamTag}|${rule.downstreamClass}`)) continue;
        e.receives.push({
          tag: rule.upstreamTag,
          // 保留矩阵里的原始 downstreamClass：通配规则（'*'）应如实显示为"所有类"，
          // 展开成具体类会让面板宣称一条矩阵里并不存在的规则（被 tests/codex.test.ts 抓到）
          targetClass: rule.downstreamClass,
          rateMul: rule.rateMul,
          note: rule.note,
        });
      }
    }
  }

  return [...entries.values()].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, 'zh'));
}

/** 单条资源的"一句话摘要"，用于面板折叠态 */
export function summarizeEntry(entry: CodexEntry): string {
  const parts: string[] = [];
  if (entry.producers.length > 0) parts.push(`${entry.producers.length} 个来源`);
  if (entry.consumers.length > 0) parts.push(`${entry.consumers.length} 个用途`);
  if (entry.provides.length > 0) parts.push(`${entry.provides.length} 条催化加成`);
  return parts.length > 0 ? parts.join('｜') : '暂无用途（可能是 Meta 资源）';
}
