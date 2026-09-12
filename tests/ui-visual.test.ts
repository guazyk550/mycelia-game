/**
 * UI 视觉规则测试（反馈 #4：同类节点必须可分辨）。
 *
 * 这些是纯函数，跑在 Node 里没有 DOM 依赖，因此可以固化"视觉编码"的约束：
 *   形状 → 节点类 ｜ 色相 → 类型（同类型稳定、跨类型不同）｜ 字符 → 类型名首字
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGameData, defaultDataDir } from '../src/data/node-source.ts';
import { CLASS_SHAPE, CLASS_HSL, nodeColor, nodeGlyph, hashString } from '../src/ui/theme.ts';

const data = loadGameData(defaultDataDir());

test('形状映射覆盖全部节点类', () => {
  const classes = new Set([...data.nodes.values()].map((n) => n.def.class));
  for (const cls of classes) {
    assert.ok(CLASS_SHAPE[cls], `节点类 ${cls} 缺少形状映射`);
    assert.ok(CLASS_HSL[cls], `节点类 ${cls} 缺少基色`);
  }
  // 每个类必须有互不相同的形状（否则"形状 = 类"这层编码失效）
  const shapes = Object.values(CLASS_SHAPE);
  assert.equal(new Set(shapes).size, shapes.length, `形状存在重复：${shapes.join(',')}`);
});

test('同类型的颜色稳定、跨类型颜色不同', () => {
  const ids = [...data.nodes.keys()];
  const colorOf = (id: string): string => nodeColor(id, data.nodes.get(id)!.def.class);
  // 稳定性：同一类型两次取色一致
  for (const id of ids) assert.equal(colorOf(id), colorOf(id));
  // 区分度：可分辨的颜色数量应接近类型数量（允许少量哈希碰撞，但不应大面积重复）
  const colors = new Set(ids.map(colorOf));
  assert.ok(colors.size >= ids.length * 0.75, `${ids.length} 个类型只有 ${colors.size} 种颜色（区分度不足）`);
});

test('同一个类下的不同类型也不会同色（这条正是反馈 #4 的核心）', () => {
  const byClass = new Map<string, string[]>();
  for (const [id, node] of data.nodes) {
    const list = byClass.get(node.def.class) ?? [];
    list.push(id);
    byClass.set(node.def.class, list);
  }
  for (const [cls, ids] of byClass) {
    if (ids.length < 3) continue;
    const colors = new Set(ids.map((id) => nodeColor(id, cls)));
    assert.ok(
      colors.size >= Math.ceil(ids.length * 0.7),
      `类 ${cls} 下 ${ids.length} 个类型只有 ${colors.size} 种颜色`,
    );
  }
});

test('标识字符取类型名首字，且同类节点的字符不完全相同', () => {
  assert.equal(nodeGlyph('掘进菌柄 I'), '掘');
  assert.equal(nodeGlyph('分解丝 I'), '分');
  assert.equal(nodeGlyph('吸水菌丝 I'), '吸');
  const extractors = [...data.nodes.values()].filter((n) => n.def.class === 'extractor');
  const glyphs = new Set(extractors.map((n) => nodeGlyph(n.def.name)));
  // I/II/III 三级同名 → 字符会重复，但至少 3 个不同家族应产生不同字符
  assert.ok(glyphs.size >= 3, `采集类只有 ${glyphs.size} 种标识字符`);
});

test('哈希分布均匀（不出现所有类型挤在一个色相区间）', () => {
  const offsets = [...data.nodes.keys()].map((id) => (hashString(id) % 41) - 20);
  const unique = new Set(offsets);
  assert.ok(unique.size >= 15, `色相偏移只有 ${unique.size} 个不同值`);
  const positive = offsets.filter((o) => o > 0).length;
  const negative = offsets.filter((o) => o < 0).length;
  assert.ok(positive > 0 && negative > 0, '偏移应双向分布，否则整体色相会系统性偏色');
});
