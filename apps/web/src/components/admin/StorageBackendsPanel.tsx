import { useState } from 'react';
import type { StorageBackend, StorageTestResult as StorageTestResultValue } from '@mmt/contracts';
import { Plus, RefreshCw } from 'lucide-react';
import { storageApi } from '../../api/storage';
import { useStorageBackends } from '../../hooks/useStorageBackends';
import { useMutation } from '../../hooks/useMutation';
import { ConfirmDialog } from '../ConfirmDialog';
import { ErrorNotice, Resource } from '../Feedback';
import { StorageBackendDialog } from '../../dialogs/StorageBackendDialog';
import { StorageBackendsTable } from './StorageBackendsTable';
import { StorageTestResult } from './StorageTestResult';
import { text, textTemplates } from '../../i18n/catalog';

type BackendDialog = { mode: 'create' } | { mode: 'edit'; backend: StorageBackend };

/** The admin "storage" tab: backends, their connection tests and the default for new Projects. */
export function StorageBackendsPanel() {
  const storage = useStorageBackends();
  const [dialog, setDialog] = useState<BackendDialog | null>(null);
  const [defaultCandidate, setDefaultCandidate] = useState<StorageBackend | null>(null);
  const [testedBackend, setTestedBackend] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<StorageTestResultValue | null>(null);
  const test = useMutation();
  const runTest = (backend: StorageBackend) => {
    setTestedBackend(backend.name);
    setTestResult(null);
    void test.run(async () => setTestResult(await storageApi.testBackend(backend.name)));
  };
  return (
    <section className="admin-storage">
      <div className="section-heading">
        <h2>{text.storageBackends}</h2>
        <div>
          <button className="button primary" onClick={() => setDialog({ mode: 'create' })}>
            <Plus size={15} />
            {text.newStorageBackend}
          </button>
          <button className="icon-button" aria-label={text.refresh} onClick={storage.reload}>
            <RefreshCw size={17} />
          </button>
        </div>
      </div>
      <Resource query={storage.settings}>
        {(settings) => (
          <Resource query={storage.backends}>
            {(backends) => (
              <StorageBackendsTable
                backends={backends}
                defaultBackend={settings.defaultBackend}
                testingBackend={test.pending ? testedBackend : null}
                onTest={runTest}
                onEdit={(backend) => setDialog({ mode: 'edit', backend })}
                onMakeDefault={setDefaultCandidate}
              />
            )}
          </Resource>
        )}
      </Resource>
      <ErrorNotice message={test.error} />
      {testedBackend && testResult && (
        <StorageTestResult backendName={testedBackend} result={testResult} />
      )}
      {dialog && (
        <StorageBackendDialog
          backend={dialog.mode === 'edit' ? dialog.backend : undefined}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            storage.backends.reload();
          }}
        />
      )}
      {defaultCandidate && (
        <ConfirmDialog
          title={text.storageMakeDefaultTitle}
          message={textTemplates.storageMakeDefaultConfirm(defaultCandidate.name)}
          confirmLabel={text.storageMakeDefault}
          onConfirm={() => storageApi.updateSettings({ defaultBackend: defaultCandidate.name })}
          onConfirmed={() => {
            setDefaultCandidate(null);
            storage.settings.reload();
          }}
          onClose={() => setDefaultCandidate(null)}
        />
      )}
    </section>
  );
}
