import type { LineageGraph, LineageNode } from '@mmt/contracts';

// Fixed node dimensions keep the dense graph readable next to the tracking tables.
export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 66;
const GRAPH_COLUMN_GAP = 90;
const GRAPH_ROW_GAP = 30;
const GRAPH_PADDING = 30;
export interface PositionedNode extends LineageNode {
  x: number;
  y: number;
}
export function layoutLineage(graph: LineageGraph) {
  const ranks = new Map(graph.nodes.map((node) => [node.id, 0]));
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (!id) continue;
    for (const target of outgoing.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  // Cyclic references keep their assigned rank; rendering never waits for a DAG.
  const rowsByRank = new Map<number, number>();
  const nodes: PositionedNode[] = graph.nodes.map((node) => {
    const rank = ranks.get(node.id) ?? 0;
    const row = rowsByRank.get(rank) ?? 0;
    rowsByRank.set(rank, row + 1);
    return {
      ...node,
      x: GRAPH_PADDING + rank * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y: GRAPH_PADDING + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
    };
  });
  return {
    nodes,
    width: Math.max(700, ...nodes.map((node) => node.x + GRAPH_NODE_WIDTH + GRAPH_PADDING)),
    height: Math.max(300, ...nodes.map((node) => node.y + GRAPH_NODE_HEIGHT + GRAPH_PADDING)),
  };
}
export function lineageNodeUrl(projectId: string, node: LineageNode): string {
  const base = `/projects/${projectId}`;
  if (node.kind === 'run') return `${base}/runs/${encodeURIComponent(node.id)}`;
  const registry =
    node.kind === 'modelVersion' ? 'models' : node.kind === 'codeVersion' ? 'codes' : 'datasets';
  return `${base}/${registry}?version=${encodeURIComponent(node.id)}`;
}
