/**
 * 前期体验诊断 —— 回答"为什么 20 分钟就无聊"。
 *
 * 判据不是"产出涨了多少"，而是玩家在两个维度上的感受：
 *   1. **质变时刻**：解锁了新节点类 / 新资源 / 新层 / 新机制 —— 世界观被撑大的瞬间；
 *   2. **有意义的选择**：此刻真的可做、且差异可感知的决策数
 *      （能建的不同节点类型、能买的不同升级、能铺的新层……）。
 *
 * 用法：node src/sim/diagnose.ts [秒数]
 */

import { SciNum } from '../core/math/scinum.ts';
import { createNewGame } from '../core/state.ts';
import { loadGameData } from '../data/node-source.ts';
import { computeModifiers, canAfford, isNodeUnlocked, nodeCost, tick } from '../core/economy/engine.ts';
import { decideAndAct, STRATEGIES, type StrategyContext } from './strategies.ts';

const data = loadGameData();
const TOTAL = Number(process.argv[2] ?? 1800); // 默认 30 分钟
const SAMPLE = 10; // 每 10 秒采样

const st = createNewGame(data);
let mods = computeModifiers(st, data);

interface Row {
  min: number;
  nodes: number;
  nodeTypes: number;
  resources: number;
  layers: number;
  buildable: number;
  affordableUpgrades: number;
  event: string[];
}

const rows: Row[] = [];
const seenTypes = new Set<string>();
const seenRes = new Set<string>();
const seenLayers = new Set(st.unlockedLayers);
const seenMechanics = new Set<string>();
// 开局已解锁的节点类型（用于检测"游戏新开了哪扇门"）
const unlockedTypes = new Set<string>();
for (const [id] of data.nodes) if (isNodeUnlocked(st, data, id)) unlockedTypes.add(id);

// 开局已知内容（不记为"质变"）
for (const n of st.graph.nodes.values()) seenTypes.add(n.typeId);
for (const [id, v] of Object.entries(st.resources)) if (v.isPositive()) seenRes.add(id);

let pendingEvents: string[] = [];
let nextSample = 0;

const strategy = STRATEGIES[0]!; // 用"积极点击"型玩家作为基准：真人不会比它更勤快
const ctx: StrategyContext = { state: st, data, mods, prestigeGain: SciNum.ZERO };

for (let i = 0; i < TOTAL * 10; i++) {
  tick(st, data, 0.1, { mods });
  mods = computeModifiers(st, data);
  ctx.mods = mods;
  ctx.state = st;
  // 每 2 秒给玩家一次操作机会（比真人的点击频率低得多，偏保守）
  if (i % 20 === 0) {
    decideAndAct(ctx, strategy.prefs);
    mods = computeModifiers(st, data);
  }

  // 质变检测
  for (const n of st.graph.nodes.values()) {
    if (!seenTypes.has(n.typeId)) {
      seenTypes.add(n.typeId);
      pendingEvents.push(`首次建造 ${data.nodes.get(n.typeId)?.def.name ?? n.typeId}`);
    }
  }
  for (const [id, v] of Object.entries(st.resources)) {
    if (v.isPositive() && !seenRes.has(id)) {
      seenRes.add(id);
      pendingEvents.push(`首次获得 ${data.resources.get(id)?.def.name ?? id}`);
    }
  }
  for (const l of st.unlockedLayers) {
    if (!seenLayers.has(l)) {
      seenLayers.add(l);
      pendingEvents.push(`解锁新层 ${data.layers.get(l)?.name ?? l}`);
    }
  }
  // 新解锁：游戏给玩家开了新选项（即使玩家暂时没建，这也是"新可能性"）
  for (const [id] of data.nodes) {
    if (unlockedTypes.has(id)) continue;
    if (isNodeUnlocked(st, data, id)) {
      unlockedTypes.add(id);
      pendingEvents.push(`解锁可建：${data.nodes.get(id)?.def.name ?? id}`);
    }
  }
  if (mods.autoTier > 0 && !seenMechanics.has('auto')) {
    seenMechanics.add('auto');
    pendingEvents.push(`自动化解锁（Lv${mods.autoTier}）`);
  }

  // 采样
  if (st.elapsed >= nextSample) {
    nextSample += SAMPLE;
    let buildable = 0;
    for (const [id, node] of data.nodes) {
      if (!isNodeUnlocked(st, data, id)) continue;
      const layerOk = st.unlockedLayers.includes(node.def.layer);
      if (!layerOk) continue;
      if (canAfford(st, nodeCost(st, data, id, mods))) buildable++;
    }
    let affordableUpgrades = 0;
    for (const [id, up] of data.upgrades) {
      const lvl = st.upgrades[id] ?? 0;
      if (lvl >= up.def.maxLevel) continue;
      const cost = up.cost.map((c) => ({ res: c.res, amount: SciNum.mul(c.amount, Math.pow(up.def.growth, lvl)) }));
      if (canAfford(st, cost)) affordableUpgrades++;
    }
    const minute = Math.round(st.elapsed / 60);
    if (rows.length === 0 || rows[rows.length - 1]!.min !== minute) {
      rows.push({
        min: minute,
        nodes: st.graph.size(),
        nodeTypes: new Set([...st.graph.nodes.values()].map((n) => n.typeId)).size,
        resources: Object.values(st.resources).filter((v) => v.isPositive()).length,
        layers: st.unlockedLayers.length,
        buildable,
        affordableUpgrades,
        event: pendingEvents,
      });
      pendingEvents = [];
    } else {
      rows[rows.length - 1]!.event.push(...pendingEvents);
      pendingEvents = [];
    }
  }
}

console.log('《共生之网》前期体验诊断（前 ' + Math.round(TOTAL / 60) + ' 分钟）');
console.log('─'.repeat(78));
console.log('分钟 | 节点 | 类型 | 资源 | 层 | 可建 | 可买升级 | 这一分钟发生的事');
console.log('─'.repeat(78));
for (const r of rows) {
  const ev = r.event.length > 0 ? r.event.join('、') : '';
  console.log(
    String(r.min).padStart(4) + ' |' +
    String(r.nodes).padStart(5) + ' |' +
    String(r.nodeTypes).padStart(5) + ' |' +
    String(r.resources).padStart(5) + ' |' +
    String(r.layers).padStart(3) + ' |' +
    String(r.buildable).padStart(5) + ' |' +
    String(r.affordableUpgrades).padStart(9) + ' | ' + ev,
  );
}
console.log('─'.repeat(78));

// 汇总
const first20 = rows.filter((r) => r.min <= 20);
const changes = first20.filter((r) => r.event.length > 0 && r.min > 0);
console.log(`前 20 分钟质变时刻：${changes.length} 次（${changes.map((c) => c.min + '′').join(' ')}）`);
const gap = changes.length > 1
  ? Math.max(...changes.slice(1).map((c, i) => c.min - changes[i]!.min))
  : 20;
console.log(`最长"什么都没发生"的间隔：${gap} 分钟`);
const avgChoices = first20.length > 0
  ? first20.reduce((s, r) => s + r.buildable + r.affordableUpgrades, 0) / first20.length
  : 0;
console.log(`平均可做选择数 / 分钟：${avgChoices.toFixed(1)}（可建节点 + 可买升级）`);
