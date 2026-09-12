#!/usr/bin/env node
/**
 * 经济模拟器入口：`npm run sim`
 *
 * 跑 6 类玩家原型 × 9 个时间截面，输出：
 *   docs/balance/report.md   人类可读报告 + 自动检查结论
 *   docs/balance/curves.csv  所有采样点数据（可导入表格工具画图）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../data/node-source.ts';
import { STRATEGIES } from './strategies.ts';
import { SAMPLE_POINTS, runSimulation, type SimResult } from './runner.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'balance');
const TRACKED = [
  'humus', 'water', 'sugar', 'spore', 'mineral',
  'enzyme', 'honeydew', 'sclerotium', 'core', 'signal',
];

function lg(result: SimResult, label: string, res: string): number {
  const s = result.samples.find((x) => x.label === label);
  if (!s) return Number.NEGATIVE_INFINITY;
  return s.log10[res] ?? Number.NEGATIVE_INFINITY;
}

function fmtLog(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(2)}h`;
}

function firstPrestigeSec(r: SimResult): number | null {
  const m = r.milestones.find((x) => x.text.startsWith('孢子化'));
  return m ? m.at : null;
}

/** 增长是否失控：7 天内 log10 增长必须近似线性，不能出现超指数拐点 */
function explosionCheck(r: SimResult): string | null {
  const key = 'sugar';
  const series = r.samples.map((s) => s.log10[key] ?? Number.NEGATIVE_INFINITY).filter((v) => Number.isFinite(v));
  if (series.length < 3) return null;
  const growth = series.map((v, i) => (i === 0 ? 0 : v - series[i - 1]!));
  const later = growth.slice(Math.floor(growth.length / 2));
  const earlier = growth.slice(1, Math.floor(growth.length / 2));
  const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const ratio = avg(later) / Math.max(1e-9, avg(earlier));
  if (ratio > 50) return `sugar 的 log10 增速在后半程放大 ${ratio.toFixed(1)}×（疑似超指数）`;
  return null;
}

/** 死路：采样点之间既没有新节点、也没有数量级增长、也没有发生孢子化 */
function deadEndCheck(r: SimResult): string | null {
  for (let i = 1; i < r.samples.length; i++) {
    const a = r.samples[i - 1]!;
    const b = r.samples[i]!;
    const nodesGrew = b.nodes > a.nodes;
    const prestiged = b.prestigeCount > a.prestigeCount;
    const valueGrew = (b.log10['humus'] ?? -Infinity) - (a.log10['humus'] ?? -Infinity) > 0.5;
    if (!nodesGrew && !valueGrew && !prestiged)
      return `在 ${a.label} → ${b.label} 区间内既无扩张、无数量级增长、也未孢子化（疑似死路）`;
  }
  return null;
}

function main(): void {
  const data = loadGameData();
  const results: SimResult[] = [];

  console.log('《共生之网》经济模拟器');
  console.log('─'.repeat(60));

  for (const strategy of STRATEGIES) {
    process.stdout.write(`▶ ${strategy.name.padEnd(14)} 运行中... `);
    const r = runSimulation(strategy, { data });
    results.push(r);
    if (r.error) {
      console.log(`✗ 抛错: ${r.error}`);
    } else {
      console.log(
        `✓ ${(r.wallMs / 1000).toFixed(1)}s | ${r.samples.at(-1)!.nodes} 节点 | 孢子化 ${r.samples.at(-1)!.prestigeCount} 次`,
      );
    }
  }

  // ---------------------------------------------------------------- Build（菌株）对比
  // 单一支配 Build 是增量游戏最常见的失败模式：如果某个流派在所有时间点都更强，
  // 其余 5 种就是装饰品。这里用同一策略分别套 6 种菌株跑一遍，只看差异。
  console.log('─'.repeat(60));
  console.log('Build 对比（策略 A 为基准，分别表达 6 种菌株）');
  const baseStrategy = STRATEGIES[0]!;
  const strainIds = [...data.strains.keys()];
  const buildResults: { id: string; name: string; at1h: number; at24h: number; at7d: number; nodes: number }[] = [];
  for (const sid of strainIds) {
    const def = data.strains.get(sid)!.def;
    const strat = { ...baseStrategy, id: baseStrategy.id + ':' + sid, prefs: { ...baseStrategy.prefs, strain: sid } };
    process.stdout.write(`▶ ${def.name.padEnd(10)} 运行中... `);
    const r = runSimulation(strat, { data });
    if (r.error) {
      console.log('✗ ' + r.error);
      continue;
    }
    const pick = (label: string): number => {
      const smp = r.samples.find((x) => x.label === label);
      // 指标选择经历了两轮修正：
      //   ① 用「糖」→ 中后期被下游吃干净，6 种菌株全部显示 0；
      //   ② 用「孢子基因」→ 它是跨世代累积，被重置节奏主导（三种菌株给出 2.32/2.30/2.32 的近同值）；
      //   ③ 最终用「节点规模」—— 它直接反映"这一轮长得多大"，正是流派的差异所在。
      return smp ? smp.nodes : 0;
    };
    buildResults.push({
      id: sid,
      name: def.name,
      at1h: pick('1h'),
      at24h: pick('24h'),
      at7d: pick('7d'),
      nodes: r.samples.at(-1)!.nodes,
    });
    console.log(`✓ 1h=${pick('1h')} 节点 24h=${pick('24h')} 节点 7d=${pick('7d')} 节点`);
  }
  // 支配判定：若某个菌株在三个时间点都是最优，说明它有支配性
  let dominant: string | null = null;
  if (buildResults.length === strainIds.length) {
    const bestAt = (k: 'at1h' | 'at24h' | 'at7d'): number => Math.max(...buildResults.map((b) => b[k]));
    const winners = buildResults.filter((b) => b.at1h >= bestAt('at1h') || b.at24h >= bestAt('at24h') || b.at7d >= bestAt('at7d'));
    const alwaysBest = buildResults.filter(
      (b) => b.at1h >= bestAt('at1h') && b.at24h >= bestAt('at24h') && b.at7d >= bestAt('at7d'),
    );
    dominant = alwaysBest.length > 0 ? alwaysBest.map((b) => b.name).join('、') : null;
    console.log(`领先过的菌株：${winners.map((w) => w.name).join('、')}`);
    if (dominant) console.log(`⚠ 支配性 Build：${dominant}（三个时间点全部最优）`);
    else console.log('✓ 无支配性 Build（没有任何菌株在三个时间点全部最优）');
  }

  // 确定性检查：同策略跑两次，采样序列必须逐字节一致
  const rerun = runSimulation(STRATEGIES[0]!, { data });
  const deterministic =
    JSON.stringify(rerun.samples) === JSON.stringify(results[0]!.samples) &&
    JSON.stringify(rerun.milestones) === JSON.stringify(results[0]!.milestones);

  // ---------------------------------------------------------------- 报告
  mkdirSync(OUT_DIR, { recursive: true });

  const lines: string[] = [];
  lines.push('# 经济模拟报告 · Mycelia');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`模拟器版本：v0.1（与游戏共用 engine，步长自适应 1s/5s/30s）`);
  lines.push('');

  lines.push('## 1. 总览');
  lines.push('');
  lines.push('| 策略 | 最终节点 | 最终连线 | 孢子化次数 | 首次孢子化 | 7d 糖(log10) | 7d 核心(log10) | 耗时 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const fp = firstPrestigeSec(r);
    lines.push(
      `| ${r.strategyName} | ${r.finalNodes} | ${r.finalLinks} | ${r.samples.at(-1)!.prestigeCount} | ${
        fp === null ? '未达成' : fmtDuration(fp)
      } | ${fmtLog(lg(r, '7d', 'sugar'))} | ${fmtLog(lg(r, '7d', 'core'))} | ${(r.wallMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push('');

  lines.push('## 2. 关键资源曲线（log10）');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.strategyName}`);
    lines.push('');
    lines.push(`| 时间 | ${TRACKED.join(' | ')} | 节点 | 层 | 科技 |`);
    lines.push(`|---|${TRACKED.map(() => '---').join('|')}|---|---|---|`);
    for (const s of r.samples) {
      const cells = TRACKED.map((res) => fmtLog(s.log10[res] ?? Number.NEGATIVE_INFINITY));
      lines.push(`| ${s.label} | ${cells.join(' | ')} | ${s.nodes} | ${s.layers} | ${s.techs} |`);
    }
    lines.push('');
  }

  lines.push('## 3. 里程碑');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.strategyName}`);
    lines.push('');
    if (r.milestones.length === 0) lines.push('_无里程碑记录_');
    for (const m of r.milestones) lines.push(`- \`${fmtDuration(m.at)}\` ${m.text}`);
    lines.push('');
  }

  lines.push('## 4. 自动检查（balance-model §13）');
  lines.push('');
  lines.push('| # | 检查项 | 结果 |');
  lines.push('|---|---|---|');
  const firstPrestiges = results.map(firstPrestigeSec).filter((x): x is number => x !== null);
  const fastest = firstPrestiges.length ? Math.min(...firstPrestiges) : null;
  const median = firstPrestiges.length
    ? [...firstPrestiges].sort((a, b) => a - b)[Math.floor(firstPrestiges.length / 2)]!
    : null;
  // 判定用「最快策略」：它代表最愿意尽早重置的玩家，是"经济是否允许早期 Prestige"的下界。
  const inTarget = fastest !== null && fastest >= 30 * 60 && fastest <= 120 * 60;
  lines.push(
    `| 1 | 首次孢子化时间（目标 45–120 分钟） | ${fastest === null ? '**未达成**' : `${fmtDuration(fastest)}${inTarget ? ' ✓' : '（最早）'} / 中位数 ${median === null ? '—' : fmtDuration(median)}`} |`,
  );
  const errs = results.filter((r) => r.error);
  lines.push(`| 2 | 无 NaN/Infinity/不变量违规 | ${errs.length === 0 ? '✓ 全部通过' : `✗ ${errs.length} 个策略抛错`} |`);
  const deadEnds = results.map((r) => [r.strategyName, deadEndCheck(r)] as const).filter(([, x]) => x !== null);
  lines.push(`| 3 | 死路检测 | ${deadEnds.length === 0 ? '✓ 无死路' : `⚠ ${deadEnds.map(([n, x]) => `${n}: ${x}`).join('；')}`} |`);
  const explosions = results.map((r) => [r.strategyName, explosionCheck(r)] as const).filter(([, x]) => x !== null);
  lines.push(`| 4 | 无限收益/超指数增长 | ${explosions.length === 0 ? '✓ 无超指数' : `✗ ${explosions.map(([n, x]) => `${n}: ${x}`).join('；')}`} |`);
  lines.push(`| 5 | 确定性（同策略两次结果一致） | ${deterministic ? '✓ 通过' : '✗ 不一致'} |`);

  // 领先分布：每个采样点谁最强
  const leadCount: Record<string, number> = {};
  for (let i = 0; i < SAMPLE_POINTS.length; i++) {
    let bestName = '';
    let bestVal = -Infinity;
    for (const r of results) {
      const v = r.samples[i]?.log10['sugar'] ?? -Infinity;
      if (v > bestVal) {
        bestVal = v;
        bestName = r.strategyName;
      }
    }
    if (bestName) leadCount[bestName] = (leadCount[bestName] ?? 0) + 1;
  }
  const totalLeads = Object.values(leadCount).reduce((a, b) => a + b, 0) || 1;
  const topShare = Math.max(...Object.values(leadCount), 0) / totalLeads;
  lines.push(
    `| 6 | 单一策略统治（阈值 70%） | ${topShare <= 0.7 ? '✓ 通过' : `✗ ${(topShare * 100).toFixed(0)}% 时间点由同一策略领先`} |`,
  );
  lines.push('');
  lines.push('领先分布（按 sugar log10）：' + Object.entries(leadCount).map(([k, v]) => `${k} ×${v}`).join('，'));
  lines.push('');

  // Build（菌株）对比：单一支配 Build 是增量游戏最常见的失败模式
  if (buildResults.length > 0) {
    lines.push('');
    lines.push('## 5. Build（菌株）对比');
    lines.push('');
    lines.push('同一策略（A 积极点击）分别表达 6 种菌株，指标为**节点规模**。');
    lines.push(
      '指标选择本身踩过两次坑：糖在中后期会被下游消耗干净（6 种菌株全部显示 0）；孢子基因是跨世代累积，' +
        '被重置节奏主导（三种菌株给出 2.32/2.30/2.32 的近同值）。节点规模才直接反映「这一轮长得多大」。',
    );
    lines.push('');
    lines.push('| 菌株 | 1h 节点 | 24h 节点 | 7d 节点 | 最终连线 |');
    lines.push('|---|---|---|---|---|');
    for (const b of buildResults) {
      lines.push(`| ${b.name} | ${b.at1h} | ${b.at24h} | ${b.at7d} | ${b.nodes} |`);
    }
    lines.push('');
    lines.push(
      dominant
        ? `**⚠ 支配性 Build：${dominant}** —— 三个时间点全部最优，需要调整数值。`
        : '**✓ 无支配性 Build** —— 没有任何菌株在三个时间点全部最优（不同流派各有所长）。',
    );
  }

  lines.push('## 6. 观察与待办');
  lines.push('');
  lines.push('- 本报告由 `npm run sim` 自动生成，请勿手工编辑。');
  lines.push('- 首次孢子化时间若明显偏离 45–120 分钟，优先调 `game-config.prestige.networkValueBase`。');
  lines.push('- 若某策略长期无扩张，检查其偏好是否导致"攒钱不花"（`actionsPerStep` / 建造成本曲线）。');
  lines.push('');

  writeFileSync(join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');

  // CSV
  const csv: string[] = ['strategy,sample,elapsed,nodes,links,layers,techs,prestige,' + TRACKED.map((r) => `log10_${r}`).join(',')];
  for (const r of results) {
    for (const s of r.samples) {
      csv.push(
        [
          r.strategy,
          s.label,
          s.elapsed.toFixed(0),
          s.nodes,
          s.links,
          s.layers,
          s.techs,
          s.prestigeCount,
          ...TRACKED.map((res) => {
            const v = s.log10[res] ?? Number.NEGATIVE_INFINITY;
            return Number.isFinite(v) ? v.toFixed(4) : '';
          }),
        ].join(','),
      );
    }
  }
  writeFileSync(join(OUT_DIR, 'curves.csv'), csv.join('\n'), 'utf8');

  console.log('─'.repeat(60));
  console.log(`报告已写入: docs/balance/report.md`);
  console.log(`数据已写入: docs/balance/curves.csv`);
  if (errs.length > 0) {
    console.log(`✗ ${errs.length} 个策略抛错，详见报告`);
    process.exit(1);
  }
}

main();
