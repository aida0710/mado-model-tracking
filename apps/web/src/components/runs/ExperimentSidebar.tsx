import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { Experiment } from '@mmt/contracts';
import type { QueryState } from '../../hooks/useQuery';
import { Empty, Resource } from '../Feedback';
import { text, textTemplates } from '../../i18n/catalog';

export function ExperimentSidebar({
  experiments,
  selectedExperimentId,
  canEdit,
  onSelect,
  onCreate,
}: {
  experiments: QueryState<Experiment[]>;
  selectedExperimentId: string;
  canEdit: boolean;
  onSelect: (experimentId: string) => void;
  onCreate: () => void;
}) {
  const [experimentSearch, setExperimentSearch] = useState('');
  return (
    <aside className="experiment-sidebar">
      <div className="sidebar-heading">
        <span>{text.experiments}</span>
        {canEdit && (
          <button className="icon-button" aria-label={text.newExperiment} onClick={onCreate}>
            <Plus size={18} />
          </button>
        )}
      </div>
      <input
        className="sidebar-search"
        aria-label={text.filterExperiments}
        placeholder={text.filterExperiments}
        value={experimentSearch}
        onChange={(event) => setExperimentSearch(event.target.value)}
      />
      <button
        className={`experiment-item ${!selectedExperimentId ? 'active' : ''}`}
        onClick={() => onSelect('')}
      >
        {text.allExperiments}
      </button>
      <Resource query={experiments}>
        {(items) => (
          <>
            {items
              .filter((item) => item.name.toLowerCase().includes(experimentSearch.toLowerCase()))
              .map((item) => (
                <button
                  key={item.id}
                  className={`experiment-item ${item.id === selectedExperimentId ? 'active' : ''}`}
                  onClick={() => onSelect(item.id)}
                >
                  <span>{item.name}</span>
                  <small>{textTemplates.runCount(item.runCount)}</small>
                </button>
              ))}
            {!items.length && <Empty />}
          </>
        )}
      </Resource>
    </aside>
  );
}
