/**
 * 网络图：节点 / 连线 / 拓扑序。
 *
 * 结算确定性依赖两点：
 *   1. topoOrder() 的顺序只由插入序与 id 决定（无随机、无 Map 迭代玄学）；
 *   2. 环内节点单独标记，结算时改用 tick 起始快照（见 docs/balance-model.md §3）。
 */

export interface NodeInstance {
  id: string;
  typeId: string;
  layerId: string;
  x: number;
  y: number;
  active: boolean;
  built: boolean;
  /** 本地块富饶度 0–100（只有采掘节点会消耗它） */
  richness: number;
  /** 地块轮作次数（土壤记忆科技用） */
  rotationSwaps: number;
}

export interface LinkInstance {
  id: string;
  from: string;
  to: string;
  /** 通量上限（SciNum 序列化字符串）；0 表示未限制 */
  fluxCap: string;
}

export interface TopoResult {
  order: string[];
  /** 处于环上的节点（Kahn 无法定序） */
  cyclic: Set<string>;
}

export class NetworkGraph {
  readonly nodes = new Map<string, NodeInstance>();
  readonly links = new Map<string, LinkInstance>();
  private inLinks = new Map<string, string[]>();
  private outLinks = new Map<string, string[]>();

  addNode(inst: NodeInstance): void {
    if (this.nodes.has(inst.id)) throw new Error(`graph: 节点 id 重复 ${inst.id}`);
    this.nodes.set(inst.id, inst);
    this.inLinks.set(inst.id, []);
    this.outLinks.set(inst.id, []);
  }

  addLink(inst: LinkInstance): void {
    if (this.links.has(inst.id)) throw new Error(`graph: 连线 id 重复 ${inst.id}`);
    if (!this.nodes.has(inst.from)) throw new Error(`graph: 连线起点不存在 ${inst.from}`);
    if (!this.nodes.has(inst.to)) throw new Error(`graph: 连线终点不存在 ${inst.to}`);
    if (inst.from === inst.to) throw new Error('graph: 不允许自环');
    for (const lid of this.inLinks.get(inst.to) ?? []) {
      const l = this.links.get(lid)!;
      if (l.from === inst.from) throw new Error(`graph: 重复连线 ${inst.from} -> ${inst.to}`);
    }
    this.links.set(inst.id, inst);
    this.inLinks.get(inst.to)!.push(inst.id);
    this.outLinks.get(inst.from)!.push(inst.id);
  }

  removeNode(id: string): void {
    if (!this.nodes.has(id)) return;
    for (const lid of [...(this.inLinks.get(id) ?? []), ...(this.outLinks.get(id) ?? [])]) this.removeLink(lid);
    this.nodes.delete(id);
    this.inLinks.delete(id);
    this.outLinks.delete(id);
  }

  removeLink(id: string): void {
    const l = this.links.get(id);
    if (!l) return;
    this.inLinks.set(l.to, (this.inLinks.get(l.to) ?? []).filter((x) => x !== id));
    this.outLinks.set(l.from, (this.outLinks.get(l.from) ?? []).filter((x) => x !== id));
    this.links.delete(id);
  }

  inDegree(nodeId: string): number {
    return this.inLinks.get(nodeId)?.length ?? 0;
  }

  outDegree(nodeId: string): number {
    return this.outLinks.get(nodeId)?.length ?? 0;
  }

  inLinkIds(nodeId: string): readonly string[] {
    return this.inLinks.get(nodeId) ?? [];
  }

  outLinkIds(nodeId: string): readonly string[] {
    return this.outLinks.get(nodeId) ?? [];
  }

  neighbours(nodeId: string): string[] {
    const out: string[] = [];
    for (const lid of this.inLinkIds(nodeId)) out.push(this.links.get(lid)!.from);
    for (const lid of this.outLinkIds(nodeId)) out.push(this.links.get(lid)!.to);
    return out;
  }

  /** 连通度：与节点相连的其它节点数量（电信号节点的门槛用它） */
  connectivity(nodeId: string): number {
    return this.inDegree(nodeId) + this.outDegree(nodeId);
  }

  /**
   * 拓扑序（Kahn）。返回的顺序是下游在后的稳定顺序；
   * 无法定序的节点（环上）按 id 升序追加到末尾，并列入 cyclic 集合。
   */
  topoOrder(): TopoResult {
    const indeg = new Map<string, number>();
    for (const id of this.nodes.keys()) indeg.set(id, 0);
    for (const l of this.links.values()) indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);

    const queue: string[] = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);

    const order: string[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      seen.add(id);
      for (const lid of this.outLinkIds(id)) {
        const l = this.links.get(lid)!;
        const d = (indeg.get(l.to) ?? 0) - 1;
        indeg.set(l.to, d);
        if (d === 0) queue.push(l.to);
      }
    }

    const cyclic = new Set<string>();
    if (order.length < this.nodes.size) {
      const rest = [...this.nodes.keys()].filter((id) => !seen.has(id)).sort();
      for (const id of rest) {
        cyclic.add(id);
        order.push(id);
      }
    }
    return { order, cyclic };
  }

  /** 检测所有环（返回每个强连通分量内的节点集合），用于成就与挑战判定 */
  findCycles(): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];
    let counter = 0;

    const strongConnect = (v: string): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      for (const lid of this.outLinkIds(v)) {
        const w = this.links.get(lid)!.to;
        if (!index.has(w)) {
          strongConnect(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === v) break;
        }
        // 单节点分量只有在存在自环时才算环（自环被禁止，故直接排除）
        if (comp.length > 1) result.push(comp.reverse());
      }
    };

    for (const v of this.nodes.keys()) if (!index.has(v)) strongConnect(v);
    return result;
  }

  /** 图中节点总数（用于上限检查） */
  size(): number {
    return this.nodes.size;
  }

  /** 按层统计节点数量 */
  countByLayer(layerId: string): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.layerId === layerId) n++;
    return n;
  }
}
