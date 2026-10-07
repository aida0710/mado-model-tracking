import { Link } from 'react-router-dom';
import type { LineageGraph as Graph } from '@mmt/contracts';
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  layoutLineage,
  lineageNodeUrl,
} from '../lib/lineageLayout';
import { Empty } from './Feedback';
import { text } from '../i18n/catalog';

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
          {graph.edges.map((edge, index) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            const startX = source.x + GRAPH_NODE_WIDTH;
            const startY = source.y + GRAPH_NODE_HEIGHT / 2;
            const endX = target.x;
            const endY = target.y + GRAPH_NODE_HEIGHT / 2;
            const middleX = (startX + endX) / 2;
            return (
              <g key={`${edge.source}:${edge.target}:${index}`}>
                <title>{edge.relation}</title>
                <path
                  className="graph-edge"
                  d={`M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`}
                  markerEnd="url(#lineage-arrow)"
                />
              </g>
            );
          })}
          {layout.nodes.map((node) => (
            <Link
              key={node.id}
              to={lineageNodeUrl(projectId, node)}
              aria-label={`${node.kind}: ${node.label}`}
            >
              <g
                className={`graph-node node-${node.kind}`}
                transform={`translate(${node.x},${node.y})`}
              >
                <title>{node.label}</title>
                <rect width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx="2" />
                <text x="12" y="23" className="node-kind">
                  {node.kind}
                  {node.status ? ` · ${node.status}` : ''}
                </text>
                <text x="12" y="46" className="node-label">
                  {node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label}
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
                <th>{text.source}</th>
                <th>{text.relations}</th>
                <th>{text.target}</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.map((edge, index) => (
                <tr key={index}>
                  <td>{nodeById.get(edge.source)?.label ?? edge.source}</td>
                  <td className="mono">{edge.relation}</td>
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
