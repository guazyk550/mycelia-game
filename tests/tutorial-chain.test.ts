/**
 * 新手引导链的可达性验收（PHASE 5 反馈修复）。
 *
 * 起因：玩家反馈"第十一步引导直接要求产出一个共生核心，但科技树显示未解锁，
 * 然后它需要核心腔，我又不知道核心腔是个什么东西"。
 *
 * 实测确认：引导链从"研究 1 个科技"直接跳到"产出共生核心"，中间漏了
 * 酶腺 II → 菌核压机 → 核心腔 三步，而这三步各自还有 40 酶 / 500 酶 / 5 晶格 的门槛。
 *
 * 这组测试保证：① 每一步的前置都真实存在于链上；② 每一步的目标节点在当前可解锁范围内；
 * ③ 每一步都写了"怎么做"（hint），不会让玩家面对一句氛围描述发呆。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameData } from '../src/data/node-source.ts';

const data = loadGameData();
const tutorial = [...data.quests.values()].filter((q) => q.cat === 'tutorial');
const byId = new Map(tutorial.map((q) => [q.id, q]));

test('引导链：每一步的 requires 都指向链上真实存在的任务', () => {
  for (const q of tutorial) {
    for (const r of q.requires) {
      assert.ok(byId.has(r), `${q.id} 的前置 ${r} 不存在于新手链上`);
    }
  }
});

test('引导链：不存在环形依赖（否则玩家永远走不到那一步）', () => {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return;
    assert.ok(!visiting.has(id), `引导链出现环：${[...path, id].join(' → ')}`);
    visiting.add(id);
    for (const r of byId.get(id)?.requires ?? []) visit(r, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const q of tutorial) visit(q.id, []);
});

test('引导链：每一步都有前置（除第一步）—— 不存在可以同时触发的孤儿步骤', () => {
  const roots = tutorial.filter((q) => q.requires.length === 0);
  assert.equal(roots.length, 1, `新手链应只有一个起点，实际有 ${roots.length} 个：${roots.map((r) => r.id).join(', ')}`);
});

test('引导链：孢子化的门票之前，必须经过酶 → 压机 → 核心腔（玩家踩过的断层）', () => {
  const core = byId.get('q_core_ready');
  assert.ok(core, '缺少"孢子化的门票"这一步');

  // 沿前置一路回溯，必须能遇到那三个节点
  const needed = new Set(['enzyme_gland_ii', 'sclerotium_press', 'core_chamber']);
  const seenNodes = new Set<string>();
  const walk = (id: string): void => {
    const q = byId.get(id);
    if (!q) return;
    if (q.goal.node) seenNodes.add(q.goal.node);
    for (const r of q.requires) walk(r);
  };
  walk(core.id);

  for (const nodeId of needed) {
    assert.ok(
      seenNodes.has(nodeId),
      `孢子化的门票之前缺少一步要求建造 ${data.nodes.get(nodeId)?.def.name ?? nodeId} —— 这正是玩家卡住的地方`,
    );
  }
});

test('引导链：每一步的目标节点都真的存在，且解锁门槛是可达的', () => {
  for (const q of tutorial) {
    if (q.goal.kind !== 'buildNode' || !q.goal.node) continue;
    const node = data.nodes.get(q.goal.node);
    assert.ok(node, `${q.id} 指向不存在的节点 ${q.goal.node}`);
    const u = node.def.unlock;
    // 解锁条件必须是"资源累计/层解锁/prestige/start"这几类可达形态
    assert.ok(
      ['start', 'resource', 'layer', 'tech', 'prestige'].includes(u.type),
      `${q.id} 的目标节点解锁类型 ${u.type} 不在引导链可达范围内`,
    );
  }
});

test('引导链：每一步都写了"怎么做"（hint），不只是氛围描述', () => {
  const missing: string[] = [];
  for (const q of tutorial) {
    if (!q.hint || q.hint.length < 10) missing.push(q.name);
  }
  assert.equal(missing.length, 0, `以下步骤缺少"怎么做"的提示：${missing.join('、')}`);
});

test('引导链：孢子化的门票本身也要有 hint（它是最容易卡住的一步）', () => {
  const core = byId.get('q_core_ready')!;
  assert.ok(core.hint && core.hint.includes('核心'), `孢子化的门票应说明核心怎么来，实际：${core.hint}`);
});
