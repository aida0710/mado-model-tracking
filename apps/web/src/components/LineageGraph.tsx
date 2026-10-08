import { Link } from 'react-router-dom';
import type { LineageGraph as Graph } from '@mmt/contracts';
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  layoutLineage,
  lineageNodeUrl,
  shortenLineageLabel,
  type Point,
} from '../lib/lineageLayout';
import { Empty } from './Feedback';
import { lineageNodeKindLabels, lineageRelationLabels, text } from '../i18n/catalog';

// About what fits in GRAPH_NODE_WIDTH at the label's font size.
const NODE_LABEL_MAX_LENGTH = 28;

// Run nodes carry a RunStatus; other strings are shown as they are.
const runStatusLabels: Record<string, string> = {
  queued: text.queued,
  claimed: text.claimed,
  running: text.running,
  finished: text.finished,
  failed: text.failed,
  canceled: text.canceled,
};
const runStatusLabel = (status: string) => runStatusLabels[status] ?? status;

// Straight through each passage, a curve between columns.
function edgePath(points: Point[]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  let path = `M ${first.x} ${first.y}`;
  let previous = first;
  rest.forEach((point, index) => {
    const isCrossingColumn = index % 2 === 0;
    if (isCrossingColumn) {
      const middleX = (previous.x + point.x) / 2;
      path += ` C ${middleX} ${previous.y}, ${middleX} ${point.y}, ${point.x} ${point.y}`;
    } else path += ` L ${point.x} ${point.y}`;
    previous = point;
  });
  return path;
}

export function LineageGraph({ graph, projectId }: { graph: Graph; projectId: string }) {
  if (!graph.nodes.length) return <Empty>{text.graphEmpty}</Empty>;
  const layout = layoutLineage(graph);
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  return (
    <>
      <div className="lineage-legend">{text.graphLegend}</div>
      <div className="graph-scroll">
        <svg width={layout.width} height={layout.height} aria-label={text.lineage} role="group">
          <defs>
            <marker
              id="lineage-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
            </marker>
          </defs>
          {layout.edges.map((edge, index) => (
            <g key={`${edge.source}:${edge.target}:${index}`}>
              <title>{lineageRelationLabels[edge.relation] ?? edge.relation}</title>
              <path className="graph-edge" d={edgePath(edge.points)} markerEnd="url(#lineage-arrow)" />
            </g>
          ))}
          {layout.nodes.map((node) => (
            <Link
              key={node.id}
              to={lineageNodeUrl(projectId, node)}
              aria-label={`${lineageNodeKindLabels[node.kind]}: ${node.label}`}
            >
              <g
                className={`graph-node node-${node.kind}`}
                transform={`translate(${node.x},${node.y})`}
              >
                <title>{node.label}</title>
                <rect width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx="2" />
                <text x="12" y="23" className="node-kind">
                  {lineageNodeKindLabels[node.kind]}
                  {node.status ? ` · ${runStatusLabel(node.status)}` : ''}
                </text>
                <text x="12" y="46" className="node-label">
                  {shortenLineageLabel(node.label, NODE_LABEL_MAX_LENGTH)}
                </text>
              </g>
            </Link>
          ))}
        </svg>
      </div>
      <details className="graph-relations">
        <summary>
          {text.relations} · {graph.edges.length}
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{text.lineageEdgeSource}</th>
                <th>{text.relations}</th>
                <th>{text.lineageEdgeTarget}</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.map((edge, index) => (
                <tr key={index}>
                  <td>{nodeById.get(edge.source)?.label ?? edge.source}</td>
                  <td>{lineageRelationLabels[edge.relation] ?? edge.relation}</td>
                  <td>{nodeById.get(edge.target)?.label ?? edge.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
