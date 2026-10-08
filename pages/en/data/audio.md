---
title: Audio viewer
description: Show audio Artifacts as a waveform and spectrogram, zoom in, and loop a section. Long audio uses a preview generated on the server.
---

# Audio viewer

![Audio viewer with a waveform and mel spectrogram](/images/data-audio-viewer.png)

Opening an audio Artifact shows the audio viewer. It displays the waveform and spectrogram together, plays from where you click, and loops the section you drag. Analysis runs in the browser without external services or libraries.

The audio viewer is used in Artifact previews for Runs and datasets, the Run **Media** tab, media comparison on the Compare page, and media blocks in shared reports.

The web UI is in Japanese. This page shows UI labels in Japanese followed by an English translation.

## When to use it

- You want to listen to generated audio while checking the waveform for noise or dropouts.
- You want to loop only the section you are interested in.
- You want to compare audio from different training steps on a mel spectrogram.
- You want to see where the sound is in a recording longer than an hour.

## Supported formats

WAV, FLAC, MP3, Ogg, Opus, M4A (AAC), and WebM. If the browser cannot decode a file, the viewer shows 音声をデコードできませんでした。(The audio could not be decoded.)

For WAV and FLAC, the duration, sample rate, and channel count are read from the file header when it is saved, so they are shown before the audio is decoded. Other formats get these values from ffprobe when the server generates a preview.

## Controls

| Control | What it does |
| --- | --- |
| Play, pause | The toolbar button toggles playback |
| Click | Click the waveform or spectrogram to move to that position |
| Drag | Loops the dragged range. **ループを解除** (Clear loop) removes it |
| ←, → | Move 1 second backward or forward |
| 拡大, 縮小 (Zoom in, zoom out) | Change the visible range by a factor of 2. At the maximum zoom, 0.05 seconds is shown |
| 全体を表示 (Show all) | Reset the zoom |
| 表示位置 (Position) | A slider shown while zoomed in that moves the visible range |
| チャンネル (Channel) | すべて（平均） (all, averaged) or チャンネル1, チャンネル2, … Available for audio with two or more channels |
| スペクトログラム (Spectrogram) | 線形 (linear, default) or mel |

Time is shown as minutes:seconds.hundredths, such as `0:00.80`. The top right of the spectrogram shows the highest frequency displayed (half the sample rate).

There is no control for playback speed.

## Spectrogram

The browser computes the spectrogram with these settings:

- FFT size 1024 and hop size 256 samples
- Up to 2048 columns; long audio is summarized per column
- 80 mel bands
- Values below −100 dB use the darkest color

## Long audio previews

Decoding audio over 64 MiB in the browser would exhaust memory, so the browser does not analyze it. Instead, the preview worker on the server generates the waveform and a spectrogram image.

| State | Display |
| --- | --- |
| Generating | 64MiBを超えるため、サーバーで波形とスペクトログラムを生成しています。再生はできます。(Generating on the server; playback works.) The state is checked every 5 seconds |
| Ready | The full waveform and a linear spectrogram |
| Failed | サーバーでの波形とスペクトログラムの生成に失敗しました。再生はできます。(Generation failed; playback works.) |
| No preview | 64MiBを超えるため、波形とスペクトログラムは表示しません。再生はできます。(Not shown; playback works.) For example when the preview worker has no ffmpeg, or the audio was saved before the preview worker was set up |

In a ready preview, clicking and ← and → still move the position. Zoom, channel selection, and mel are not available. Playback loads only the parts it needs, so even audio of several gigabytes starts playing quickly.

The server generates previews for these Artifacts, decided when they are saved:

- Audio over 64 MiB
- Audio whose duration cannot be read from the header (MP3, M4A, Ogg, Opus, AAC, and so on)
- Video (an image of the frame at 1 second or at 10% of the length, whichever comes first)

Previews are saved as Artifacts in the same Project under `.previews/<original Artifact ID>/`. The original Artifact is not changed. Artifacts saved before the preview worker was set up get no preview.

### Run the preview worker

The preview worker runs as a separate process from the API. It needs ffmpeg and ffprobe, so run it with the bundled `Dockerfile.preview` (the `preview` service in Docker Compose).

```sh
docker compose up -d preview
```

Give the preview worker the same database URL as the API (`MMT_DATABASE_URL`), the storage environment variables (`ARTIFACT_FILESYSTEM_ROOT`, `S3_*`), and `MMT_STORAGE_SECRET_KEY`. Its temporary directory (`MMT_PREVIEW_WORK_DIR`) needs enough free space for the largest Artifact. One ffmpeg run is stopped after 30 minutes by default (`MMT_PREVIEW_TOOL_TIMEOUT_MS`).

## Related pages

- [Artifacts](/en/data/artifacts)
- [Media logging](/en/tracking/media)
- [Shared reports](/en/data/reports)
