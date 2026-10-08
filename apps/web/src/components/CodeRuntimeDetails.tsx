import type { CodeVersion } from '@mmt/contracts';
import type { ReactNode } from 'react';
import { DetailsList } from './JsonDetails';
import { runtimeLabels } from '../i18n/runtime';
import { text } from '../i18n/catalog';

export function CodeRuntimeDetails({ version }: { version: CodeVersion }) {
  const runtime = version.runtime;
  const entries: Array<[string, ReactNode]> = [[text.runtime, runtimeLabels[runtime.kind]]];
  if (runtime.kind === 'docker')
    entries.push([text.dockerImage, <code className="break-word">{runtime.image}</code>]);
  if (runtime.kind === 'singularity' || runtime.kind === 'apptainer')
    entries.push(
      [text.sifArtifact, <code>{runtime.artifactId}</code>],
      [text.sha256, <code className="break-word">{runtime.sha256}</code>],
    );
  if (runtime.kind !== 'python' && runtime.workingDirectory)
    entries.push([text.containerWorkingDirectory, <code>{runtime.workingDirectory}</code>]);
  entries.push([
    text.entrypoint,
    <code className="break-word">{JSON.stringify(version.entrypoint)}</code>,
  ]);
  entries.push([text.testEntrypoint, <code className="break-word">{JSON.stringify(version.testEntrypoint ?? [])}</code>]);
  if (runtime.kind === 'python' && version.requirements.length)
    entries.push([text.requirements, <pre>{version.requirements.join('\n')}</pre>]);
  return <DetailsList entries={entries} />;
}
