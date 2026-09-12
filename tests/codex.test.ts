import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { buildCodex, summarizeEntry } from '../src/core/progression/codex.ts';

const data = loadGameData(defaultDataDir());
const codex = buildCodex(data);
const byId = new Map(codex.map((e) => [e.resourceId, e]));

test('索引覆盖所有非隐藏资源，且不含隐藏资源', () => {
  const visible = [...data.resources.values()].filter((r) => !r.def.hidden).map((r) => r.def.id);
  assert.equal(codex.length, visible.length, `期望 ${visible.length} 条，实际 ${codex.length}`);
  for (const id of visible) assert.ok(byId.has(id), `缺少资源 ${id}`);
  // 隐藏资源必须缺席（保持发现感）
  assert.equal(byId.has('voidspore'), false);
  assert.equal(byId.has('echo'), false);
});

test('产出者与数据表逐条一致', () => {
  for (const entry of codex) {
    const expected = [...data.nodes.values()].filter((n) => n.recipe.outputs.some((o) => o.res === entry.resourceId));
    assert.equal(entry.producers.length, expected.length, `${entry.resourceId} 产出者数量不符`);
    for (const p of entry.producers) {
      const node = data.nodes.get(p.nodeId);
      assert.ok(node, `${entry.resourceId} 的产出者 ${p.nodeId} 不存在`);
      assert.equal(node!.def.name, p.nodeName);
      assert.equal(node!.def.layer, p.layer);
      assert.ok(node!.recipe.outputs.some((o) => o.res === entry.resourceId), `${p.nodeId} 实际不产出 ${entry.resourceId}`);
    }
  }
});

test('消耗者与数据表逐条一致', () => {
  for (const entry of codex) {
    const expected = [...data.nodes.values()].filter((n) => n.recipe.inputs.some((i) => i.res === entry.resourceId));
    assert.equal(entry.consumers.length, expected.length, `${entry.resourceId} 消耗者数量不符`);
    for (const c of entry.consumers) {
      const node = data.nodes.get(c.nodeId);
      assert.ok(node);
      assert.ok(node!.recipe.inputs.some((i) => i.res === entry.resourceId));
      assert.equal(node!.def.class, c.nodeClass);
    }
  }
});

test('催化互动映射正确：provides 的 tag 必须等于产出该资源的某个节点的 catalystTag', () => {
  for (const entry of codex) {
    const tags = new Set(entry.producers.map((p) => p.catalystTag));
    for (const rule of entry.provides) {
      assert.ok(tags.has(rule.tag), `${entry.resourceId} 宣称 ${rule.tag} 能催化，但没有该 tag 的产出者`);
    }
  }
});

test('催化互动映射正确：receives 的 targetClass 必须等于某个消耗者的节点类', () => {
  for (const entry of codex) {
    const classes = new Set(entry.consumers.map((c) => c.nodeClass));
    for (const rule of entry.receives) {
      assert.ok(
        classes.has(rule.targetClass) || rule.targetClass === '*',
        `${entry.resourceId} 宣称会被 ${rule.targetClass} 类消费时加成，但无此类消耗者`,
      );
    }
  }
});

test('每条催化互动都能在催化矩阵里找到对应规则（倍率与说明一致）', () => {
  const rules = data.raw.catalystMatrix.rules;
  for (const entry of codex) {
    for (const r of [...entry.provides, ...entry.receives]) {
      const hit = rules.some((rule) => rule.upstreamTag === r.tag && rule.downstreamClass === r.targetClass && Math.abs(rule.rateMul - r.rateMul) < 1e-9);
      assert.ok(hit, `${entry.resourceId} 的催化 ${r.tag}→${r.targetClass} 在矩阵中不存在`);
    }
  }
});

test('索引按 tier 升序排列', () => {
  for (let i = 1; i < codex.length; i++) {
    assert.ok(codex[i]!.tier >= codex[i - 1]!.tier, `排序错误：${codex[i - 1]!.resourceId} → ${codex[i]!.resourceId}`);
  }
});

test('每个非 Prestige/Meta 资源都有至少一个产出者（否则玩家永远拿不到）', () => {
  for (const entry of codex) {
    if (entry.tier >= 4) continue; // 孢子基因/星尘等由机制产出，不是节点
    assert.ok(entry.producers.length > 0, `${entry.name} 没有任何产出者`);
  }
});

test('总结文案可读且不为空', () => {
  for (const entry of codex) {
    const text = summarizeEntry(entry);
    assert.ok(text.length > 0);
  }
});
