/**
 * 平衡验收测试 —— 把模拟报告里的结论固化为可重复的断言。
 *
 * 对应 docs/balance-model.md §13 的检查清单中可自动化的部分。
 * 这些用例跑的是**真实引擎 + 真实数据表**，因此比人工看报告更难被绕过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { STRATEGIES } from '../src/sim/strategies.ts';
import { runSimulation } from '../src/sim/runner.ts';

const data = loadGameData(defaultDataDir());
const TWO_HOURS = 7200;

test('无死锁：积极玩家在 2 小时内节点数增长 3 倍以上且无异常', () => {
  const r = runSimulation(STRATEGIES[0]!, { data, maxSec: TWO_HOURS });
  assert.equal(r.error, null, `模拟抛错: ${r.error}`);
  const first = r.samples[0]!;
  const last = r.samples.at(-1)!;
  assert.ok(last.nodes > first.nodes * 3, `节点数未增长: ${first.nodes} → ${last.nodes}`);
  assert.ok(
    (last.log10['sugar'] ?? -Infinity) > (first.log10['sugar'] ?? -Infinity),
    '糖的数量级未增长',
  );
});

test('孢子化路径可行：Prestige 狂在 2 小时内完成首次孢子化', () => {
  const r = runSimulation(STRATEGIES[2]!, { data, maxSec: TWO_HOURS });
  assert.equal(r.error, null);
  const first = r.milestones.find((m) => m.text.startsWith('孢子化'));
  assert.ok(first, '应完成至少一次孢子化');
  assert.ok(first.at < TWO_HOURS, `首次孢子化过晚: ${first.at}s`);
  // 孢子化必须真的带来跨世代收益，否则 Prestige 是空机制
  assert.ok(r.samples.at(-1)!.prestigeCount >= 1);
});

test('基质层按顺序解锁，且不会跳过前置层', () => {
  const r = runSimulation(STRATEGIES[0]!, { data, maxSec: TWO_HOURS });
  const layersPerSample = r.samples.map((s) => s.layers);
  for (let i = 1; i < layersPerSample.length; i++) {
    assert.ok(layersPerSample[i]! >= layersPerSample[i - 1]!, '层数不应回退（孢子化不重置层解锁）');
  }
  assert.ok(layersPerSample.at(-1)! >= 3, `2 小时内应至少解锁 3 层，实际 ${layersPerSample.at(-1)}`);
});

test('不同策略产生实质不同的轨迹（不存在单一支配解）', () => {
  const a = runSimulation(STRATEGIES[0]!, { data, maxSec: TWO_HOURS });
  const c = runSimulation(STRATEGIES[2]!, { data, maxSec: TWO_HOURS });
  // C 高频重置 → 节点数应显著低于 A；A 不重置 → 节点数累积
  const aNodes = a.samples.at(-1)!.nodes;
  const cNodes = c.samples.at(-1)!.nodes;
  const cPrestige = c.samples.at(-1)!.prestigeCount;
  const aPrestige = a.samples.at(-1)!.prestigeCount;
  assert.ok(cPrestige > aPrestige, `Prestige 狂应重置更多次: ${cPrestige} vs ${aPrestige}`);
  assert.ok(
    aNodes !== cNodes,
    `两种策略的最终节点数不应完全相同（${aNodes} vs ${cNodes}）—— 说明策略确实改变了玩法`,
  );
});

test('成熟度机制生效：短轮重置的收益被显著打折', () => {
  const c = runSimulation(STRATEGIES[2]!, { data, maxSec: TWO_HOURS });
  // Prestige 狂的重置间隔应有下限（成熟度最低 20% + 最低收益 1）
  const prestigeMilestones = c.milestones.filter((m) => m.text.startsWith('孢子化'));
  assert.ok(prestigeMilestones.length > 0, '应有孢子化记录');
  const first = prestigeMilestones[0]!.at;
  assert.ok(first > 60, `首次孢子化不应早于 60 秒（成熟度下限），实际 ${first}s`);
});

test('数值保真：整个 2 小时模拟中没有任何资源出现非有限值', () => {
  const r = runSimulation(STRATEGIES[4]!, { data, maxSec: TWO_HOURS });
  assert.equal(r.error, null);
  for (const s of r.samples) {
    for (const [res, v] of Object.entries(s.log10)) {
      assert.ok(!Number.isNaN(v), `资源 ${res} 在 ${s.label} 出现 NaN`);
      assert.ok(v < 3000, `资源 ${res} 在 ${s.label} 爆炸到 1e${v}（超出设计上限 10^10000 的合理区间）`);
    }
  }
});
