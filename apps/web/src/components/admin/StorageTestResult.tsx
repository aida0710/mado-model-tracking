import type { StorageTestResult as StorageTestResultValue } from '@mmt/contracts';
import { CheckCircle2, XCircle } from 'lucide-react';
import { text } from '../../i18n/catalog';

// The API names the steps; names it adds later are shown as sent.
const stepLabels: Record<string, string> = {
  put: text.storageTestStepPut,
  get: text.storageTestStepGet,
  range: text.storageTestStepRange,
  delete: text.storageTestStepDelete,
};

/** Shows each step of a connection test with OK/NG and the API's short error. */
export function StorageTestResult({
  backendName,
  result,
}: {
  backendName: string;
  result: StorageTestResultValue;
}) {
  const passed = result.steps.every((step) => step.ok);
  return (
    <section className="storage-test-result" aria-live="polite">
      <h3>
        {text.storageTestResult}: {backendName}
      </h3>
      <p className={passed ? 'storage-test-summary ok' : 'storage-test-summary ng'}>
        {passed ? text.storageTestPassed : text.storageTestFailed}
      </p>
      <ol>
        {result.steps.map((step) => (
          <li key={step.name} className={step.ok ? 'ok' : 'ng'}>
            {step.ok ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <XCircle size={14} aria-hidden="true" />
            )}
            <span className="storage-test-step">{stepLabels[step.name] ?? step.name}</span>
            <strong>{step.ok ? text.storageTestOk : text.storageTestNg}</strong>
            {step.error && <span className="storage-test-error">{step.error}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
