import { useId, useRef, useState, type ReactNode } from 'react';
import type { ComputeTarget, Experiment, ExperimentTask, Sweep, SweepMethod, SweepObjective } from '@mmt/contracts';
import { sweepsApi } from '../../api/sweeps';
import { RequestError } from '../../api/http';
import { useMutation } from '../../hooks/useMutation';
import { useTaskMetricNames } from '../../hooks/useSweeps';
import { formatErrorMessage } from '../../lib/errorMessage';
import {
  MAX_GRID_COMBINATIONS,
  SweepConfigError,
  convertWandbSweepConfig,
  countGridCombinations,
  rowIdForSpaceError,
  rowsToSearchSpace,
  toWandbSweepConfig,
} from '../../lib/sweepConfig';
import {
  applySearchSettings,
  buildSweepCreate,
  formSearchSettings,
  initialSweepForm,
  type SweepFormField,
  type SweepFormValues,
} from '../../lib/sweepForm';
import { Dialog } from '../Dialog';
import { ErrorNotice } from '../Feedback';
import { SearchSpaceEditor } from './SearchSpaceEditor';
import { sweepAggregationLabels, sweepGoalLabels, sweepMethodLabels } from '../../i18n/sweeps';
import { text } from '../../i18n/catalog';

// The API names the offending parameter in this 422's message (domain/sweeps/searchSpace.ts).
const SPACE_INVALID_CODE = 'sweep_space_invalid';

/** A 422 about the search space: shown on the row it names, or above the rows. */
interface SpaceError {
  rowId: string | null;
  message: string;
}

export function CreateSweepDialog({
  projectId,
  tasks,
  experiments,
  targets,
  onClose,
  onCreated,
}: {
  projectId: string;
  tasks: ExperimentTask[];
  experiments: Experiment[];
  targets: ComputeTarget[];
  onClose: () => void;
  onCreated: (sweep: Sweep) => void;
}) {
  const nextRowId = useRef(0);
  const createRowId = () => `row-${nextRowId.current++}`;
  const [form, setForm] = useState<SweepFormValues>(() => initialSweepForm(tasks[0]?.id ?? '', createRowId));
  const [isSubmitted, setSubmitted] = useState(false);
  const [spaceError, setSpaceError] = useState<SpaceError | null>(null);
  const mutation = useMutation();
  const metricNames = useTaskMetricNames(projectId, form.taskId);
  const metricListId = useId();
  const task = tasks.find((item) => item.id === form.taskId);
  const experiment = experiments.find((item) => item.id === task?.experimentId);
  const validation = buildSweepCreate(form);
  const fieldErrors = isSubmitted ? validation.fieldErrors : {};
  const rowErrors = {
    ...(isSubmitted ? validation.rowErrors : {}),
    ...(spaceError?.rowId ? { [spaceError.rowId]: spaceError.message } : {}),
  };
  const gridCombinations = countGridCombinations(rowsToSearchSpace(form.rows, form.method).searchSpace);

  function change(values: Partial<SweepFormValues>) {
    setForm((previous) => ({ ...previous, ...values }));
    // A row-level message from the API is about the rows as they were sent.
    if ('rows' in values || 'method' in values) setSpaceError(null);
  }

  function loadWandbConfig(config: unknown): string | null {
    try {
      const settings = convertWandbSweepConfig(config);
      change(applySearchSettings(form, settings, createRowId));
      return null;
    } catch (error) {
      if (error instanceof SweepConfigError) return error.message;
      throw error;
    }
  }

  async function submit() {
    setSubmitted(true);
    setSpaceError(null);
    const isGridTooLarge = form.method === 'grid' && gridCombinations !== null && gridCombinations > MAX_GRID_COMBINATIONS;
    if (!validation.input || isGridTooLarge) return;
    const input = validation.input;
    const created = await mutation.run(async () => {
      try {
        return await sweepsApi.create(projectId, input);
      } catch (error) {
        if (!(error instanceof RequestError) || error.code !== SPACE_INVALID_CODE) throw error;
        const message = formatErrorMessage(error);
        setSpaceError({ rowId: rowIdForSpaceError(message, form.rows), message });
        return undefined;
      }
    });
    if (created) onCreated(created);
  }

  return (
    <Dialog title={text.sweepNew} onClose={onClose} busy={mutation.pending} wide>
      <form className="sweep-create-form" data-testid="sweep-create-form" onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <fieldset disabled={mutation.pending}>
          <div className="sweep-form-grid">
            <Field label={text.name} error={fieldErrors.name}>
              <input value={form.name} onChange={(event) => change({ name: event.target.value })} />
            </Field>
            <Field label={text.sweepTask} error={fieldErrors.taskId}>
              <select value={form.taskId} onChange={(event) => change({ taskId: event.target.value })}>
                {tasks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
          </div>
          {task && (
            <p className="muted sweep-task-pin">
              {text.sweepTaskRevision} {task.revision}: {text.sweepTaskRevisionPinned}
              <br />
              {text.sweepExperiment}: {experiment?.name ?? task.experimentId}（{text.sweepExperimentHint}）
            </p>
          )}
          <div className="sweep-form-grid">
            <Field label={text.sweepTarget}>
              <select value={form.targetId} onChange={(event) => change({ targetId: event.target.value })}>
                <option value="">{text.sweepTaskDefault}</option>
                {targets.filter((target) => target.enabled).map((target) => (
                  <option key={target.id} value={target.id}>{target.name}</option>
                ))}
              </select>
            </Field>
            <Field label={text.sweepGpuIds}>
              <input value={form.gpuIds} className="mono" onChange={(event) => change({ gpuIds: event.target.value })} />
            </Field>
            <Field label={text.sweepMethod}>
              <select value={form.method} onChange={(event) => change({ method: event.target.value as SweepMethod })}>
                {(Object.keys(sweepMethodLabels) as SweepMethod[]).map((method) => (
                  <option key={method} value={method}>{sweepMethodLabels[method]}</option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="sweep-objective">
            <legend>{text.sweepObjective}</legend>
            <div className="sweep-form-grid">
              <Field label={text.sweepObjectiveMetric} error={fieldErrors.metric}>
                <input value={form.metric} className="mono" list={metricListId}
                  onChange={(event) => change({ metric: event.target.value })} />
              </Field>
              <Field label={text.sweepGoal}>
                <select value={form.goal} onChange={(event) => change({ goal: event.target.value as SweepObjective['goal'] })}>
                  {(Object.keys(sweepGoalLabels) as SweepObjective['goal'][]).map((goal) => (
                    <option key={goal} value={goal}>{sweepGoalLabels[goal]}</option>
                  ))}
                </select>
              </Field>
              <Field label={text.sweepAggregation}>
                <select value={form.aggregation}
                  onChange={(event) => change({ aggregation: event.target.value as SweepObjective['aggregation'] })}>
                  {(Object.keys(sweepAggregationLabels) as SweepObjective['aggregation'][]).map((aggregation) => (
                    <option key={aggregation} value={aggregation}>{sweepAggregationLabels[aggregation]}</option>
                  ))}
                </select>
              </Field>
            </div>
            <datalist id={metricListId}>
              {(metricNames.value ?? []).map((name) => <option key={name} value={name} />)}
            </datalist>
            <p className="muted">{text.sweepObjectiveMetricHint}</p>
          </fieldset>
          <div className="sweep-form-grid">
            <IntegerField label={text.sweepMaxTrials} field="maxTrials" form={form} errors={fieldErrors} onChange={change} />
            <IntegerField label={text.sweepParallelism} field="parallelism" form={form} errors={fieldErrors} onChange={change} />
            <IntegerField label={text.sweepSeed} field="seed" form={form} errors={fieldErrors} onChange={change} />
          </div>
          <fieldset className="sweep-early-stopping">
            <legend>{text.sweepEarlyStopping}</legend>
            <div className="sweep-form-grid">
              <Field label={text.sweepEarlyStopping}>
                <select value={form.earlyStopping}
                  onChange={(event) => change({ earlyStopping: event.target.value as SweepFormValues['earlyStopping'] })}>
                  <option value="none">{text.sweepEarlyStoppingNone}</option>
                  <option value="hyperband">{text.sweepEarlyStoppingHyperband}</option>
                </select>
              </Field>
              {form.earlyStopping === 'hyperband' && (
                <>
                  <IntegerField label={text.sweepMinIter} field="minIter" form={form} errors={fieldErrors} onChange={change} />
                  <IntegerField label={text.sweepEta} field="eta" form={form} errors={fieldErrors} onChange={change} />
                  <IntegerField label={text.sweepMaxIter} field="maxIter" form={form} errors={fieldErrors} onChange={change} />
                </>
              )}
            </div>
          </fieldset>
          {spaceError && !spaceError.rowId && <p className="sweep-field-error" role="alert">{spaceError.message}</p>}
          {isSubmitted && validation.searchSpaceError && (
            <p className="sweep-field-error" role="alert">{validation.searchSpaceError}</p>
          )}
          <SearchSpaceEditor
            rows={form.rows}
            method={form.method}
            rowErrors={rowErrors}
            gridCombinations={form.method === 'grid' ? gridCombinations : null}
            createRowId={createRowId}
            onRowsChange={(rows) => change({ rows })}
            currentWandbConfig={() => {
              const settings = formSearchSettings(form);
              return settings ? toWandbSweepConfig(settings) : null;
            }}
            onLoadWandbConfig={loadWandbConfig}
          />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>{text.cancel}</button>
          <button className="button primary" disabled={mutation.pending || !tasks.length}>
            {mutation.pending ? text.loading : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className={`field${error ? ' invalid' : ''}`}>
      <span>{label}</span>
      {children}
      {error && <span className="sweep-field-error" role="alert">{error}</span>}
    </label>
  );
}

function IntegerField({
  label,
  field,
  form,
  errors,
  onChange,
}: {
  label: string;
  field: Extract<SweepFormField, keyof SweepFormValues>;
  form: SweepFormValues;
  errors: Partial<Record<SweepFormField, string>>;
  onChange: (values: Partial<SweepFormValues>) => void;
}) {
  return (
    <Field label={label} error={errors[field]}>
      <input value={form[field]} className="mono" inputMode="numeric"
        onChange={(event) => onChange({ [field]: event.target.value })} />
    </Field>
  );
}
