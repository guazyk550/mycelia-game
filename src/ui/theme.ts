/**
 * UI 主题与布局常量。所有颜色/尺寸集中在这里，禁止散落在各面板里。
 */

export const THEME = {
  bg: '#08090c',
  panel: '#101318',
  panelAlt: '#161a21',
  border: '#232a35',
  borderHover: '#38414f',
  text: '#d8dee9',
  textDim: '#7b8798',
  textFaint: '#4a5364',
  accent: '#4ade80',
  warn: '#fbbf24',
  danger: '#fb7185',
  link: '#3b4655',
  linkActive: '#4ade80',
  grid: '#12151b',
  selection: '#7dd3fc',

  font: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
  fontMono: "ui-monospace, 'Cascadia Code', Consolas, monospace",

  topbarHeight: 62,
  bottomNavHeight: 44,
  sideWidth: 268,
  rightWidth: 316,
  narrowBreakpoint: 1400,
} as const;

/** 节点类 → 颜色（与数据表的资源配色保持同一色系）；作为形状/色相偏移的基准 */
export const CLASS_COLORS: Record<string, string> = {
  extractor: '#5b8def',
  metabolizer: '#6fcf97',
  sporifier: '#c084fc',
  symbiont: '#fbbf24',
  transmitter: '#22d3ee',
  special: '#fb7185',
  meta: '#fde68a',
};

// ---------------------------------------------------------------- 节点视觉系统
// 反馈 #4：同类节点长得一模一样，无法分辨。三层编码：
//   形状 = 节点类 ｜ 色相 = 类基色 + 类型哈希偏移（±20°）｜ 字符 = 类型名首字
// 这样「掘进菌柄 / 分解丝 / 吸水菌丝」在画布上形状同类但颜色与字符不同，一眼可分。

export type NodeShape = 'hexagon' | 'circle' | 'diamond' | 'petal' | 'triangle' | 'square' | 'star';

export const CLASS_SHAPE: Record<string, NodeShape> = {
  extractor: 'hexagon',
  metabolizer: 'circle',
  sporifier: 'diamond',
  symbiont: 'petal',
  transmitter: 'triangle',
  special: 'square',
  meta: 'star',
};

/** 类基色（HSL，便于按类型做色相偏移） */
export const CLASS_HSL: Record<string, [number, number, number]> = {
  extractor: [218, 60, 62],
  metabolizer: [145, 52, 58],
  sporifier: [272, 66, 70],
  symbiont: [43, 88, 58],
  transmitter: [188, 76, 58],
  special: [350, 80, 66],
  meta: [48, 88, 72],
};

/** 稳定的字符串哈希（用于类型级色相偏移，保证同一类型永远同色） */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

/** 节点类型 → 画布颜色 */
export function nodeColor(typeId: string, cls: string): string {
  const base = CLASS_HSL[cls] ?? [200, 60, 60];
  const offset = (hashString(typeId) % 41) - 20;
  return `hsl(${base[0] + offset}, ${base[1]}%, ${base[2]}%)`;
}

/** 节点类型 → 内部标识字符（数据表名称首字） */
export function nodeGlyph(name: string): string {
  return name.slice(0, 1);
}

/** 节点等级 → 绘制半径 */
export const TIER_RADIUS: Record<number, number> = {
  1: 13,
  2: 17,
  3: 22,
};

/** 层 → 背景色调（深浅表示深度） */
export const LAYER_TINTS: Record<string, string> = {
  topsoil: '#0d1013',
  aquifer: '#0b1117',
  lode: '#111014',
  bedrock: '#0f0d13',
  mantle: '#130d12',
};
