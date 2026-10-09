import { useState } from 'react';
import type { Hook, HookExecution, HookTriggerRequest } from '@mmt/contracts';
import { hooksApi } from '../api/hooks';
import type { FormValues } from '../types/form';
import { FormFields } from './FormFields';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorNotice } from './Feedback';
import { getFieldValue } from '../lib/formValues';
import { hookExecutionOutcome } from '../lib/hookDisplay';
import { buildHookStartRequest, createHookStartKey } from '../lib/hookStart';
import { text } from '../i18n/catalog';
import { hooksTextTemplates } from '../i18n/hooks';

/**
 * Starts a 'manual' hook with an optional JSON payload. The request (with its key) is fixed when
 * the confirmation opens, so retrying a failed confirmation cannot start the hook twice.
 */
export function HookStart({
  hook,
  projectId,
  onStarted,
}: {
  hook: Hook;
  projectId: string;
  onStarted: () => void;
}) {
  const [values, setValues] = useState<FormValues>({ payload: '' });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [request, setRequest] = useState<HookTriggerRequest | null>(null);
  const [started, setStarted] = useState<HookExecution | null>(null);
  return (
    <section className="hook-start">
      <h4>{text.hookStart}</h4>
      <FormFields
        fields={[{ name: 'payload', label: text.hookStartPayload, type: 'textarea' }]}
        values={values}
        onChange={(next) => {
          setValues(next);
          setValidationError(null);
          setStarted(null);
        }}
      />
      <p className="muted">{text.hookStartPayloadHint}</p>
      <ErrorNotice message={validationError} />
      <button
        className="button small"
        disabled={!hook.enabled}
        onClick={() => {
          try {
            setRequest(buildHookStartRequest(getFieldValue(values, 'payload'), createHookStartKey()));
          } catch (failure) {
            setValidationError((failure as Error).message);
          }
        }}
      >
        {text.hookStart}
      </button>
      {started && (
        <p className="notice success" role="status">
          {hooksTextTemplates.hookStarted(hookExecutionOutcome(started))}
        </p>
      )}
      {request && (
        <ConfirmDialog
          title={text.hookStart}
          message={hooksTextTemplates.hookStartConfirm(hook.name)}
          confirmLabel={text.hookStartConfirm}
          onConfirm={async () => setStarted(await hooksApi.trigger(projectId, hook.id, request))}
          onConfirmed={() => {
            setRequest(null);
            onStarted();
          }}
          onClose={() => setRequest(null)}
        />
      )}
    </section>
  );
}
