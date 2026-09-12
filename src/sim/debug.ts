#!/usr/bin/env node
/**
 * 模拟器调试观察窗：打印前 N 分钟的策略决策与资源变化，用来回答
 * "为什么机器人卡住了 / 为什么不建某个节点"。
 *
 * 用法：node src/sim/debug.ts [策略序号 0-5] [观察秒数]
 */

import { SciNum as S } from '../core/math/scinum.ts';
import { createNewGame } from '../core/state.ts';
import { loadGameData } from '../data/node-source.ts';
import {
  computeModifiers,
  isNodeUnlocked,
  nodeCost,
  sporogeneGain,
  tick,
} from '../core/economy/engine.ts';
import { applyAction, decideAndAct, STRATEGIES, type SimAction, type StrategyContext } from './strategies.ts';

const data = loadGameData();
const strategy = STRATEGIES[Number(process.argv[2] ?? 0)] ?? STRATEGIES[0]!;
const watchSec = Number(process.argv[3] ?? 300);

let state = createNewGame(data);
let mods = computeModifiers(state, data);
const ctx: StrategyContext = { state, data, mods, prestigeGain: S.ZERO };

console.log(`策略: ${strategy.name}（${strategy.desc}）`);
console.log('─'.repeat(70));

const describe = (a: SimAction): string => {
  switch (a.kind) {
    case 'buildNode':
      return `建造 ${a.typeId}`;
    case 'upgrade':
      return `升级 ${a.id}`;
    case 'tech':
      return `科技 ${a.id}`;
    case 'prestige':
      return '孢子化';
    default:
      return JSON.stringify(a);
  }
};

let stallCount = 0;
for (let t = 0; t < watchSec; t++) {
  ctx.prestigeGain = sporogeneGain(state, data, mods);
  const results = decideAndAct(ctx, strategy.prefs);
  let dirty = results.some((r) => r.ok);
  const log: string[] = [];
  for (const r of results) {
    if (r.action.kind === 'prestige') {
      log.push('孢子化（调试模式跳过重置）');
      continue;
    }
    log.push(`${describe(r.action)} ${r.ok ? '✓' : `✗(${r.reason})`}`);
  }
  if (dirty) {
    mods = computeModifiers(state, data);
    ctx.mods = mods;
  }
  tick(state, data, 1, { mods });

  if (log.length === 0) stallCount++;
  else stallCount = 0;

  if (t % 30 === 0 || stallCount === 60) {
    const res = ['humus', 'water', 'sugar', 'spore', 'mineral']
      .map((r) => `${r}=${S.format(state.resources[r]!)}`)
      .join(' ');
    console.log(
      `t=${String(t).padStart(4)}s | 节点 ${String(state.graph.size()).padStart(3)} | 层 ${state.unlockedLayers.length} | ${res}`,
    );
    if (log.length > 0) console.log('        决策: ' + log.join(', '));
    else console.log('        决策: （无可负担的选项 → 停滞）');
  }

  if (stallCount === 60) {
    // 停滞超过 60 秒：列出当前"最接近买得起"的候选项
    const near: string[] = [];
    for (const [typeId, parsed] of data.nodes) {
      if (!isNodeUnlocked(state, data, typeId)) continue;
      if (!state.unlockedLayers.includes(parsed.def.layer)) continue;
      const cost = nodeCost(state, data, typeId, mods);
      const detail = cost
        .map((c) => `${c.res} ${S.format(S.div(S.add(state.resources[c.res] ?? S.ZERO, c.amount), c.amount))}`)
        .join(' ');
      near.push(`${typeId}: ${cost.map((c) => `${c.res}×${S.format(c.amount)}`).join(' ')} [gap ${detail}]`);
      if (near.length >= 8) break;
    }
    console.log('        ⚠ 停滞中，最近的候选：');
    for (const n of near) console.log('          - ' + n);
    const unlocked = [...data.nodes.keys()].filter((id) => isNodeUnlocked(state, data, id));
    console.log('        已解锁节点类型: ' + unlocked.join(', '));
    break;
  }
}

console.log('─'.repeat(70));
console.log(
  `结束于 t=${state.elapsed}s，节点 ${state.graph.size()}，连线 ${state.graph.links.size}，层 ${state.unlockedLayers.length}`,
);
