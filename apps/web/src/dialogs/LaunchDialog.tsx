import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MAX_JOB_GPU_COUNT, type Job, type Run, type RunKind } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useProjectTargets } from '../hooks/useProjectTargets';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useLaunch } from '../hooks/useLaunch';
import { Dialog } from '../components/Dialog';
import { FormFields } from '../components/FormFields';
import type { FormField } from '../types/form';
import { CodeRuntimeDetails } from '../components/CodeRuntimeDetails';
import { ErrorNotice, Resource } from '../components/Feedback';
import { DetailsList } from '../components/JsonDetails';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  getFieldValue,
  parseJsonObject,
  getSelectedValues,
  parseStringMap,
  type FormValues,
} from '../lib/formValues';
import {
  isCodeCompatible,
  RUN_KINDS,
  MAX_JOB_ATTEMPTS,
  DEFAULT_JOB_ATTEMPTS,
} from '../lib/executionValidation';
import { isTargetCompatible, validateTargetRuntime } from '../lib/runtimeValidation';
import { buildJobRequest, isSiteTarget } from '../lib/siteExecutionInput';
import { targetChoiceLabel } from '../lib/computeTargetDisplay';
import { formatAutoRetries } from '../lib/jobDisplay';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';

/** The resources the review step lists: GPU IDs, or a site's GPU count, time limit and retries. */
function reviewResources(values: FormValues, isSite: boolean): Array<[string, ReactNode]> {
  if (!isSite)
    return [[text.gpuIds, getSelectedValues(values, 'gpuIds').join(', ') || text.cpuOnly]];
  const retries = formatAutoRetries({
    retryOnFailure: getFieldValue(values, 'retryOnFailure') === 'true',
    retryOnTimeout: getFieldValue(values, 'retryOnTimeout') === 'true',
  });
  return [
    [text.gpuCount, jobsTextTemplates.gpuCount(Number(getFieldValue(values, 'gpuCount') || 0))],
    [text.walltimeShort, getFieldValue(values, 'walltime').trim() || text.walltimeUnset],
    [text.jobAutoRetry, retries],
  ];
}

export function LaunchDialog({
  existingRun,
  onClose,
  onSaved,
}: {
  existingRun?: Run;
  onClose: () => void;
  onSaved: (job: Job) => void;
}) {
  const { project } = useProject();
  const catalog = useExecutionCatalog(project.id);
  const targets = useProjectTargets(project.id);
  const launch = useLaunch(project.id, existingRun);
  const [stage, setStage] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({
    name: existingRun?.name ?? '',
    experimentId: existingRun?.experimentId ?? '',
    kind: existingRun?.kind ?? 'inference',
    modelVersionId: existingRun?.modelVersionId ?? '',
    codeVersionId: existingRun?.codeVersionId ?? '',
    inputDatasetVersionIds: existingRun?.inputDatasetVersionIds ?? [],
    parameters: JSON.stringify(existingRun?.parameters ?? {}, null, 2),
    tags: JSON.stringify(existingRun?.tags ?? {}, null, 2),
    environment: JSON.stringify(existingRun?.environment ?? {}, null, 2),
    targetId: '',
    gpuIds: [],
    gpuCount: '0',
    walltime: '',
    maxAttempts: String(DEFAULT_JOB_ATTEMPTS),
    retryOnFailure: 'false',
    retryOnTimeout: 'false',
    allowChildJobs: 'false',
  });
  function changeValues(next: FormValues) {
    if (next.kind !== values.kind || next.modelVersionId !== values.modelVersionId)
      next.codeVersionId = '';
    if (next.codeVersionId !== values.codeVersionId) {
      next.targetId = '';
      next.gpuIds = [];
    }
    if (next.targetId !== values.targetId) next.gpuIds = [];
    setValues(next);
    setValidationError(null);
  }
  return (
    <Dialog title={text.launchTitle} onClose={onClose} busy={launch.pending} wide>
      <Resource query={catalog}>
        {(choices) => (
          <Resource query={targets}>
            {(computeTargets) => {
              const options = buildCatalogOptions(choices);
              const kind = getFieldValue(values, 'kind') as RunKind;
              const model = choices.modelVersions.find(
                (version) => version.id === getFieldValue(values, 'modelVersionId'),
              );
              const compatibleCodes = choices.codeVersions.filter((version) =>
                isCodeCompatible(version, kind, model),
              );
              const target = computeTargets.find(
                (item) => item.id === getFieldValue(values, 'targetId'),
              );
              const selectedCode = compatibleCodes.find(
                (version) => version.id === getFieldValue(values, 'codeVersionId'),
              );
              const compatibleTargets = computeTargets.filter(
                (item) => selectedCode && isTargetCompatible(item, selectedCode),
              );
              // Sites take a GPU count, a time limit and automatic retries instead of GPU IDs.
              const isSite = isSiteTarget(target);
              const setupFields: FormField[] = [
                { name: 'name', label: text.runName, required: true },
                {
                  name: 'experimentId',
                  label: text.experiments,
                  type: 'select',
                  required: true,
                  options: withEmptyOption(options.experiments),
                },
                {
                  name: 'kind',
                  label: text.kind,
                  type: 'select',
                  required: true,
                  options: RUN_KINDS.map((item) => ({ value: item, label: text[item] })),
                },
                {
                  name: 'modelVersionId',
                  label: text.modelVersion,
                  type: 'select',
                  options: withEmptyOption(options.models),
                },
                {
                  name: 'codeVersionId',
                  label: text.codeVersion,
                  type: 'select',
                  required: true,
                  options: withEmptyOption(
                    options.codes.filter((option) =>
                      compatibleCodes.some((version) => version.id === option.value),
                    ),
                  ),
                },
                {
                  name: 'inputDatasetVersionIds',
                  label: text.inputDatasets,
                  type: 'multiselect',
                  options: options.datasets,
                },
                { name: 'parameters', label: `${text.parameters} (JSON)`, type: 'textarea' },
                { name: 'tags', label: `${text.tags} (JSON)`, type: 'textarea' },
                { name: 'environment', label: `${text.environment} (JSON)`, type: 'textarea' },
              ];
              const resourceFields: FormField[] = [
                {
                  name: 'targetId',
                  label: text.target,
                  type: 'select',
                  required: true,
                  options: withEmptyOption(
                    compatibleTargets.map((item) => ({
                      value: item.id,
                      label: targetChoiceLabel(item),
                    })),
                  ),
                },
                {
                  name: 'gpuIds',
                  label: `${text.gpuIds} · ${text.cpuOnly}`,
                  type: 'multiselect',
                  options: (target?.gpuIds ?? []).map((id) => ({ value: id, label: id })),
                  visible: () => !isSite,
                },
                {
                  name: 'gpuCount',
                  label: text.gpuCount,
                  type: 'number',
                  min: 0,
                  max: MAX_JOB_GPU_COUNT,
                  visible: () => isSite,
                },
                {
                  name: 'walltime',
                  label: text.walltime,
                  placeholder: text.walltimePlaceholder,
                  visible: () => isSite,
                },
                {
                  name: 'maxAttempts',
                  label: text.maxAttempts,
                  type: 'number',
                  min: 1,
                  max: MAX_JOB_ATTEMPTS,
                  required: true,
                },
                {
                  name: 'retryOnFailure',
                  label: text.jobRetryOnFailure,
                  type: 'checkbox',
                  visible: () => isSite,
                },
                {
                  name: 'retryOnTimeout',
                  label: text.jobRetryOnTimeout,
                  type: 'checkbox',
                  visible: () => isSite,
                },
                { name: 'allowChildJobs', label: text.jobAllowChildJobs, type: 'checkbox' },
              ];
              function validateSetup() {
                const code = compatibleCodes.find(
                  (version) => version.id === getFieldValue(values, 'codeVersionId'),
                );
                if (!code) throw new Error(text.launchBlocked);
                parseJsonObject(getFieldValue(values, 'parameters'));
                parseStringMap(getFieldValue(values, 'tags'));
                parseJsonObject(getFieldValue(values, 'environment'));
              }
              return (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    setValidationError(null);
                    try {
                      if (stage === 0) {
                        validateSetup();
                        setStage(1);
                        return;
                      }
                      validateTargetRuntime(target, selectedCode);
                      if (!target) throw new Error(text.runtimeTargetError);
                      const job = buildJobRequest(target, values);
                      if (stage === 1) {
                        setStage(2);
                        return;
                      }
                      validateSetup();
                      void launch
                        .launch({
                          run: {
                            name: getFieldValue(values, 'name'),
                            experimentId: getFieldValue(values, 'experimentId'),
                            kind,
                            modelVersionId: getFieldValue(values, 'modelVersionId') || undefined,
                            codeVersionId: getFieldValue(values, 'codeVersionId'),
                            inputDatasetVersionIds: getSelectedValues(
                              values,
                              'inputDatasetVersionIds',
                            ),
                            parameters: parseJsonObject(getFieldValue(values, 'parameters')),
                            tags: parseStringMap(getFieldValue(values, 'tags')),
                            environment: parseJsonObject(getFieldValue(values, 'environment')),
                          },
                          job,
                        })
                        .then((created) => {
                          if (created) onSaved(created);
                        });
                    } catch (error) {
                      setValidationError((error as Error).message);
                    }
                  }}
                >
                  <ol className="wizard-steps">
                    {[text.launchSetup, text.launchResources, text.launchReview].map(
                      (label, index) => (
                        <li
                          key={label}
                          className={index === stage ? 'active' : ''}
                          aria-current={index === stage ? 'step' : undefined}
                        >
                          {index + 1}. {label}
                        </li>
                      ),
                    )}
                  </ol>
                  {stage === 0 && !compatibleCodes.length && (
                    <p className="notice">
                      {text.launchBlocked}{' '}
                      <Link to={`/projects/${project.id}/codes`}>{text.newCode}</Link>
                    </p>
                  )}
                  {stage === 1 && !compatibleTargets.length && (
                    <p className="notice">{text.noCompatibleTargets}</p>
                  )}
                  <fieldset disabled={launch.pending || (stage === 0 && !!launch.savedRun)}>
                    {stage < 2 ? (
                      <FormFields
                        fields={stage === 0 ? setupFields : resourceFields}
                        values={values}
                        onChange={changeValues}
                      />
                    ) : (
                      <DetailsList
                        entries={[
                          [text.runName, getFieldValue(values, 'name')],
                          [text.kind, text[kind]],
                          [
                            text.modelVersion,
                            options.models.find((option) => option.value === model?.id)?.label,
                          ],
                          [
                            text.codeVersion,
                            options.codes.find(
                              (option) => option.value === getFieldValue(values, 'codeVersionId'),
                            )?.label,
                          ],
                          [
                            text.inputDatasets,
                            options.datasets
                              .filter((option) =>
                                getSelectedValues(values, 'inputDatasetVersionIds').includes(
                                  option.value,
                                ),
                              )
                              .map((option) => option.label)
                              .join(', '),
                          ],
                          [text.target, target?.name],
                          ...reviewResources(values, isSite),
                          [text.maxAttempts, getFieldValue(values, 'maxAttempts')],
                        ]}
                      />
                    )}
                    {stage === 2 && selectedCode && <CodeRuntimeDetails version={selectedCode} />}
                  </fieldset>
                  {launch.savedRun && !existingRun && launch.error && (
                    <div className="notice">
                      <span>
                        {text.createdRunNoJob}{' '}
                        <Link to={`/projects/${project.id}/runs/${launch.savedRun.id}`}>
                          {launch.savedRun.name}
                        </Link>
                      </span>
                    </div>
                  )}
                  <ErrorNotice message={validationError ?? launch.error} />
                  <footer>
                    <button
                      type="button"
                      className="button"
                      onClick={onClose}
                      disabled={launch.pending}
                    >
                      {text.cancel}
                    </button>
                    {stage > 0 && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => setStage(stage - 1)}
                        disabled={launch.pending || (!!launch.savedRun && stage === 1)}
                      >
                        {text.back}
                      </button>
                    )}
                    <button
                      className="button primary"
                      disabled={
                        launch.pending ||
                        (stage === 0 && !compatibleCodes.length) ||
                        (stage === 1 && !compatibleTargets.length)
                      }
                    >
                      {stage === 2 ? text.launch : text.next}
                    </button>
                  </footer>
                </form>
              );
            }}
          </Resource>
        )}
      </Resource>
    </Dialog>
  );
}
