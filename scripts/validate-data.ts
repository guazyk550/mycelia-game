#!/usr/bin/env node
/**
 * 数据表校验器 — PHASE 1 验收入口
 *
 * 用法：node scripts/validate-data.ts   （或 npm run check:data）
 * 退出码：0 = 全部通过；1 = 存在 error
 *
 * 校验维度：
 *   1. schema  —— 必需字段与类型
 *   2. 引用完整性 —— 资源 / 节点 / 层 / 科技 / 挑战 / 任务 / 升级
 *   3. 词表一致 —— effect.kind、modifier.kind 必须已声明
 *   4. 数量达标 —— 设计文档第四十二条的最低内容量
 *   5. 配方图  —— 非单链判据（度数、纯链节、环）
 *   6. 平衡健康 —— 成本增长率不得快于其产出加成
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.MYCELIA_DATA
  ? join(process.cwd(), process.env.MYCELIA_DATA)
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

type Issue = { level: 'error' | 'warn'; where: string; msg: string };
const issues: Issue[] = [];
const err = (where: string, msg: string): void => void issues.push({ level: 'error', where, msg });
const warn = (where: string, msg: string): void => void issues.push({ level: 'warn', where, msg });

function load<T = any>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;
  } catch (e) {
    err(file, `解析失败: ${(e as Error).message}`);
    return null;
  }
}

/** 声明词表："a — 说明" 形式 */
const declared = (list: string[] | undefined): Set<string> =>
  new Set((list ?? []).map((s) => s.split(' — ')[0]!.trim()));

// ---------------------------------------------------------------- 载入数据

const R = load('resources.json');
const N = load('nodes.json');
const M = load('catalyst-matrix.json');
const U = load('upgrades.json');
const T = load('tech.json');
const C = load('challenges.json');
const A = load('achievements.json');
const E = load('events.json');
const Q = load('quests.json');
const G = load('game-config.json');
const ST = load('strains.json');
const LW = load('laws.json');

if (!R || !N || !M || !U || !T || !C || !A || !E || !Q || !G || !ST || !LW) {
  report();
  process.exit(1);
}

const resIds = new Set<string>(R.resources.map((r: any) => r.id));
const nodeIds = new Set<string>(N.nodes.map((n: any) => n.id));
const layerIds = new Set<string>(N.layers.map((l: any) => l.id));
const chainIds = new Set<string>(R.chains.map((c: any) => c.id));
const classes = new Set<string>(N.nodes.map((n: any) => n.class));
const tags = new Set<string>(N.nodes.map((n: any) => n.catalystTag));
const techIds = new Set<string>(T.techs.map((t: any) => t.id));
const challIds = new Set<string>(C.challenges.map((c: any) => c.id));
const questIds = new Set<string>(Q.quests.map((q: any) => q.id));
const upIds = new Set<string>(U.upgrades.map((u: any) => u.id));

const refRes = (where: string, id: unknown): void => {
  if (typeof id !== 'string' || !resIds.has(id)) err(where, `未知资源引用: ${String(id)}`);
};
const refNode = (where: string, id: unknown): void => {
  if (typeof id !== 'string' || !nodeIds.has(id)) err(where, `未知节点引用: ${String(id)}`);
};

// ---------------------------------------------------------------- 1. 资源表

function checkResources(): void {
  const seen = new Set<string>();
  for (const r of R!.resources as any[]) {
    const w = `resources:${r.id}`;
    if (!r.id) err(w, '缺少 id');
    if (seen.has(r.id)) err(w, 'id 重复');
    seen.add(r.id);
    if (typeof r.tier !== 'number' || r.tier < 0 || r.tier >= R!.tiers.length)
      err(w, `tier 越界: ${r.tier}`);
    if (r.tradeable === true && (r.basePrice === null || r.basePrice === undefined))
      err(w, '可交易资源必须有 basePrice');
    for (const c of r.chains ?? []) if (!chainIds.has(c)) err(w, `未知生产链: ${c}`);
    if ((r.chains ?? []).length === 0) err(w, '未归入任何生产链');
    if (typeof r.startAmount !== 'string') err(w, 'startAmount 必须是字符串（SciNum 格式）');
  }
  // 每个 tier 至少一个资源
  for (const t of R!.tiers as any[]) {
    if (!(R!.resources as any[]).some((r) => r.tier === t.id))
      warn('resources', `tier ${t.id} (${t.name}) 没有任何资源`);
  }
}

// ---------------------------------------------------------------- 2. 节点表

function checkNodes(): void {
  const seen = new Set<string>();
  for (const n of N!.nodes as any[]) {
    const w = `nodes:${n.id}`;
    if (seen.has(n.id)) err(w, 'id 重复');
    seen.add(n.id);
    if (!layerIds.has(n.layer)) err(w, `未知基质层: ${n.layer}`);
    if (!n.class) err(w, '缺少 class');
    if (!n.catalystTag) err(w, '缺少 catalystTag');
    if (n.upgradableTo && !nodeIds.has(n.upgradableTo)) err(w, `未知升级目标: ${n.upgradableTo}`);
    if (typeof n.costGrowth !== 'number' || n.costGrowth < 1) err(w, 'costGrowth 必须 ≥ 1');
    for (const k of Object.keys(n.cost ?? {})) refRes(w, k);
    for (const k of Object.keys(n.recipe?.inputs ?? {})) refRes(w, k);
    for (const k of Object.keys(n.recipe?.outputs ?? {})) refRes(w, k);
    const u = n.unlock ?? {};
    if (u.type === 'layer' && !layerIds.has(u.layer)) err(w, `未知解锁层: ${u.layer}`);
    if (u.type === 'resource') refRes(w, u.resource);
    // 产出合法性：Prestige / Meta 资源不能由普通节点产出
    for (const k of Object.keys(n.recipe?.outputs ?? {})) {
      const res = (R!.resources as any[]).find((r) => r.id === k);
      if (res && (res.tier >= 4 || res.hidden === true) && !k.startsWith('star') && !k.startsWith('law'))
        err(w, `产出了受保护资源: ${k}（Prestige/隐藏资源只能由专属机制产出）`);
    }
    // 有输入配方必须有输出（结构节点除外）
    const ins = Object.keys(n.recipe?.inputs ?? {}).length;
    const outs = Object.keys(n.recipe?.outputs ?? {}).length;
    const structural = n.recipe?.structural !== undefined || n.recipe?.global !== undefined;
    if (ins > 0 && outs === 0 && !structural)
      warn(w, '有输入但没有输出，也不是结构节点');
  }
  for (const l of N!.layers as any[]) {
    const w = `layers:${l.id}`;
    if (l.unlock?.type === 'resource') refRes(w, l.unlock.resource);
  }
}

// ---------------------------------------------------------------- 3. 催化矩阵

function checkMatrix(): void {
  for (const r of M!.rules as any[]) {
    const w = `matrix:${r.upstreamTag}->${r.downstreamClass}`;
    if (r.upstreamTag !== '*' && !tags.has(r.upstreamTag)) err(w, `未知 upstreamTag: ${r.upstreamTag}`);
    if (r.downstreamClass !== '*' && !classes.has(r.downstreamClass))
      err(w, `未知 downstreamClass: ${r.downstreamClass}`);
    if (typeof r.rateMul !== 'number' || r.rateMul <= 0) err(w, 'rateMul 必须 > 0');
    if (!r.note) warn(w, '缺少 UI 说明文本（note）');
  }
  const covered = new Set((M!.rules as any[]).map((r) => r.upstreamTag));
  for (const t of tags) if (!covered.has(t)) warn('matrix', `catalystTag「${t}」没有任何催化规则`);
}

// ---------------------------------------------------------------- 4. 升级表

function checkUpgrades(): void {
  const kinds = declared(U!.effectKinds);
  const seen = new Set<string>();
  for (const u of U!.upgrades as any[]) {
    const w = `upgrades:${u.id}`;
    if (seen.has(u.id)) err(w, 'id 重复');
    seen.add(u.id);
    if (!['node', 'global', 'mechanic', 'hidden'].includes(u.cat)) err(w, `未知类别: ${u.cat}`);
    if (typeof u.maxLevel !== 'number' || u.maxLevel < 1) err(w, 'maxLevel 必须 ≥ 1');
    if (typeof u.growth !== 'number' || u.growth < 1) err(w, 'growth 必须 ≥ 1');
    if (!u.desc) err(w, '缺少 desc（设计规则要求每个升级说明其作用）');
    for (const k of Object.keys(u.cost ?? {})) refRes(w, k);
    if (u.target) refNode(`${w} target`, u.target);
    const e = u.effect ?? {};
    if (!kinds.has(e.kind)) err(w, `未声明的 effect.kind: ${e.kind}`);
    if (e.node) refNode(`${w} effect.node`, e.node);
    if (e.res) refRes(`${w} effect.res`, e.res);
    if (e.class && !classes.has(e.class)) err(w, `未知 effect.class: ${e.class}`);
    // 平衡健康：单节点产出型升级的加成必须快于成本增长（全局/科技型升级不适用此口径）
    if (e.kind === 'outputMul' && typeof e.value === 'number' && u.maxLevel > 1 && u.cat === 'node' && u.target) {
      if (e.value <= u.growth - 1)
        err(w, `产出加成 ${e.value} 追不上成本增长 ${u.growth}（会出现越买越穷的死路）`);
    }
  }
  const byCat: Record<string, number> = {};
  for (const u of U!.upgrades as any[]) byCat[u.cat] = (byCat[u.cat] ?? 0) + 1;
  const min: Record<string, number> = { node: 40, global: 30, mechanic: 20, hidden: 10 };
  for (const [k, v] of Object.entries(min))
    if ((byCat[k] ?? 0) < v) err('upgrades', `${k} 类数量 ${byCat[k] ?? 0} < 要求 ${v}`);
}

// ---------------------------------------------------------------- 5. 科技树

function checkTech(): void {
  const kinds = declared(U!.effectKinds);
  const branches = new Set<string>(T!.branches.map((b: any) => b.id));
  const seen = new Set<string>();
  for (const t of T!.techs as any[]) {
    const w = `tech:${t.id}`;
    if (seen.has(t.id)) err(w, 'id 重复');
    seen.add(t.id);
    if (!branches.has(t.branch)) err(w, `未知分支: ${t.branch}`);
    for (const k of Object.keys(t.cost ?? {})) refRes(w, k);
    for (const r of t.requires ?? []) if (!techIds.has(r)) err(w, `未知前置科技: ${r}`);
    const e = t.effect ?? {};
    if (!kinds.has(e.kind)) err(w, `未声明的 effect.kind: ${e.kind}`);
    if (e.node) refNode(`${w} effect.node`, e.node);
    if (e.res) refRes(`${w} effect.res`, e.res);
  }
  // 科技依赖图不能有环
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      err('tech', `存在循环前置: ${[...path, id].join(' -> ')}`);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    const node = (T!.techs as any[]).find((t) => t.id === id);
    for (const r of node?.requires ?? []) visit(r, [...path, id]);
    state.set(id, 2);
  };
  for (const t of T!.techs as any[]) visit(t.id, []);
  // 每分支数量
  const per: Record<string, number> = {};
  for (const t of T!.techs as any[]) per[t.branch] = (per[t.branch] ?? 0) + 1;
  for (const [b, c] of Object.entries(per))
    if (c < 12) warn('tech', `分支 ${b} 只有 ${c} 个科技（设计目标 ≥ 12）`);
}

// ---------------------------------------------------------------- 6. 挑战

function checkChallenges(): void {
  const kinds = declared(C!.modifierKinds);
  const seen = new Set<string>();
  for (const c of C!.challenges as any[]) {
    const w = `challenge:${c.id}`;
    if (seen.has(c.id)) err(w, 'id 重复');
    seen.add(c.id);
    if (!c.desc) err(w, '缺少 desc');
    if (!Array.isArray(c.modifiers) || c.modifiers.length === 0)
      err(w, '挑战必须改写规则（至少 1 个 modifier）');
    for (const m of c.modifiers ?? []) {
      if (!kinds.has(m.kind)) err(w, `未声明的 modifier.kind: ${m.kind}`);
      if (m.res) refRes(`${w} modifier.res`, m.res);
      if (m.kind === 'layersOnly' && !layerIds.has(m.value)) err(w, `未知层: ${m.value}`);
      if (m.kind === 'resourceZero' || m.kind === 'banResource') refRes(`${w} modifier.value`, m.value);
      if (m.kind === 'outputPenalty') refRes(`${w} modifier.res`, m.res);
      if (m.kind === 'banClass' && !classes.has(m.value)) err(w, `未知 class: ${m.value}`);
    }
    const g = c.goal ?? {};
    if (g.res) refRes(`${w} goal.res`, g.res);
    if (g.kind === 'challenge' && !challIds.has(g.value)) err(w, `未知挑战: ${g.value}`);
    if (!c.reward?.desc) warn(w, '奖励缺少 desc（挑战奖励必须是机制奖励）');
  }
  if ((C!.challenges as any[]).length < 30) err('challenges', '数量不足 30');
}

// ---------------------------------------------------------------- 7. 成就

function checkAchievements(): void {
  const cats = new Set<string>(A!.categories.map((c: any) => c.id));
  const seen = new Set<string>();
  let withEffect = 0;
  for (const a of A!.achievements as any[]) {
    const w = `achievement:${a.id}`;
    if (seen.has(a.id)) err(w, 'id 重复');
    seen.add(a.id);
    if (!cats.has(a.cat)) err(w, `未知分类: ${a.cat}`);
    if (!a.desc) err(w, '缺少 desc');
    if (a.effect) withEffect++;
    const c = a.cond ?? {};
    if (!c.kind) err(w, '缺少 cond.kind');
    if (c.res) refRes(`${w} cond.res`, c.res);
    if (c.kind === 'tech' && !techIds.has(c.value)) err(w, `未知科技: ${c.value}`);
    if (c.kind === 'challenge' && !challIds.has(c.value)) err(w, `未知挑战: ${c.value}`);
  }
  if ((A!.achievements as any[]).length < 100) err('achievements', '数量不足 100');
  if (withEffect < 15) err('achievements', `带真实机制效果的成就只有 ${withEffect} 个（要求 ≥ 15）`);
}

// ---------------------------------------------------------------- 8. 事件

function checkEvents(): void {
  const kinds = declared(E!.modifierKinds);
  const seen = new Set<string>();
  for (const e of E!.events as any[]) {
    const w = `event:${e.id}`;
    if (seen.has(e.id)) err(w, 'id 重复');
    seen.add(e.id);
    if (!['positive', 'neutral', 'negative'].includes(e.kind)) err(w, `未知类型: ${e.kind}`);
    for (const m of e.modifiers ?? []) {
      if (!kinds.has(m.kind)) err(w, `未声明的 modifier.kind: ${m.kind}`);
      if (m.res && m.res !== 'random_rare') refRes(`${w} modifier.res`, m.res);
      if (m.class && !classes.has(m.class)) err(w, `未知 class: ${m.class}`);
    }
    if (e.kind === 'negative' && (e.mitigation ?? []).length === 0)
      err(w, '负面事件必须提供至少一种缓解手段');
  }
  if ((E!.events as any[]).length < 40) err('events', '数量不足 40');
}

// ---------------------------------------------------------------- 9. 任务

function checkQuests(): void {
  const cats = new Set<string>(Q!.categories.map((c: any) => c.id));
  const seen = new Set<string>();
  for (const q of Q!.quests as any[]) {
    const w = `quest:${q.id}`;
    if (seen.has(q.id)) err(w, 'id 重复');
    seen.add(q.id);
    if (!cats.has(q.cat)) err(w, `未知分类: ${q.cat}`);
    const g = q.goal ?? {};
    if (g.res) refRes(`${w} goal.res`, g.res);
    if (g.node) refNode(`${w} goal.node`, g.node);
    if (g.layer && !layerIds.has(g.layer)) err(w, `未知层: ${g.layer}`);
    if (g.kind === 'challenge' && !challIds.has(g.value)) err(w, `未知挑战: ${g.value}`);
    if (q.reward?.res) refRes(`${w} reward.res`, q.reward.res);
    for (const r of q.requires ?? []) if (!questIds.has(r)) err(w, `未知前置任务: ${r}`);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      err('quest', `存在循环前置: ${[...path, id].join(' -> ')}`);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    const q = (Q!.quests as any[]).find((x) => x.id === id);
    for (const r of q?.requires ?? []) visit(r, [...path, id]);
    state.set(id, 2);
  };
  for (const q of Q!.quests as any[]) visit(q.id, []);
  if ((Q!.quests as any[]).length < 50) err('quests', '数量不足 50');
}

// ---------------------------------------------------------------- 10. 配方图（非单链判据）

function checkStrains(): void {
  const effectKinds = declared(U!.effectKinds);
  const specialKinds = declared(ST!.specialKinds);
  const levels = new Set(Object.keys(G!.prestige.levelThresholds).map((k) => Number(k.slice(1))));
  const seen = new Set<string>();

  for (const s of ST!.strains as any[]) {
    const w = `strain:${s.id}`;
    if (seen.has(s.id)) err(w, 'id 重复');
    seen.add(s.id);
    if (!s.name || !s.glyph || !s.desc || !s.tagline) err(w, '缺少 name/glyph/desc/tagline 中的一项');
    if (typeof s.hue !== 'number' || s.hue < 0 || s.hue > 360) err(w, `hue 必须是 0–360 的数字: ${s.hue}`);
    // 解锁门槛：必须对应一个真实存在的 Prestige 层级（0 表示开局可用）
    if (typeof s.unlockLevel !== 'number' || s.unlockLevel < 0 || s.unlockLevel > 4) err(w, `unlockLevel 越界: ${s.unlockLevel}`);
    else if (s.unlockLevel > 0 && !levels.has(s.unlockLevel)) err(w, `unlockLevel ${s.unlockLevel} 在 game-config 里没有对应层级门槛`);
    if (!/^\d+$/.test(String(s.geneCost))) err(w, `geneCost 必须是非负整数字符串: ${s.geneCost}`);
    if (Number(s.geneCost) > 0 && s.unlockLevel === 0) warn(w, '开局可用的菌株却要花基因，玩家第一局可能买不起');

    // 规则改写说明：这是菌株区别于“纯数值升级”的核心，至少要有 2 条
    if (!Array.isArray(s.ruleChanges) || s.ruleChanges.length < 2) err(w, 'ruleChanges 至少要有 2 条（设计规则：菌株必须改写规则）');

    for (const [list, tag] of [[s.effects, 'effects'], [s.drawbacks, 'drawbacks']] as const) {
      if (!Array.isArray(list) || list.length === 0) err(w, `${tag} 不能为空（每种菌株都要有得有失）`);
      for (const e of list ?? []) {
        if (!effectKinds.has(e.kind)) err(w, `${tag} 未声明的 effect.kind: ${e.kind}`);
        if (!e.desc) err(w, `${tag} 的 ${e.kind} 缺少 desc`);
        if (e.node) refNode(`${w} ${tag}.node`, e.node);
        if (e.res) refRes(`${w} ${tag}.res`, e.res);
        if (e.class && !classes.has(e.class)) err(w, `${tag} 未知 class: ${e.class}`);
      }
    }
    if (!Array.isArray(s.drawbacks) || s.drawbacks.length === 0) err(w, '每种菌株必须有 drawbacks（否则会变成无脑最优解）');
    for (const sp of s.specials ?? []) if (!specialKinds.has(sp)) err(w, `未声明的 special: ${sp}`);
  }

  if (seen.size < 6) err('strains', `菌株数量 ${seen.size} < 要求 6`);
  // 开局至少要有两个可选流派，否则第一局面就是唯一解
  const starters = (ST!.strains as any[]).filter((s) => s.unlockLevel === 0).length;
  if (starters < 2) err('strains', `开局可用菌株只有 ${starters} 种，至少要 2 种`);
}

/** 校验 prestige 层级门槛引用的资源真实存在（否则「升层」会成为永远做不到的死条件） */
function checkPrestigeThresholds(): void {
  const resIds = new Set(R!.resources.map((r: any) => r.id));
  for (const [layer, reqs] of Object.entries(G!.prestige.levelThresholds ?? {})) {
    const w = `config:prestige.${layer}`;
    if (!/^p[1-5]$/.test(layer)) err(w, `层级键必须是 p1–p5: ${layer}`);
    for (const [key, amount] of Object.entries(reqs as Record<string, string>)) {
      // sporogene 是 prestige 上的字段而非 resources 里的资源，其余必须是资源
      if (key !== 'sporogene' && !resIds.has(key)) err(w, `门槛引用不存在的资源: ${key}`);
      if (!/^\d+$/.test(String(amount))) err(w, `门槛数量必须是整数字符串: ${key}=${amount}`);
    }
  }
  const levels = Object.keys(G!.prestige.levelThresholds ?? {});
  for (const need of ['p1', 'p2', 'p3', 'p4', 'p5'])
    if (!levels.includes(need)) err('config:prestige', `缺少 ${need} 层级门槛（四层以上 Prestige 是硬要求）`);
}

/** 校验生态法则表：id 唯一、效果 kind 已声明、cost 可解析、叠加上限合理 */
function checkLaws(): void {
  const kinds = declared(LW!.effectKinds);
  const seen = new Set<string>();
  const resIds = new Set(R!.resources.map((r: any) => r.id));
  void resIds;
  for (const l of LW!.laws as any[]) {
    const w = `law:${l.id}`;
    if (seen.has(l.id)) err(w, "id 重复");
    seen.add(l.id);
    if (!l.name || !l.desc) err(w, "缺少 name/desc");
    if (!kinds.has(l.effect?.kind)) err(w, `未声明的 effect.kind: ${l.effect?.kind}`);
    if (!/^\d+$/.test(String(l.cost))) err(w, `cost 必须是非负整数字符串: ${l.cost}`);
    if (typeof l.maxStacks !== "number" || l.maxStacks < 1 || l.maxStacks > 10) err(w, `maxStacks 应在 1–10: ${l.maxStacks}`);
    if (typeof l.needsTarget !== "boolean") err(w, "缺少 needsTarget");
    // 每一条法则都必须能说清它"改了哪条公式"，否则就只是又一个数值升级
    if (!l.effect?.desc) err(w, "效果缺少 desc（无法向玩家解释它改了什么）");
  }
  if (seen.size < 6) err("laws", `法则数量 ${seen.size} < 要求 6`);
}

function checkRecipeGraph(): void {
  const edges = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  const addEdge = (a: string, b: string): void => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  };
  for (const n of N!.nodes as any[]) {
    const ins = Object.keys(n.recipe?.inputs ?? {});
    const outs = Object.keys(n.recipe?.outputs ?? {});
    for (const a of ins) for (const b of outs) addEdge(a, b);
    for (const k of Object.keys(n.cost ?? {})) degree.set(k, (degree.get(k) ?? 0) + 1);
  }
  // (1) 度数 ≥ 2
  for (const r of R!.resources as any[]) {
    if (r.hidden || r.tier >= 4) continue;
    const d = degree.get(r.id) ?? 0;
    if (d < 2) err('recipeGraph', `资源 ${r.id} 在图中的度数 ${d} < 2（单链依赖）`);
  }
  // (2) 纯链节：存在长度 ≥ 4 的连通分量，其中所有资源度数 ≤ 2
  const comp = new Map<string, number>();
  let cid = 0;
  const adj = (a: string): string[] => [...(edges.get(a) ?? [])];
  for (const id of resIds) {
    if (comp.has(id)) continue;
    const stack = [id];
    comp.set(id, cid);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nx of adj(cur)) if (!comp.has(nx)) (comp.set(nx, cid), stack.push(nx));
    }
    cid++;
  }
  const comps = new Map<number, string[]>();
  for (const [id, c] of comp) (comps.get(c) ?? comps.set(c, []).get(c)!).push(id);
  for (const [, members] of comps) {
    const active = members.filter((m) => {
      const r = (R!.resources as any[]).find((x) => x.id === m);
      return r && !r.hidden && r.tier < 4;
    });
    if (active.length < 4) continue;
    const allThin = active.every((m) => (degree.get(m) ?? 0) <= 2);
    if (allThin) err('recipeGraph', `连通分量 [${active.join(', ')}] 是纯链式结构（所有节点度数 ≤ 2）`);
  }
  // (3) 环：有向图中至少存在 3 个环，且覆盖 ≥ 4 个资源
  const onCycle = new Set<string>();
  let cycles = 0;
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj(u)) {
      const cv = color.get(v) ?? 0;
      if (cv === 1) {
        cycles++;
        const idx = stack.indexOf(v);
        for (const s of stack.slice(idx)) onCycle.add(s);
      } else if (cv === 0) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const id of resIds) if ((color.get(id) ?? 0) === 0) dfs(id);
  if (cycles < 3) err('recipeGraph', `配方图中只有 ${cycles} 个环（要求 ≥ 3，保证资源互转而非单链）`);
  if (onCycle.size < 4)
    err('recipeGraph', `环上只覆盖 ${onCycle.size} 个资源（要求 ≥ 4）: ${[...onCycle].join(', ')}`);
}

// ---------------------------------------------------------------- 11. 数量达标（设计文档第四十二条）

function checkMinimums(): void {
  const min: Record<string, [number, number]> = {
    resources: [R!.resources.length, 20],
    nodes: [N!.nodes.length, 30],
    upgrades: [U!.upgrades.length, 100],
    techs: [T!.techs.length, 80],
    challenges: [C!.challenges.length, 30],
    achievements: [A!.achievements.length, 100],
    events: [E!.events.length, 40],
    quests: [Q!.quests.length, 50],
  };
  for (const [k, [got, need]] of Object.entries(min))
    if (got < need) err('minimums', `${k}: ${got} < ${need}`);
}

// ---------------------------------------------------------------- 12. 配置自洽

function checkConfig(): void {
  for (const id of Object.keys(G!.newGame.startingResources))
    if (!resIds.has(id)) err('config', `startingResources 含未知资源: ${id}`);
  for (const r of R!.resources as any[])
    if (!(r.id in G!.newGame.startingResources))
      err('config', `资源 ${r.id} 缺少初始值`);
  for (const f of G!.newGame.freeNodes as any[]) refNode(`config:freeNodes`, f.node);
  if (!layerIds.has(G!.newGame.startLayer)) err('config', `未知起始层: ${G!.newGame.startLayer}`);
  if (G!.simulation.tickRateMs <= 0) err('config', 'tickRateMs 必须 > 0');
}

// ---------------------------------------------------------------- 运行

checkResources();
checkNodes();
checkMatrix();
checkUpgrades();
checkTech();
checkChallenges();
checkAchievements();
checkEvents();
checkQuests();
checkStrains();
checkLaws();
checkPrestigeThresholds();
checkRecipeGraph();
checkMinimums();
checkConfig();
report();

const hasError = issues.some((i) => i.level === 'error');
process.exit(hasError ? 1 : 0);

function report(): void {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  const dim = '\x1b[2m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const green = '\x1b[32m';
  const reset = '\x1b[0m';

  console.log('─'.repeat(64));
  console.log('数据集: resources / nodes / catalyst-matrix / upgrades / tech');
  console.log('        challenges / achievements / events / quests / strains / game-config');
  console.log('─'.repeat(64));
  for (const i of errors) console.log(`${red}ERROR${reset} ${dim}${i.where}${reset} ${i.msg}`);
  for (const i of warns) console.log(`${yellow}WARN ${reset} ${dim}${i.where}${reset} ${i.msg}`);
  console.log('─'.repeat(64));
  if (errors.length === 0) {
    console.log(`${green}✓ 校验通过${reset} — ${warns.length} 个警告`);
  } else {
    console.log(`${red}✗ 校验失败${reset} — ${errors.length} 个错误, ${warns.length} 个警告`);
  }
  console.log(`  内容量: 资源 ${R?.resources.length} / 节点 ${N?.nodes.length} / 升级 ${U?.upgrades.length} / 科技 ${T?.techs.length}`);
  console.log(`          法则 ${LW?.laws.length}`);
  console.log(`          挑战 ${C?.challenges.length} / 成就 ${A?.achievements.length} / 事件 ${E?.events.length} / 任务 ${Q?.quests.length} / 菌株 ${ST?.strains.length}`);
}
