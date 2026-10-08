import { useMemo, type ReactNode } from 'react';
import type { LineageGraph as Graph } from '@mmt/contracts';
import { narrowerThan } from '../lib/breakpoints';
import { layoutLineage } from '../lib/lineageLayout';
import { useMediaQuery } from '../lib/useMediaQuery';
import { Empty } from './Feedback';
import { LineageDiagramViewport } from './LineageDiagramViewport';
import { LineageRelationsTable } from './LineageRelationsTable';
import { text } from '../i18n/catalog';

/**
 * The lineage diagram and its relations table. Below --bp-md the diagram is too small to read
 * first, so the relations table leads (open) and the diagram follows, fitted to the width.
 */
export function LineageGraph({ graph, projectId }: { graph: Graph; projectId: string }) {
  const isNarrow = useMediaQuery(narrowerThan('md'));
  const layout = useMemo(() => layoutLineage(graph), [graph]);
  if (!graph.nodes.length) return <Empty>{text.graphEmpty}</Empty>;
  return (
    <LineageGraphLayout isNarrow={isNarrow}
      diagram={<LineageDiagramViewport layout={layout} projectId={projectId} fitOnOpen={isNarrow} />}
      relations={<LineageRelationsTable graph={graph} initiallyOpen={isNarrow} />}
    />
  );
}

/** The order of the parts for a known width; LineageGraph passes the current one. */
export function LineageGraphLayout({
  isNarrow,
  diagram,
  relations,
}: {
  isNarrow: boolean;
  diagram: ReactNode;
  relations: ReactNode;
}) {
  return (
    <div className={isNarrow ? 'lineage-graph narrow' : 'lineage-graph'}>
      <div className="lineage-legend">{text.graphLegend}</div>
      {isNarrow ? relations : diagram}
      {isNarrow ? diagram : relations}
    </div>
  );
}
