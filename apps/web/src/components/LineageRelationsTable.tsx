import type { LineageGraph } from '@mmt/contracts';
import { lineageRelationLabels, text } from '../i18n/catalog';

/** Every relation of the graph as source → relation → target rows, folded under a summary. */
export function LineageRelationsTable({
  graph,
  initiallyOpen,
}: {
  graph: LineageGraph;
  initiallyOpen: boolean;
}) {
  const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return (
    <details className="graph-relations" open={initiallyOpen}>
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
                <td>{labelById.get(edge.source) ?? edge.source}</td>
                <td className="nowrap">{lineageRelationLabels[edge.relation] ?? edge.relation}</td>
                <td>{labelById.get(edge.target) ?? edge.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
