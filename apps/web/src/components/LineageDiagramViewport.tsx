import { useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useDragToScroll } from '../hooks/useDragToScroll';
import { useElementWidth } from '../hooks/useElementWidth';
import type { layoutLineage } from '../lib/lineageLayout';
import { fitLineageZoom, openingLineageZoom, stepLineageZoom } from '../lib/lineageZoom';
import { LineageDiagram } from './LineageDiagram';
import { lineageText } from '../i18n/lineage';

/**
 * The diagram in a scrolling viewport with zoom buttons. Drag (mouse) or swipe (touch) pans it.
 * With fitOnOpen the first view fits the width as far as the labels stay readable.
 */
export function LineageDiagramViewport({
  layout,
  projectId,
  fitOnOpen,
}: {
  layout: ReturnType<typeof layoutLineage>;
  projectId: string;
  fitOnOpen: boolean;
}) {
  const viewport = useElementWidth();
  const dragHandlers = useDragToScroll<HTMLDivElement>();
  // null until the reader zooms: the default follows the viewport width as it is measured.
  const [chosenZoom, setChosenZoom] = useState<number | null>(null);
  const fittedZoom = fitLineageZoom(viewport.width, layout.width);
  const zoom = chosenZoom ?? (fitOnOpen ? openingLineageZoom(viewport.width, layout.width) : 1);
  return (
    <div className="lineage-viewport">
      <div className="lineage-zoom-controls" role="toolbar" aria-label={lineageText.lineageZoomLevel}>
        <button
          type="button"
          className="icon-button"
          aria-label={lineageText.lineageZoomOut}
          onClick={() => setChosenZoom(stepLineageZoom(zoom, 'out'))}
        >
          <ZoomOut size={17} />
        </button>
        <output className="lineage-zoom-level" aria-label={lineageText.lineageZoomLevel}>
          {Math.round(zoom * 100)}%
        </output>
        <button
          type="button"
          className="icon-button"
          aria-label={lineageText.lineageZoomIn}
          onClick={() => setChosenZoom(stepLineageZoom(zoom, 'in'))}
        >
          <ZoomIn size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={lineageText.lineageZoomFit}
          title={lineageText.lineageZoomFit}
          onClick={() => setChosenZoom(fittedZoom)}
        >
          <Maximize2 size={16} />
        </button>
        <span className="muted lineage-pan-hint">{lineageText.lineageDiagramHint}</span>
      </div>
      <div ref={viewport.ref} className="graph-scroll" {...dragHandlers}>
        <LineageDiagram layout={layout} projectId={projectId} zoom={zoom} />
      </div>
    </div>
  );
}
