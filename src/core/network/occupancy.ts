/**
 * 网格占位系统（反馈 #6：节点不能重叠放置）。
 *
 * 设计取舍：
 *   · 节点吸附到网格中心，而不是自由坐标 —— 这样"重叠"在结构上就不可能发生，
 *     选中与拖拽也变成确定性的格子操作；
 *   · 落点被占用时**自动移位到最近空格**（螺旋搜索），而不是直接失败 ——
 *     玩家点哪就放哪附近，不会因为差几个像素而白点；UI 会预先高亮真实落点。
 */

import type { GameState } from '../state.ts';

/** 网格单元边长（世界坐标）；最大节点直径 44，留一点呼吸空间 */
export const TILE_SIZE = 46;

export type Tile = { x: number; y: number };

export function tileKeyOf(x: number, y: number): string {
  return `${x / TILE_SIZE | 0},${y / TILE_SIZE | 0}`;
}

/** 把任意世界坐标吸附到最近的格中心 */
export function snapToTile(x: number, y: number): Tile {
  const col = Math.round(x / TILE_SIZE);
  const row = Math.round(y / TILE_SIZE);
  return { x: col * TILE_SIZE, y: row * TILE_SIZE };
}

/** 当前已被占用的格集合 */
export function occupiedTiles(state: GameState): Set<string> {
  const set = new Set<string>();
  for (const node of state.graph.nodes.values()) {
    const t = snapToTile(node.x, node.y);
    set.add(tileKeyOf(t.x, t.y));
  }
  return set;
}

export function isTileFree(state: GameState, x: number, y: number, occupied?: Set<string>): boolean {
  const set = occupied ?? occupiedTiles(state);
  return !set.has(tileKeyOf(x, y));
}

/**
 * 从 (x, y) 出发按环向外扩，找最近的空格。
 * 返回**吸附后的坐标**；maxRadius 用尽仍无空位时返回 null（由调用方决定怎么报错）。
 */
export function findNearestFreeTile(
  occupied: Set<string>,
  x: number,
  y: number,
  maxRadius = 8,
): Tile | null {
  const baseCol = Math.round(x / TILE_SIZE);
  const baseRow = Math.round(y / TILE_SIZE);
  for (let r = 0; r <= maxRadius; r++) {
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        // 只遍历第 r 层环，保证"最近"语义
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const col = baseCol + dc;
        const row = baseRow + dr;
        if (!occupied.has(`${col},${row}`)) return { x: col * TILE_SIZE, y: row * TILE_SIZE };
      }
    }
  }
  return null;
}

/** 为建造解析最终落点：先吸附，若被占用则找最近空格 */
export function resolvePlacement(
  state: GameState,
  x: number,
  y: number,
): { tile: Tile; shifted: boolean } | null {
  const occupied = occupiedTiles(state);
  const snapped = snapToTile(x, y);
  if (!occupied.has(tileKeyOf(snapped.x, snapped.y))) return { tile: snapped, shifted: false };
  const free = findNearestFreeTile(occupied, snapped.x, snapped.y);
  return free ? { tile: free, shifted: true } : null;
}

/** 为**移动已有节点**解析落点：与建造同规则，但要从占用集合里排除自己 */
export function resolveMoveTarget(
  state: GameState,
  nodeId: string,
  x: number,
  y: number,
): { tile: Tile; shifted: boolean } | null {
  const node = state.graph.nodes.get(nodeId);
  if (!node) return null;
  const occupied = occupiedTiles(state);
  const self = snapToTile(node.x, node.y);
  occupied.delete(tileKeyOf(self.x, self.y));
  const snapped = snapToTile(x, y);
  if (!occupied.has(tileKeyOf(snapped.x, snapped.y))) return { tile: snapped, shifted: false };
  const free = findNearestFreeTile(occupied, snapped.x, snapped.y);
  return free ? { tile: free, shifted: true } : null;
}
