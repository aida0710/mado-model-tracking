"""Register the bundled CPU scripts and submit a real training job to a chosen target."""

from __future__ import annotations

import os
from pathlib import Path

from mado_tracking import Client


def main() -> None:
    project_id = os.environ["MMT_PROJECT_ID"]
    target_id = os.environ["MMT_EXAMPLE_TARGET_ID"]
    examples_directory = Path(__file__).resolve().parent
    with Client() as client:
        experiment = client.create_experiment(project_id, name="CPU worker example")
        training_code = client.register_code(
            project_id,
            name="CPU linear training",
            version="v1",
            source={
                "kind": "inline",
                "files": {"training.py": (examples_directory / "training.py").read_text()},
            },
            entrypoint=["python", "training.py"],
            supported_model_families=["linear"],
            task_types=["training", "finetuning"],
        )
        inference_code = client.register_code(
            project_id,
            name="CPU linear inference",
            version="v1",
            source={
                "kind": "inline",
                "files": {"inference.py": (examples_directory / "inference.py").read_text()},
            },
            entrypoint=["python", "inference.py"],
            supported_model_families=["linear"],
            task_types=["inference"],
        )
        run = client.create_run(
            project_id,
            experiment_id=experiment["id"],
            name="CPU fit y=2x+1",
            kind="training",
            parameters={"steps": 40, "learning_rate": 0.1},
            code_version_id=training_code["id"],
        )
        job = client.create_job(project_id, run_id=run.id, target_id=target_id, gpu_ids=[])
        print(f"trainingRunId={run.id}\njobId={job['id']}\ninferenceCodeVersionId={inference_code['id']}")


if __name__ == "__main__":
    main()
