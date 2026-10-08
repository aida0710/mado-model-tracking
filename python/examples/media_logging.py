"""Log inference audio, a spectrogram and an evaluation table every 100 steps of a training loop.

The "model" is a toy that learns to produce a 440 Hz tone; each evaluation step synthesizes audio
from its current frequency, so the Run's media slider plays the tone converging. Needs numpy
(``pip install 'mado-tracking[media]'``).

    MMT_PROJECT_ID=... MMT_EXPERIMENT_ID=... python media_logging.py --mode offline
    mado-tracking sync      # later, from a machine that reaches the API
"""

from __future__ import annotations

import argparse

import numpy as np

import mado_tracking
from mado_tracking import Audio, Table

SAMPLE_RATE = 16000
TARGET_HZ = 440.0
# 100 steps between evaluations keeps a 1000-step run at 10 slider positions.
EVALUATION_EVERY = 100
# 512-sample frames (32 ms at 16 kHz) with half overlap: a common speech spectrogram setting.
FRAME_SIZE = 512
HOP_SIZE = 256
EVALUATION_PROMPTS = ["こんにちは", "ありがとう", "さようなら"]


def synthesize(frequency: float, *, seconds: float = 0.5) -> np.ndarray:
    time = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return 0.4 * np.sin(2 * np.pi * frequency * time)


def spectrogram(audio: np.ndarray) -> np.ndarray:
    """Log-magnitude STFT as an image in [0, 1], low frequencies at the bottom."""
    window = np.hanning(FRAME_SIZE)
    frames = [
        audio[start : start + FRAME_SIZE] * window for start in range(0, len(audio) - FRAME_SIZE, HOP_SIZE)
    ]
    magnitude = np.log1p(np.abs(np.fft.rfft(np.array(frames), axis=1))).T
    return np.flipud(magnitude / max(float(magnitude.max()), 1e-9))


def evaluation_table(frequency: float) -> Table:
    rows = []
    for index, prompt in enumerate(EVALUATION_PROMPTS):
        audio = synthesize(frequency * (1 + 0.05 * index))
        score = float(np.exp(-abs(frequency - TARGET_HZ) / 100))
        rows.append([Audio(audio, sample_rate=SAMPLE_RATE), prompt, round(score, 4)])
    return Table(columns=["audio", "transcript", "score"], rows=rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["online", "offline", "auto"], default=None)
    parser.add_argument("--steps", type=int, default=1000)
    arguments = parser.parse_args()

    frequency = 200.0
    with mado_tracking.start_run(name="media-logging", mode=arguments.mode) as run:
        for step in range(1, arguments.steps + 1):
            frequency += 0.01 * (TARGET_HZ - frequency)
            run.log_metrics({"loss": abs(TARGET_HZ - frequency) / TARGET_HZ}, step=step)
            if step % EVALUATION_EVERY:
                continue
            audio = synthesize(frequency)
            # step is omitted: media is logged at the last metric step, as in W&B.
            run.log_audio("inference/tone", audio, sample_rate=SAMPLE_RATE, caption=f"{frequency:.1f} Hz")
            run.log_image("inference/spectrogram", spectrogram(audio))
            run.log_table("evaluation/samples", evaluation_table(frequency))


if __name__ == "__main__":
    main()
