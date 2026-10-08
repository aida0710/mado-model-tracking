import { useState } from 'react';
import type { StorageBackend } from '@mmt/contracts';
import type { FormField, FormValues } from '../types/form';
import { storageApi } from '../api/storage';
import { RequestError } from '../api/http';
import { Dialog } from '../components/Dialog';
import { FormFields } from '../components/FormFields';
import { ErrorNotice } from '../components/Feedback';
import { useMutation } from '../hooks/useMutation';
import { getFieldValue } from '../lib/formValues';
import {
  buildStorageBackendCreate,
  buildStorageBackendPatch,
  createStorageBackendValues,
  MAX_MULTIPART_PART_SIZE_MIB,
  MIN_MULTIPART_PART_SIZE_MIB,
  PEM_CERTIFICATE_HEADER,
  updateStorageBackendValues,
} from '../lib/storageBackendInput';
import { text } from '../i18n/catalog';

// Returned until the server can sign with v2 (s3-signature-v2); the Web names it in place.
const SIGNATURE_UNSUPPORTED_CODE = 'storage_signature_unsupported';

const isS3 = (values: FormValues) => getFieldValue(values, 'kind') === 's3';
const isFilesystem = (values: FormValues) => !isS3(values);

/** Creates a storage backend, or edits one saved from the screen (`backend`). */
export function StorageBackendDialog({
  backend,
  onClose,
  onSaved,
}: {
  backend?: StorageBackend;
  onClose: () => void;
  onSaved: (backend: StorageBackend) => void;
}) {
  const [values, setValues] = useState(() =>
    backend ? updateStorageBackendValues(backend) : createStorageBackendValues(),
  );
  const mutation = useMutation();
  const title = backend ? text.editStorageBackend : text.newStorageBackend;
  return (
    <Dialog title={title} onClose={onClose} busy={mutation.pending} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(() => saveBackend(values, backend))
            .then((saved) => {
              if (saved) onSaved(saved);
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <FormFields fields={buildFields(backend)} values={values} onChange={setValues} />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : backend ? text.save : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

async function saveBackend(values: FormValues, backend?: StorageBackend) {
  try {
    return backend
      ? await storageApi.updateBackend(backend.name, buildStorageBackendPatch(values, backend))
      : await storageApi.createBackend(buildStorageBackendCreate(values));
  } catch (failure) {
    if (failure instanceof RequestError && failure.code === SIGNATURE_UNSUPPORTED_CODE)
      throw new Error(text.storageSignatureUnsupported);
    throw failure;
  }
}

function buildFields(backend?: StorageBackend): FormField[] {
  return [
    { name: 'name', label: text.name, required: true, readOnly: Boolean(backend), maxLength: 63 },
    {
      name: 'kind',
      label: text.storageBackendKind,
      type: 'select',
      // The kind decides how stored keys are read, so a saved backend keeps its kind.
      options: (backend ? [backend.kind] : (['s3', 'filesystem'] as const)).map((kind) => ({
        value: kind,
        label: text[kind],
      })),
    },
    { name: 'rootPath', label: text.storageRootPath, required: true, visible: isFilesystem },
    {
      name: 'endpoint',
      label: text.storageEndpoint,
      type: 'url',
      placeholder: 'https://s3.example.internal:9000',
      visible: isS3,
    },
    { name: 'region', label: text.storageRegion, required: true, visible: isS3 },
    { name: 'bucket', label: text.storageBucket, required: true, visible: isS3 },
    { name: 'prefix', label: text.storagePrefix, visible: isS3 },
    { name: 'pathStyle', label: text.storagePathStyle, type: 'checkbox', visible: isS3 },
    {
      name: 'signatureVersion',
      label: text.storageSignature,
      type: 'select',
      options: [
        { value: 'v4', label: text.storageSignatureV4 },
        { value: 'v2', label: text.storageSignatureV2 },
      ],
      visible: isS3,
    },
    { name: 'tlsVerify', label: text.storageTlsVerify, type: 'checkbox', visible: isS3 },
    {
      name: 'caBundle',
      label: text.storageCaBundle,
      type: 'textarea',
      placeholder: backend?.caBundleConfigured
        ? text.storageCaBundleConfigured
        : PEM_CERTIFICATE_HEADER,
      visible: isS3,
    },
    {
      name: 'clearCaBundle',
      label: text.storageClearCaBundle,
      type: 'checkbox',
      visible: (values) => isS3(values) && Boolean(backend?.caBundleConfigured),
    },
    {
      name: 'checksumMode',
      label: text.storageChecksumMode,
      type: 'select',
      options: [
        { value: 'when_required', label: text.storageChecksumWhenRequired },
        { value: 'when_supported', label: text.storageChecksumWhenSupported },
      ],
      visible: isS3,
    },
    {
      name: 'multipartPartSizeMib',
      label: text.storagePartSize,
      type: 'number',
      required: true,
      min: MIN_MULTIPART_PART_SIZE_MIB,
      max: MAX_MULTIPART_PART_SIZE_MIB,
      visible: isS3,
    },
    { name: 'accessKeyId', label: text.storageAccessKeyId, visible: isS3 },
    {
      name: 'secretAccessKey',
      label: text.storageSecretAccessKey,
      type: 'password',
      placeholder: backend?.secretConfigured ? text.storageSecretConfigured : undefined,
      visible: isS3,
    },
    { name: 'enabled', label: text.storageEnabled, type: 'checkbox' },
  ];
}
