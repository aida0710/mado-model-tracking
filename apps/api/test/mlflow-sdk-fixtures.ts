import { fileURLToPath } from 'node:url';

export const mlflowSdkPythonPath =
  process.env.MMT_TEST_MLFLOW_PYTHON ??
  fileURLToPath(
    new URL('../../../artifacts/verification/mlflow3-venv/bin/python', import.meta.url),
  );
