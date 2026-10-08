import type { CreateTarget } from '../api/inputs';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parsePositiveInteger, splitLines } from './formValues';
import { parseRuntimeKinds } from './runtimeValidation';

// The dialog edits the dataset cache bound in GiB; the API stores bytes.
export const BYTES_PER_GIB = 1024 ** 3;

export function buildTargetInput(values: FormValues): CreateTarget {
  return {
    name: getFieldValue(values, 'name'), executor: getFieldValue(values, 'executor') as CreateTarget['executor'],
    host: getFieldValue(values, 'host'), port: parsePositiveInteger(getFieldValue(values, 'port')),
    username: getFieldValue(values, 'username'), sshKeyPath: getFieldValue(values, 'sshKeyPath'),
    knownHostsPath: getFieldValue(values, 'knownHostsPath'), workDirectory: getFieldValue(values, 'workDirectory'),
    pythonExecutable: getFieldValue(values, 'pythonExecutable'),
    runtimeKinds: parseRuntimeKinds(getSelectedValues(values, 'runtimeKinds')),
    gpuIds: splitLines(getFieldValue(values, 'gpuIds')),
    maxConcurrentJobs: parsePositiveInteger(getFieldValue(values, 'maxConcurrentJobs')),
    enabled: getFieldValue(values, 'enabled') === 'true',
    datasetCacheMaxBytes: parsePositiveInteger(getFieldValue(values, 'datasetCacheMaxGiB')) * BYTES_PER_GIB,
    datasetTransfer: getFieldValue(values, 'datasetTransfer') as CreateTarget['datasetTransfer'],
  };
}
