import type { CodeSample } from '../types/codeSample';
import { text } from '../i18n/catalog';

const smokeTest = `import unittest
from main import calculate


class SmokeTest(unittest.TestCase):
    def test_calculate_returns_expected_value(self):
        self.assertAlmostEqual(calculate(3.0), 7.0)


if __name__ == "__main__":
    unittest.main()
`;
const calculation = `def calculate(value):
    return 2.0 * value + 1.0
`;
const sdkMain = `${calculation}

def main():
    from mado_tracking import start_run

    with start_run(kind="processing") as run:
        for step, value in enumerate([1.0, 2.0, 3.0]):
            run.log_metrics({"sample.value": calculate(value)}, step=step)


if __name__ == "__main__":
    main()
`;
const mlflowMain = `${calculation}

def main():
    import os
    import mlflow

    with mlflow.start_run(run_id=os.environ["MLFLOW_RUN_ID"]):
        for step, value in enumerate([1.0, 2.0, 3.0]):
            mlflow.log_metric("sample.value", calculate(value), step=step)


if __name__ == "__main__":
    main()
`;
const inferenceMain = `def predict(weights, values):
    return [{"x": value, "prediction": weights["weight"] * value + weights["bias"]}
            for value in values]


def main():
    import json
    import os
    from pathlib import Path
    from mado_tracking import start_run

    with start_run(kind="inference") as run:
        model_path = os.environ.get("MMT_MODEL_FILE")
        if model_path:
            weights_path = Path(model_path)
        elif run.entity.get("modelVersionId"):
            weights_path = run.download_input_model(Path("inputs/weights.json"))
        else:
            weights_path = None
        weights = json.loads(weights_path.read_text(encoding="utf-8")) if weights_path else {"weight": 2.0, "bias": 1.0}
        predictions = predict(weights, [0.0, 1.0, 2.0])
        output = Path("outputs/predictions.json")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(predictions), encoding="utf-8")
        run.log_metrics({"inference.predictions": len(predictions)})
        run.log_artifact(output, path="inference/predictions.json", mime_type="application/json")


if __name__ == "__main__":
    main()
`;
const inferenceTest = `import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from main import main, predict


class InferenceTest(unittest.TestCase):
    def test_predictions_use_supplied_weights(self):
        predictions = predict({"weight": 3.0, "bias": 2.0}, [0.0, 2.0])
        self.assertEqual([item["prediction"] for item in predictions], [2.0, 8.0])

    def test_host_inference_uses_pinned_input_model(self):
        weights_path = Path("input-test-weights.json")
        weights_path.write_text(json.dumps({"weight": 3.0, "bias": 2.0}), encoding="utf-8")
        run = MagicMock()
        run.__enter__.return_value = run
        run.entity = {"modelVersionId": "pinned-model"}
        run.download_input_model.return_value = weights_path
        sdk = SimpleNamespace(start_run=lambda **attributes: run)
        with patch.dict(sys.modules, {"mado_tracking": sdk}), patch.dict(os.environ, {"MMT_MODEL_FILE": ""}):
            main()
        predictions = json.loads(Path("outputs/predictions.json").read_text(encoding="utf-8"))
        self.assertEqual([item["prediction"] for item in predictions], [2.0, 5.0, 8.0])


if __name__ == "__main__":
    unittest.main()
`;
const trainingMain = `${calculation}

def train(steps=12):
    weight, bias = 0.0, 0.0
    samples = [(value, calculate(value)) for value in [0.0, 1.0, 2.0]]
    history = []
    for _ in range(steps):
        errors = [weight * value + bias - expected for value, expected in samples]
        loss = sum(error ** 2 for error in errors) / len(samples)
        weight -= 0.1 * sum(error * value for error, (value, _) in zip(errors, samples)) / len(samples)
        bias -= 0.1 * sum(errors) / len(samples)
        history.append(loss)
    return {"weight": weight, "bias": bias}, history


def main():
    import json
    from pathlib import Path
    from mado_tracking import start_run

    weights, history = train()
    output = Path("outputs/weights.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(weights), encoding="utf-8")
    with start_run(kind="training") as run:
        for step, loss in enumerate(history):
            run.log_metrics({"train.loss": loss}, step=step)
        artifact = run.log_artifact(output, path="model/weights.json", mime_type="application/json")
        run.register_output_model(name=f"sample-linear-{run.id}", family="linear",
                                  version="v1", artifact_id=artifact["id"])


if __name__ == "__main__":
    main()
`;
const trainingTest = `import unittest
from main import train


class TrainingTest(unittest.TestCase):
    def test_training_reduces_loss(self):
        weights, history = train()
        self.assertLess(history[-1], history[0])
        self.assertGreater(weights["weight"], 0)


if __name__ == "__main__":
    unittest.main()
`;

// Keep smoke commands offline so checking code never needs tracking credentials.
const testEntrypoint = ['python', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py'];
const sampleDefaults = {
  entrypoint: ['python', 'main.py'], testEntrypoint, families: ['linear'],
};
export const CODE_SAMPLES: CodeSample[] = [
  { ...sampleDefaults, id: 'smoke', label: text.smokeSample, requirements: [], taskTypes: ['processing'],
    files: { 'main.py': `${calculation}\n\nif __name__ == "__main__":\n    print(calculate(3.0))\n`, 'test_smoke.py': smokeTest } },
  { ...sampleDefaults, id: 'sdk', label: text.sdkSample, requirements: [], taskTypes: ['processing'],
    files: { 'main.py': sdkMain, 'test_smoke.py': smokeTest } },
  { ...sampleDefaults, id: 'mlflow', label: text.mlflowSample, requirements: ['mlflow>=3,<4'], taskTypes: ['processing'],
    files: { 'main.py': mlflowMain, 'test_smoke.py': smokeTest } },
  { ...sampleDefaults, id: 'inference', label: text.inferenceSample, requirements: [], taskTypes: ['inference'],
    files: { 'main.py': inferenceMain, 'test_inference.py': inferenceTest } },
  { ...sampleDefaults, id: 'training', label: text.trainingSample, requirements: [], taskTypes: ['training'],
    files: { 'main.py': trainingMain, 'test_training.py': trainingTest } },
];
