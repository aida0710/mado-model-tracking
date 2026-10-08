import { describe, expect, it } from 'vitest';
import type { LineageGraph } from '@mmt/contracts';
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutLineage, shortenLineageLabel } from './lineageLayout';

const run = (id: string) => ({ id, kind: 'run' as const, label: id });

describe('layoutLineage', () => {
  it('1行だけの図は、その行の高さで終わり下に空白を残さない', () => {
    const layout = layoutLineage({
      nodes: [run('train'), run('eval')],
      edges: [{ source: 'train', target: 'eval', relation: 'parentRun' }],
    });
    const bottom = Math.max(...layout.nodes.map((node) => node.y + GRAPH_NODE_HEIGHT));
    expect(layout.height - bottom).toBeLessThanOrEqual(30);
  });

  it('列を飛ばす線は、途中の列のノードと重ならない通り道を通る', () => {
    const graph: LineageGraph = {
      nodes: [run('a'), run('b'), run('c')],
      edges: [
        { source: 'a', target: 'b', relation: 'parentRun' },
        { source: 'b', target: 'c', relation: 'parentRun' },
        { source: 'a', target: 'c', relation: 'input' },
      ],
    };
    const layout = layoutLineage(graph);
    const middle = layout.nodes.find((node) => node.id === 'b')!;
    const skipping = layout.edges.find((edge) => edge.source === 'a' && edge.target === 'c')!;
    const throughMiddle = skipping.points.filter((point) => point.x >= middle.x && point.x <= middle.x + GRAPH_NODE_WIDTH);
    expect(throughMiddle.length).toBeGreaterThan(0);
    for (const point of throughMiddle)
      expect(point.y < middle.y || point.y > middle.y + GRAPH_NODE_HEIGHT).toBe(true);
  });

  it('つながるノードを同じ並びに置き、線が交差しないようにする', () => {
    const layout = layoutLineage({
      nodes: [run('a1'), run('a2'), run('b2'), run('b1')],
      edges: [
        { source: 'a1', target: 'b1', relation: 'parentRun' },
        { source: 'a2', target: 'b2', relation: 'parentRun' },
      ],
    });
    const y = (id: string) => layout.nodes.find((node) => node.id === id)!.y;
    expect(y('b1')).toBeLessThan(y('b2'));
  });
});

describe('shortenLineageLabel', () => {
  it('長い名前は先頭と末尾を残すので、同じ前置きの名前を見分けられる', () => {
    const first = shortenLineageLabel('推論出力の音声 run-9233bdc3-3649-43c2-967d-3307fe08d21b', 28);
    const second = shortenLineageLabel('推論出力の音声 run-06882824-f1f5-4b06-8fa9-c40ecf6d1543', 28);
    expect(first).toHaveLength(28);
    expect(first).not.toBe(second);
    expect(first.endsWith('08d21b')).toBe(true);
  });
});
