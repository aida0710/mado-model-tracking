"""Load a registered weight and record its evaluation through the official SDK."""

import json
import os
from pathlib import Path

import mlflow
import numpy as np

with mlflow.start_run() as run:
    assert run.info.run_id == os.environ["MMT_RUN_ID"]
    model_version = json.loads(Path(os.environ["MMT_MODEL_VERSION_FILE"]).read_text())["modelVersion"]
    model = mlflow.pyfunc.load_model(f"mlflow-artifacts:/model-versions/{model_version['id']}/artifacts")
    prediction = float(model.predict(np.array([[1.0, 2.0]]))[0])
    mlflow.log_param("evaluation", "mlflow-registry")
    mlflow.log_metric("evaluation.prediction", prediction, step=1)
    prediction_file = Path("prediction.json")
    prediction_file.write_text(json.dumps({"prediction": prediction}))
    mlflow.log_artifact(str(prediction_file), artifact_path="evaluation")
print("mlflow-evaluation-recorded", flush=True)
