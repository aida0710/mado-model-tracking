import { Link } from 'react-router-dom';
import type { Artifact, Run } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { DetailsList, JsonDetails } from './JsonDetails';
import { runtimeLabels } from '../i18n/runtime';
import { text } from '../i18n/catalog';

// These reserved paths are the worker's immutable source capture, before the command runs.
const SOURCE_SNAPSHOT_PATHS = ['.mmt/source.zip', '.mmt/source-manifest.json'];

export function RunExecutionSnapshot({ run, artifacts }: { run: Run; artifacts?: Artifact[] }) {
  const base = `/projects/${run.projectId}`;
  const snapshot = run.executionSnapshot;
  const snapshotArtifacts = artifacts?.filter((artifact) => SOURCE_SNAPSHOT_PATHS.includes(artifact.path));
  return <section className="execution-snapshot" data-testid="run-execution-snapshot">
    <h2>{text.executionSnapshot}</h2>
    <DetailsList entries={[
      [text.task, run.taskId ? <Link to={`${base}/tasks?id=${run.taskId}`}>{run.taskId}</Link> : null],
      [text.taskRevision, run.taskRevision],
      [text.executionMode, (snapshot?.mode ?? run.executionMode) === 'test' ? text.testMode : text.runMode],
      [text.codeVersion, snapshot ? <Link to={`${base}/codes?version=${snapshot.codeVersionId}`}>{snapshot.version} · {snapshot.codeVersionId}</Link> : null],
      [text.runtime, snapshot ? runtimeLabels[snapshot.runtime.kind] : null],
      [text.entrypoint, snapshot ? <code className="break-word" data-testid="snapshot-command">{JSON.stringify(snapshot.entrypoint)}</code> : null],
    ]} />
    {snapshot ? <>
      <details><summary>{text.source}</summary><JsonDetails value={snapshot.source} /></details>
      <details><summary>{text.runtime}</summary><JsonDetails value={snapshot.runtime} /></details>
      <details><summary>{text.requirements}</summary><JsonDetails value={snapshot.requirements} /></details>
      <details><summary>{text.environment}</summary><JsonDetails value={snapshot.environment} /></details>
    </> : <p className="muted">{text.snapshotUnavailable}</p>}
    <h3>{text.sourceSnapshot}</h3>
    {snapshotArtifacts?.length ? <ul className="snapshot-artifacts">
      {snapshotArtifacts.map((artifact) => <li key={artifact.id}>
        <a href={trackingApi.artifactUrl(run.projectId, artifact.id)} download={artifact.path.split('/').pop()}>{artifact.path}</a>
        <code className="break-word">{artifact.sha256}</code>
      </li>)}
    </ul> : <p className="muted">{text.snapshotPending}</p>}
    <Link className="button small" to={`${base}/runs/${run.id}?tab=artifacts`}>{text.artifacts}</Link>
  </section>;
}
