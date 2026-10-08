import { useCallback, useMemo, useRef, useState } from 'react';
import type { Artifact, Run } from '@mmt/contracts';
import { ArrowRightLeft } from 'lucide-react';
import { trackingApi } from '../api/tracking';
import { useQuery } from '../hooks/useQuery';
import { artifactMediaKind } from '../lib/artifactMediaKind';
import { formatBytes } from '../lib/format';
import { DataTable } from './DataTable';
import { Resource } from './Feedback';
import { ArtifactPreview } from './ArtifactPreview';
import { AudioArtifactViewer } from './preview/AudioArtifactViewer';
import { text } from '../i18n/catalog';

interface CommonArtifactPath {
  path: string;
  /** One Artifact per compared Run, in the order of the Runs. */
  artifacts: Artifact[];
}

/** Paths every compared Run has, sorted by path. */
function findCommonPaths(artifactsByRun: Artifact[][]): CommonArtifactPath[] {
  const indexes = artifactsByRun.map((artifacts) => new Map(artifacts.map((artifact) => [artifact.path, artifact])));
  const [first, ...rest] = indexes;
  if (!first) return [];
  return [...first.keys()]
    .filter((path) => rest.every((index) => index.has(path)))
    .sort()
    .map((path) => ({ path, artifacts: indexes.map((index) => index.get(path)!) }));
}

function ComparedAudio({ runs, entry }: { runs: Run[]; entry: CommonArtifactPath }) {
  const players = useRef(new Map<string, HTMLAudioElement>());
  const [lastPlayedRunId, setLastPlayedRunId] = useState<string | null>(null);
  const pauseOthers = (runId: string) => {
    setLastPlayedRunId(runId);
    for (const [otherRunId, player] of players.current) if (otherRunId !== runId) player.pause();
  };
  // Switching keeps the position, so the same moment can be heard from each Run in turn.
  const switchTo = (runId: string) => {
    const target = players.current.get(runId);
    if (!target) return;
    const playing = [...players.current.values()].find((player) => !player.paused && player !== target);
    if (playing) target.currentTime = playing.currentTime;
    void target.play().catch(() => undefined);
  };
  const registerPlayer = useCallback(
    (runId: string) => (element: HTMLAudioElement | null) => {
      if (element) players.current.set(runId, element);
      else players.current.delete(runId);
    },
    [],
  );
  const registrations = useMemo(
    () => new Map(runs.map((run) => [run.id, registerPlayer(run.id)])),
    [runs, registerPlayer],
  );
  return (
    <div className="artifact-compare-stack">
      {runs.map((run, index) => (
        <section key={run.id} className={`artifact-compare-item ${lastPlayedRunId === run.id ? 'last-played' : ''}`}>
          <header>
            <h4>{run.name}</h4>
            <button type="button" className="button small" onClick={() => switchTo(run.id)}>
              <ArrowRightLeft size={14} />
              {text.compareSwitchPlayback}
            </button>
          </header>
          <AudioArtifactViewer
            artifact={entry.artifacts[index]!}
            onPlay={() => pauseOthers(run.id)}
            onAudioElement={registrations.get(run.id)}
          />
        </section>
      ))}
    </div>
  );
}

export function ArtifactCompare({ projectId, runs }: { projectId: string; runs: Run[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const artifacts = useQuery(`${projectId}:compare-artifacts:${runs.map((run) => run.id).join(',')}`, (signal) =>
    Promise.all(runs.map((run) => trackingApi.artifacts(projectId, run.id, signal))),
  );
  return (
    <Resource query={artifacts}>
      {(artifactsByRun) => {
        const common = findCommonPaths(artifactsByRun);
        const selected =
          common.find((entry) => entry.path === selectedPath) ??
          common.find((entry) => artifactMediaKind(entry.artifacts[0]!.mimeType) === 'audio') ??
          common[0];
        return (
          <div className="artifact-layout">
            <DataTable
              items={common}
              rowKey={(entry) => entry.path}
              selectedKey={selected?.path}
              empty={text.compareNoCommonArtifacts}
              columns={[
                {
                  key: 'path',
                  label: text.compareCommonPaths,
                  render: (entry) => (
                    <button className="link-button" onClick={() => setSelectedPath(entry.path)}>
                      {entry.path}
                    </button>
                  ),
                },
                {
                  key: 'size',
                  label: text.size,
                  className: 'mono',
                  render: (entry) => entry.artifacts.map((artifact) => formatBytes(artifact.size)).join(' / '),
                },
              ]}
            />
            {selected && (
              <section className="artifact-preview" aria-label={selected.path}>
                <h3>{selected.path}</h3>
                {artifactMediaKind(selected.artifacts[0]!.mimeType) === 'audio' ? (
                  <ComparedAudio key={selected.path} runs={runs} entry={selected} />
                ) : (
                  <div className="artifact-compare-stack">
                    {runs.map((run, index) => (
                      <section key={run.id} className="artifact-compare-item">
                        <header>
                          <h4>{run.name}</h4>
                        </header>
                        <ArtifactPreview artifact={selected.artifacts[index]!} />
                      </section>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        );
      }}
    </Resource>
  );
}
