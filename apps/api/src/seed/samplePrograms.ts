export const linearTrainingProgram = `import json
import os
from pathlib import Path
from mado_tracking import start_run

parameters = json.loads(os.environ.get("MMT_PARAMETERS_JSON", "{}"))
steps = int(parameters.get("steps", 60))
rate = float(parameters.get("learningRate", 0.2))
samples = [(i / 10, 2 * i / 10 + 1) for i in range(-10, 11)]
model_file = os.environ.get("MMT_MODEL_VERSION_FILE")
model_version = json.loads(Path(model_file).read_text()) if model_file else None
initial_weights = (model_version or {}).get("metadata", {})
weight = float(initial_weights.get("weight", 0.0))
bias = float(initial_weights.get("bias", 0.0))
with start_run() as run:
    for step in range(steps):
        errors = [(weight * x + bias - y, x) for x, y in samples]
        loss = sum(error ** 2 for error, _ in errors) / len(samples)
        run.log_metrics({"loss": loss}, step=step)
        weight -= rate * 2 * sum(error * x for error, x in errors) / len(samples)
        bias -= rate * 2 * sum(error for error, _ in errors) / len(samples)
    weights = Path("weights.json")
    weights.write_text(json.dumps({"weight": weight, "bias": bias}))
    run.log_artifact(weights, path="weights.json", mime_type="application/json")
    run.log("CPU linear training completed")
`;

export const linearInferenceProgram = `import json
import os
from pathlib import Path
from mado_tracking import start_run

parameters = json.loads(os.environ.get("MMT_PARAMETERS_JSON", "{}"))
model_file = os.environ.get("MMT_MODEL_VERSION_FILE")
model_version = json.loads(Path(model_file).read_text()) if model_file else None
model_weights = (model_version or {}).get("metadata", {})
weight = float(parameters.get("weight", model_weights.get("weight", 2.0)))
bias = float(parameters.get("bias", model_weights.get("bias", 1.0)))
inputs = parameters.get("inputs", [0, 1, 2])
predictions = [{"input": x, "prediction": weight * x + bias} for x in inputs]
with start_run() as run:
    output = Path("predictions.json")
    output.write_text(json.dumps(predictions))
    run.log_artifact(output, path="predictions.json", mime_type="application/json")
    run.log_metrics({"prediction_count": len(predictions)})
    print(json.dumps(predictions), flush=True)
`;

export const qwenInferenceProgram = `import json
import os
from transformers import AutoModelForCausalLM, AutoTokenizer
from mado_tracking import start_run

parameters = json.loads(os.environ.get("MMT_PARAMETERS_JSON", "{}"))
model_version = json.loads(open(os.environ["MMT_MODEL_VERSION_FILE"]).read())
model_name = model_version["weightsUri"].removeprefix("hf://")
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForCausalLM.from_pretrained(model_name)
inputs = tokenizer(parameters.get("prompt", "Hello"), return_tensors="pt")
outputs = model.generate(**inputs, max_new_tokens=int(parameters.get("maxNewTokens", 16)))
with start_run() as run:
    text = tokenizer.decode(outputs[0], skip_special_tokens=True)
    run.log(text)
    run.log_metrics({"generated_tokens": outputs.shape[-1] - inputs["input_ids"].shape[-1]})
    print(text, flush=True)
`;
