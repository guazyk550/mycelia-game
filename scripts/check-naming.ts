#!/usr/bin/env node
/**
 * 名实一致性校验 —— 防止"名称说 A、效果是 B"。
 *
 * 起因：玩家反馈科技树里的「自动生产」悬停后写着"配方自动切换"，而它的实际效果
 * 是自动扩建；「自动采集 I」更糟 —— 它在引擎里什么都不做，而"手动采集"这个
 * 概念在本作根本不存在。玩家点完科技感觉不到变化，然后合理地认为它没用。
 *
 * 本脚本做两类检查：
 *   1. 名称里提到的动作，是否与 effect.kind 相容；
 *   2. 描述里承诺的百分比，是否与 effect.value 对得上。
 *
 * 用法：node scripts/check-naming.ts   （或 npm run check:naming）
 * 退出码：0 = 通过；1 = 存在不一致
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 支持用 MYCELIA_DATA 指向另一份数据副本，便于做"注入坏数据看校验能否抓到"的反证测试
const DATA_DIR = process.env.MYCELIA_DATA
  ? join(process.cwd(), process.env.MYCELIA_DATA)
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f: string): any => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));

const tech = read('tech.json');
const upgrades = read('upgrades.json');

/**
 * 名称关键词 → 相容的 effect.kind 集合。
 * 只列"动作性"关键词：名称里承诺了某件事，effect 就必须能做那件事。
 */
const ACTION_COMPAT: Record<string, string[]> = {
  采集: ['autoTier', 'outputMul'],
  购买: ['autoTier', 'buildCostDiscount'],
  扩建: ['autoTier', 'outputMul'],
  连线: ['autoTier', 'linkFlux', 'unlock'],
  铺线: ['autoTier', 'linkFlux', 'unlock'],
  优化: ['autoTier', 'catalystBonus', 'unlock', 'outputMul'], // "优化藻类基因"= 提升产出，语义成立
  调整: ['autoTier', 'catalystBonus'],
  孢子化: ['autoTier', 'prestigeGain'],
  规则: ['ruleSlot', 'unlock', 'outputMul', 'autoTier'],
  催化: ['catalystBonus', 'unlock', 'outputMul', 'inputDiscount', 'linkFlux'], // "催化节流"中催化是名词
  产出: ['outputMul', 'autoTier'],
  成本: ['buildCostDiscount', 'costGrowthAdd'],
  土壤: ['richnessRepair', 'richnessFloor', 'richnessCap', 'depletionReduce', 'unlock'], // 土壤类机制的解锁
  暴击: ['critChance', 'critMul'],
  离线: ['offlineEfficiency', 'unlock'],
  市场: ['marketFee', 'unlock'],
  连线通量: ['linkFlux'],
  事件: ['eventResist', 'unlock'],
};

/**
 * 本作**不存在**的手动动作。
 *
 * 「自动采集」是最典型的一个：这个游戏从设计上就没有手动采集 —— extractor 节点
 * 一直自动产出。所以"把采集自动化"这件事根本无对象可做，而玩家看到这个名字后
 * 会合理地以为"我是不是该先手动采集"，然后发现整件事是个空承诺。
 */
const NONEXISTENT_ACTIONS = ['自动采集'];

interface Issue {
  where: string;
  msg: string;
}

const issues: Issue[] = [];
const notes: string[] = [];

/** 检查一条条目（科技或升级） */
function checkEntry(where: string, name: string, desc: string, effect: any): void {
  const kind = effect?.kind ?? '(无)';

  // 0) 名称里不得出现本作不存在的动作
  for (const word of NONEXISTENT_ACTIONS) {
    if (name.includes(word)) {
      issues.push({ where, msg: `名称含「${word}」—— 本作没有这个可被自动化的手动动作，属于空承诺` });
    }
  }

  // 1) 名称里的动作关键词必须与 effect.kind 相容
  for (const [word, allowed] of Object.entries(ACTION_COMPAT)) {
    if (!name.includes(word)) continue;
    if (!allowed.includes(kind)) {
      issues.push({
        where,
        msg: `名称含「${word}」，但 effect.kind = ${kind}（该动作的相容类型：${allowed.join(' / ')}）`,
      });
    }
  }

  // 2) 描述里的百分比承诺应与 effect.value 对得上
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(desc ?? '');
  if (pct && typeof effect?.value === 'number' && kind === 'outputMul') {
    const promised = Number(pct[1]) / 100;
    const actual = effect.value;
    // 描述允许写"表现为 +10%"这类换算，只在差异悬殊时告警
    if (Math.abs(promised - actual) > 0.05) {
      notes.push(`${where}: 描述写 ${pct[1]}%，effect.value = ${actual}（可能是换算表述，人工确认一次）`);
    }
  }

  // 3) 描述为空或过短
  if (!desc || desc.length < 8) issues.push({ where, msg: '描述过短或缺失 —— 玩家无法理解它做什么' });
}

for (const t of tech.techs as any[]) checkEntry(`tech:${t.id}`, t.name ?? '', t.desc ?? '', t.effect);
for (const u of upgrades.upgrades as any[]) checkEntry(`upgrade:${u.id}`, u.name ?? '', u.desc ?? '', u.effect);

// ---------------------------------------------------------------- 报告
const dim = '\x1b[2m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';
const green = '\x1b[32m';
const reset = '\x1b[0m';

console.log('─'.repeat(64));
console.log(`名实一致性检查：科技 ${tech.techs.length} 条 + 升级 ${upgrades.upgrades.length} 条`);
console.log('─'.repeat(64));
for (const i of issues) console.log(`${red}✗${reset} ${dim}${i.where}${reset} ${i.msg}`);
for (const n of notes) console.log(`${yellow}?${reset} ${dim}${n}${reset}`);
console.log('─'.repeat(64));
if (issues.length === 0) {
  console.log(`${green}✓ 名称、描述与效果三者一致${reset}${notes.length ? `（${notes.length} 处待人工确认）` : ''}`);
  process.exit(0);
}
console.log(`${red}✗ ${issues.length} 处名实不符${reset}`);
process.exit(1);
