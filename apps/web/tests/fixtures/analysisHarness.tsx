// Mounts RunAnalysisPanel alone for tests/browser-analysis.mjs. The list beside it stands in for
// the Run list that receives the brushed selection; the API is mocked by the browser test.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { RunSet } from '@mmt/contracts';
import { RunAnalysisPanel } from '../../src/components/analysis/RunAnalysisPanel';
import '../../src/styles/base.css';
import '../../src/styles/layout.css';
import '../../src/styles/tables.css';
import '../../src/styles/registry.css';
import '../../src/styles/forms.css';
import '../../src/styles/analysis.css';

const query = new URLSearchParams(location.search);
const projectId = query.get('projectId') ?? 'project';
const runSet: RunSet = query.get('sweepId')
  ? { sweepId: query.get('sweepId')! }
  : { search: { experimentIds: [query.get('experimentId') ?? 'experiment'] } };
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';

function RunListStandIn() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <main style={{ padding: 24, display: 'grid', gap: 16 }}>
      <RunAnalysisPanel projectId={projectId} runSet={runSet} onSelectionChange={setSelected} />
      <output data-testid="run-list-selection" data-count={selected.length}>
        {selected.length}
      </output>
    </main>
  );
}

function RunDetailStandIn() {
  const { runId } = useParams();
  return <h1 data-testid="run-detail">{runId}</h1>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/analysis']}>
      <Routes>
        <Route path="/analysis" element={<RunListStandIn />} />
        <Route path="/projects/:projectId/runs/:runId" element={<RunDetailStandIn />} />
      </Routes>
    </MemoryRouter>
  </StrictMode>,
);
