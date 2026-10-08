import type { LineageGraph, LineageNode } from '@mmt/contracts';

// Fixed node dimensions keep the dense graph readable next to the tracking tables.
export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 66;
const GRAPH_COLUMN_GAP = 90;
const GRAPH_ROW_GAP = 30;
const GRAPH_PADDING = 30;
// A relation that skips columns passes through an empty slot this tall in each column it crosses,
// so its line runs between nodes instead of behind them.
const GRAPH_PASSAGE_HEIGHT = 24;
// Down and up sweeps of the barycenter ordering; a few are enough for Project-sized graphs.
const ORDERING_SWEEPS = 4;
// The width a band such as the model version page needs even with one or two nodes.
const GRAPH_MIN_WIDTH = 700;

export interface PositionedNode extends LineageNode {
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The line of one relation: from the source's right edge, through passages, to the target. */
export interface RoutedEdge {
  source: string;
  target: string;
  relation: string;
  points: Point[];
}

interface Slot {
  id: string;
  node: LineageNode | null;
  y: number;
}

function assignRanks(graph: LineageGraph): Map<string, number> {
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
  return ranks;
}

const columnX = (rank: number) => GRAPH_PADDING + rank * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP);

/**
 * Columns by rank (longest path from a root), with a passage slot wherever a relation skips a
 * column, ordered within each column by the mean position of the neighbours (barycenter) so that
 * related nodes sit side by side and lines cross less.
 */
export function layoutLineage(graph: LineageGraph) {
  const ranks = assignRanks(graph);
  const columns: string[][] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const rankOf = new Map(ranks);
  const place = (id: string, rank: number) => {
    rankOf.set(id, rank);
    (columns[rank] ??= []).push(id);
  };
  for (const node of graph.nodes) place(node.id, ranks.get(node.id) ?? 0);
  // Each edge becomes a chain of ids, one per column it touches.
  const chains = graph.edges
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    .map((edge, index) => {
      const from = ranks.get(edge.source) ?? 0;
      const to = ranks.get(edge.target) ?? 0;
      const chain = [edge.source];
      for (let rank = from + 1; rank < to; rank++) {
        const passage = `passage:${index}:${rank}`;
        place(passage, rank);
        chain.push(passage);
      }
      chain.push(edge.target);
      return { edge, chain };
    });
  const neighbours = { before: new Map<string, string[]>(), after: new Map<string, string[]>() };
  // Only links between adjacent columns order the columns; a relation back to an earlier or the
  // same column (a cycle) is drawn but does not take part.
  const link = (links: Map<string, string[]>, from: string, to: string) =>
    links.set(from, [...(links.get(from) ?? []), to]);
  for (const { chain } of chains)
    for (let index = 1; index < chain.length; index++) {
      const left = chain[index - 1]!;
      const right = chain[index]!;
      if (rankOf.get(right) !== (rankOf.get(left) ?? 0) + 1) continue;
      link(neighbours.before, right, left);
      link(neighbours.after, left, right);
    }
  orderColumns(columns, neighbours);
  const slots = new Map<string, Slot & { rank: number }>();
  columns.forEach((column, rank) => {
    let y = GRAPH_PADDING;
    for (const id of column ?? []) {
      const node = nodeById.get(id) ?? null;
      slots.set(id, { id, node, y, rank });
      y += (node ? GRAPH_NODE_HEIGHT : GRAPH_PASSAGE_HEIGHT) + GRAPH_ROW_GAP;
    }
  });
  const nodes: PositionedNode[] = graph.nodes.map((node) => {
    const slot = slots.get(node.id)!;
    return { ...node, x: columnX(slot.rank), y: slot.y };
  });
  const centerY = (slot: Slot) =>
    slot.y + (slot.node ? GRAPH_NODE_HEIGHT : GRAPH_PASSAGE_HEIGHT) / 2;
  const edges: RoutedEdge[] = chains.map(({ edge, chain }) => {
    const points: Point[] = [];
    chain.forEach((id, index) => {
      const slot = slots.get(id)!;
      const x = columnX(slot.rank);
      const y = centerY(slot);
      if (index === 0) points.push({ x: x + GRAPH_NODE_WIDTH, y });
      else if (index === chain.length - 1) points.push({ x, y });
      else points.push({ x, y }, { x: x + GRAPH_NODE_WIDTH, y });
    });
    return { source: edge.source, target: edge.target, relation: edge.relation, points };
  });
  const bottoms = [...slots.values()].map(
    (slot) => slot.y + (slot.node ? GRAPH_NODE_HEIGHT : GRAPH_PASSAGE_HEIGHT),
  );
  return {
    nodes,
    edges,
    width: Math.max(GRAPH_MIN_WIDTH, ...nodes.map((node) => node.x + GRAPH_NODE_WIDTH + GRAPH_PADDING)),
    // As tall as the content: a one-row band leaves no empty space below it.
    height: Math.max(0, ...bottoms) + GRAPH_PADDING,
  };
}

function orderColumns(
  columns: string[][],
  neighbours: { before: Map<string, string[]>; after: Map<string, string[]> },
): void {
  const positionIn = (column: string[] | undefined) =>
    new Map((column ?? []).map((id, index) => [id, index]));
  const reorder = (rank: number, adjacentRank: number, links: Map<string, string[]>) => {
    const column = columns[rank];
    if (!column) return;
    const adjacent = positionIn(columns[adjacentRank]);
    const current = positionIn(column);
    const weight = (id: string) => {
      const positions = (links.get(id) ?? [])
        .map((other) => adjacent.get(other))
        .filter((value): value is number => value !== undefined);
      // Without neighbours on that side a node keeps its place.
      return positions.length
        ? positions.reduce((sum, value) => sum + value, 0) / positions.length
        : current.get(id)!;
    };
    const weights = new Map(column.map((id) => [id, weight(id)]));
    column.sort(
      (left, right) => weights.get(left)! - weights.get(right)! || current.get(left)! - current.get(right)!,
    );
  };
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep++) {
    for (let rank = 1; rank < columns.length; rank++) reorder(rank, rank - 1, neighbours.before);
    for (let rank = columns.length - 2; rank >= 0; rank--) reorder(rank, rank + 1, neighbours.after);
  }
}

/** Long names keep their start and end, so names that share a prefix stay distinguishable. */
export function shortenLineageLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label;
  const tail = Math.floor((maxLength - 1) / 3);
  const head = maxLength - 1 - tail;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

export function lineageNodeUrl(projectId: string, node: LineageNode): string {
  const base = `/projects/${projectId}`;
  if (node.kind === 'run') return `${base}/runs/${encodeURIComponent(node.id)}`;
  if (node.kind === 'loggedModel')
    return node.sourceRunId
      ? `${base}/runs/${encodeURIComponent(node.sourceRunId)}?tab=artifacts`
      : `${base}/artifacts`;
  const registry =
    node.kind === 'modelVersion' ? 'models' : node.kind === 'codeVersion' ? 'codes' : 'datasets';
  return `${base}/${registry}?version=${encodeURIComponent(node.id)}`;
}
