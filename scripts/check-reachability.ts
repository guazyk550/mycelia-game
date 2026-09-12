/**
 * 资源可达性分析 —— 防止"永久卡死"这类最致命的数值事故。
 *
 * 背景：一条真实事故 —— 星尘的唯一产出者是「星尘收集器」（成本含法则碎片），
 * 而法则碎片的唯一产出者是「法则织机」（解锁需要星尘）。两者互相需要，
 * 结果 Meta 层永远进不去，后期内容整块不可达。数据表校验当时只检查了
 * "引用是否存在"，没有检查"引用是否可达"。
 *
 * 本脚本对每张表的**产出关系**做依赖分析，报出：
 *   1. 无产出者且不是初始资源的资源（死资源）；
 *   2. 互相锁死的环（A 的唯一产出路径需要 B，B 的唯一产出路径需要 A）；
 *   3. 依赖不可达资源的节点（永远不会被造出来）。
 *
 * 用法：node scripts/check-reachability.ts   （或 npm run check:reach）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f: string): any => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));

const resources = read('resources.json').resources as any[];
const nodes = read('nodes.json').nodes as any[];
const config = read('game-config.json');

/** 初始可得的资源（开局持有或开局已解锁） */
const initial = new Set<string>([
  ...Object.entries(config.newGame.startingResources as Record<string, string>)
    .filter(([, v]) => Number(v) > 0)
    .map(([k]) => k),
  ...(config.newGame.unlockedResources as string[]),
]);

/**
 * 由**非节点机制**产出的资源：它们不参与"必须有节点产出者"的检查，
 * 但必须在此登记来源 —— 登记本身就是一种承诺，避免"忘了实现"被当成"设计如此"。
 * status: ok = 已实现；pending = 尚未实现（会被报为待办而不是静默通过）
 */
const NON_NODE_SOURCES = new Map<string, { why: string; status: 'ok' | 'pending' }>([
  ['sporogene', { why: '孢子化收益（doPrestige）', status: 'ok' }],
  ['strain', { why: 'P3 虫巢意识跃迁产出', status: 'ok' }],
  ['voidspore', { why: '隐藏系统：虚空菌床（完成「贫瘠世界」挑战掉落）', status: 'ok' }],
  ['echo', { why: '隐藏系统：事件链（同一 chainTag 连续发生三次）', status: 'ok' }],
]);

interface NodeNeeds {
  id: string;
  /** 建造/运行需要的资源（成本 + 配方输入） */
  needs: string[];
  /** 解锁条件要求的资源 */
  unlockNeeds: string[];
  outputs: string[];
}

const parsed: NodeNeeds[] = nodes.map((n) => ({
  id: n.id,
  needs: [...Object.keys(n.cost ?? {}), ...Object.keys(n.recipe?.inputs ?? {})],
  unlockNeeds: n.unlock && n.unlock.type === 'resource' && n.unlock.resource ? [n.unlock.resource as string] : [],
  outputs: Object.keys(n.recipe?.outputs ?? {}),
}));

const producers = new Map<string, NodeNeeds[]>();
for (const p of parsed) {
  for (const res of p.outputs) {
    const list = producers.get(res) ?? [];
    list.push(p);
    producers.set(res, list);
  }
}

/** r 是否可由"已可达集合"造出 */
function resourceReachable(res: string, have: Set<string>, seen: Set<string>): boolean {
  if (have.has(res) || initial.has(res)) return true;
  if (seen.has(res)) return false; // 环
  seen.add(res);

  const list = producers.get(res) ?? [];
  for (const p of list) {
    // 造这个节点所需的资源与解锁条件都必须可达
    const allNeedsOk = [...p.needs, ...p.unlockNeeds].every((need) => resourceReachable(need, have, new Set(seen)));
    if (allNeedsOk) {
      have.add(res);
      return true;
    }
  }
  return false;
}

const reachable = new Set<string>(initial);
const problems: string[] = [];
/** 已登记来源但尚未实现的部分（报为待办，不阻塞验收） */
const pending: string[] = [];

// 反复放宽直到收敛（一个资源可达后，可能让更多节点变得可造）
for (let pass = 0; pass < 12; pass++) {
  let grew = false;
  for (const r of resources) {
    if (reachable.has(r.id)) continue;
    if (resourceReachable(r.id, reachable, new Set())) {
      reachable.add(r.id);
      grew = true;
    }
  }
  if (!grew) break;
}

// 1) 死资源：既不可达，也没有产出者
for (const r of resources) {
  if (initial.has(r.id)) continue;
  if (NON_NODE_SOURCES.has(r.id)) continue; // 由孢子化/层级/隐藏系统产出，不要求节点产出者
  if (!producers.has(r.id)) {
    problems.push(`资源「${r.name}」(${r.id}) 没有任何产出者，也不是初始资源 —— 永远不会出现`);
    continue;
  }
}

// 2) 不可达资源（含互相锁死）
for (const r of resources) {
  if (reachable.has(r.id)) continue;
  const special = NON_NODE_SOURCES.get(r.id);
  if (special) {
    // 登记过的非节点来源：算可达；但"尚未实现"必须说出来，不能被当成设计如此
    if (special.status === 'pending') pending.push(`资源「${r.name}」(${r.id}) 的来源尚未实现：${special.why}`);
    reachable.add(r.id);
    continue;
  }
  const list = producers.get(r.id) ?? [];
  const detail = list.length
    ? list
        .map((p) => `${p.id}(需 ${[...p.needs, ...p.unlockNeeds].join('/') || '无'})`)
        .join(' 或 ')
    : '无产出者';
  problems.push(`资源「${r.name}」(${r.id}) 不可达 ← 产出者: ${detail}`);
}

// 3) 不可达节点
for (const p of parsed) {
  const ok = [...p.needs, ...p.unlockNeeds].every((n) => reachable.has(n));
  if (!ok) {
    const missing = [...p.needs, ...p.unlockNeeds].filter((n) => !reachable.has(n));
    problems.push(`节点「${p.id}」不可建造 ← 缺少可达资源: ${missing.join(', ')}`);
  }
}

console.log('─'.repeat(64));
console.log(`可达性分析：资源 ${resources.length} 个，节点 ${parsed.length} 个`);
console.log(`可达资源 ${reachable.size} / ${resources.length}`);
console.log('─'.repeat(64));
for (const p2 of pending) console.log(`\x1b[33mWARN\x1b[0m ${p2}`);
if (problems.length === 0) {
  console.log(`\x1b[32m✓ 全部资源与节点都可达\x1b[0m${pending.length ? `（另有 ${pending.length} 项待实现）` : ''}`);
  process.exit(0);
}
for (const p of problems) console.log(`\x1b[31m✗\x1b[0m ${p}`);
console.log('─'.repeat(64));
console.log(`\x1b[31m✗ ${problems.length} 处不可达\x1b[0m（会导致玩家永久卡死）`);
process.exit(1);
