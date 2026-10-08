"""Research features in one training script: system metrics, media every few steps, a large
checkpoint, offline recording with a later sync, and resuming the same Run.

The "model" is media_logging.py's toy that learns a 440 Hz tone. Needs numpy
(``pip install 'mado-tracking[media]'``) and, for CPU/memory metrics, psutil.

    # online: system.* every second, audio/spectrogram/table every 10 steps
    MMT_PROJECT_ID=... MMT_EXPERIMENT_ID=... python research_features.py --steps 30
    # continue the same Run; steps continue after the last recorded one
    python research_features.py --resume <runId> --steps 10
    # no API: record into the spool (MMT_OFFLINE_DIR), with a 65 MiB checkpoint, then send it later
    MMT_MODE=offline python research_features.py --checkpoint-mib 65
    mado-tracking sync

The last stdout line is JSON ``{"runId", "mode", "offlineDirectory", "lastStep"}`` for scripts.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

from media_logging import SAMPLE_RATE, TARGET_HZ, evaluation_table, spectrogram, synthesize

import mado_tracking
from mado_tracking import Run

# Evaluate every 10 steps so a 30-step run gives the media slider three positions.
EVALUATION_EVERY = 10
# Checkpoints of 64 MiB and more go through a resumable upload session (sync resumes them too).
MEBIBYTE = 1024 * 1024
LEARNING_RATE = 0.05
INITIAL_HZ = 200.0


def write_checkpoint(directory: Path, *, size_mib: int, frequency: float) -> Path:
    """A placeholder weights file of size_mib MiB whose bytes depend on the trained frequency."""
    path = directory / "model.bin"
    block = f"{frequency:.6f}".encode().ljust(64, b"\0") * (MEBIBYTE // 64)
    with path.open("wb") as file:
        for _ in range(size_mib):
            file.write(block)
    return path


def train(run: Run, *, steps: int, step_seconds: float) -> float:
    """Log loss every step and media every EVALUATION_EVERY steps; returns the trained frequency.

    A resumed Run continues after its last step, and the toy recomputes where training stood then.
    """
    last_step = run.last_step("loss")
    first_step = 0 if last_step is None else last_step + 1
    frequency = TARGET_HZ - (TARGET_HZ - INITIAL_HZ) * (1 - LEARNING_RATE) ** first_step
    for step in range(first_step, first_step + steps):
        frequency += LEARNING_RATE * (TARGET_HZ - frequency)
        run.log_metrics(
            {"loss": abs(TARGET_HZ - frequency) / TARGET_HZ, "frequency_hz": frequency}, step=step
        )
        if step % EVALUATION_EVERY == EVALUATION_EVERY - 1:
            audio = synthesize(frequency)
            # No step: media goes to the last metric step, as in W&B.
            run.log_audio("inference/tone", audio, sample_rate=SAMPLE_RATE, caption=f"{frequency:.1f} Hz")
            run.log_image("inference/spectrogram", spectrogram(audio))
            run.log_table("evaluation/samples", evaluation_table(frequency))
        time.sleep(step_seconds)
    return frequency


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["online", "offline", "auto"], default=None)
    parser.add_argument("--name", default="research-features")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--step-seconds", type=float, default=0.0, help="sleep per step (system metrics)")
    parser.add_argument("--system-metrics-interval", type=float, default=1.0)
    parser.add_argument("--checkpoint-mib", type=int, default=0, help="log a checkpoint of this size")
    parser.add_argument("--resume", metavar="RUN_ID", help="continue this Run (online only)")
    arguments = parser.parse_args()

    resume_options = {"run_id": arguments.resume, "resume": "must"} if arguments.resume else {}
    run = mado_tracking.start_run(
        name=arguments.name,
        mode=arguments.mode,
        system_metrics=True,
        system_metrics_interval=arguments.system_metrics_interval,
        parameters={"learning_rate": LEARNING_RATE},
        **resume_options,
    )
    with run:
        frequency = train(run, steps=arguments.steps, step_seconds=arguments.step_seconds)
        if arguments.checkpoint_mib:
            with tempfile.TemporaryDirectory(prefix="research-features-") as directory:
                checkpoint = write_checkpoint(
                    Path(directory), size_mib=arguments.checkpoint_mib, frequency=frequency
                )
                # Offline Runs copy the file into the spool, so the temporary file may go away.
                run.log_artifact(checkpoint, path="checkpoints/model.bin")
    offline_directory = run.offline_directory
    print(
        json.dumps(
            {
                "runId": run.id,
                "mode": "offline" if offline_directory else "online",
                "offlineDirectory": str(offline_directory) if offline_directory else None,
                "lastStep": run.last_step("loss"),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
