from __future__ import annotations

import io
import json
import re
import subprocess
import sys
import wave
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import numpy as np
import pytest
from PIL import Image as PilImage

from mado_tracking import Audio, Client, Image, Table, Video, artifact_reference, http
from mado_tracking.errors import ConfigurationError
from mado_tracking.media_encoding import png_bytes
from mado_tracking.offline.spool import RunSpool, read_media
from mado_tracking.offline.transport import AutoRunTransport, HttpRunTransport, spool_record_from_entity
from mado_tracking.run import Run

PROJECT_ID = str(uuid4())
RUN_ID = str(uuid4())
TOKEN = "media-test-secret"
MEDIA_PATH = re.compile(r"^media/(?P<key>.+)/step-(?P<step>\d+)/(?P<uuid>[0-9a-f-]{36})\.(?P<extension>\w+)$")


class FakeMediaApi:
    """In-memory PUT /runs/:r/artifacts, POST /runs/:r/media (idempotent by id) and /metrics."""

    def __init__(self):
        self.artifacts: list[dict] = []
        self.media_requests: list[dict] = []
        self.media: dict[str, dict] = {}
        self.media_failures = 0
        self.media_unreachable = False

    def client(self) -> Client:
        return Client(api_url="http://mmt.test", api_token=TOKEN, transport=httpx.MockTransport(self.handle))

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}/runs/{RUN_ID}/")
        if request.method == "PUT" and path == "artifacts":
            artifact = {
                "id": str(uuid4()),
                "runId": RUN_ID,
                "path": request.url.params["path"],
                "mimeType": request.headers["Content-Type"],
                "content": request.read(),
            }
            self.artifacts.append(artifact)
            return httpx.Response(
                201, json={key: value for key, value in artifact.items() if key != "content"}
            )
        if request.method == "POST" and path == "media":
            body = json.loads(request.read())
            self.media_requests.append(body)
            if self.media_unreachable:
                raise httpx.ConnectError("API host is unreachable")
            if self.media_failures:
                self.media_failures -= 1
                return httpx.Response(503, json={"error": "temporarily unavailable"})
            items = [self.media.setdefault(item["id"], item) for item in body["items"]]
            return httpx.Response(201, json={"items": items})
        if request.method == "POST" and path == "metrics":
            return httpx.Response(200, json={})
        raise AssertionError(f"Unexpected request {request.method} {request.url.path}")

    def artifact(self, path: str) -> dict:
        return next(artifact for artifact in self.artifacts if artifact["path"] == path)


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch):
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)


@pytest.fixture
def api() -> FakeMediaApi:
    return FakeMediaApi()


@pytest.fixture
def run(api: FakeMediaApi) -> Run:
    return Run(api.client(), PROJECT_ID, {"id": RUN_ID, "status": "running"})


def wav_bytes(frames: int = 160, sample_rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()


def test_an_audio_array_is_stored_under_media_key_step_and_registered_with_its_artifact(api, run):
    sine = np.sin(np.linspace(0, 2 * np.pi * 10, 1600))

    media = run.log_audio("eval/sample", sine, step=100, sample_rate=16000, caption="sample 1")

    (artifact,) = api.artifacts
    match = MEDIA_PATH.match(artifact["path"])
    assert match and match["key"] == "eval/sample" and match["step"] == "100" and match["extension"] == "wav"
    assert artifact["mimeType"] == "audio/wav" and artifact["content"].startswith(b"RIFF")
    ((item,),) = [request["items"] for request in api.media_requests]
    assert UUID(item["id"]).version == 4
    assert item == {
        "id": item["id"],
        "key": "eval/sample",
        "step": 100,
        "kind": "audio",
        "artifactId": artifact["id"],
        "caption": "sample 1",
        "metadata": {"sampleRate": 16000, "channels": 1},
    }
    assert media["id"] == item["id"]


def test_without_a_step_media_uses_the_last_metric_step_or_zero(api, run):
    image = np.zeros((4, 4), dtype=np.uint8)
    run.log_image("before-metrics", image)
    run.log_metrics({"loss": 0.5}, step=200)
    run.log_metrics({"accuracy": 0.9}, step=150)

    run.log_image("spectrogram", image)

    assert [request["items"][0]["step"] for request in api.media_requests] == [0, 200]
    assert MEDIA_PATH.match(api.artifacts[1]["path"])["step"] == "200"


def test_a_retried_registration_resends_the_same_media_id(api, run):
    api.media_failures = 2

    run.log_image("image", np.zeros((2, 2, 3), dtype=np.uint8), step=3)

    ids = [request["items"][0]["id"] for request in api.media_requests]
    assert len(ids) == 3 and len(set(ids)) == 1
    assert list(api.media) == ids[:1]
    # The file is uploaded once; only the registration is retried.
    assert len(api.artifacts) == 1


def test_table_media_cells_become_artifacts_and_filepath_cells_in_split_json(api, run):
    other_run = str(uuid4())
    table = Table(
        columns=["audio", "transcript", "score", "reference"],
        rows=[
            [Audio(wav_bytes()), "こんにちは", 0.9, artifact_reference(other_run, "eval/ref.wav")],
            [Audio(np.zeros(80), sample_rate=8000), "さようなら", float("nan"), None],
        ],
    )

    run.log_table("eval/table", table, step=100)

    cell_paths = [artifact["path"] for artifact in api.artifacts[:2]]
    assert all(MEDIA_PATH.match(path)["key"] == "eval/table" for path in cell_paths)
    assert [api.artifact(path)["mimeType"] for path in cell_paths] == ["audio/wav", "audio/wav"]
    table_artifact = api.artifacts[2]
    assert table_artifact["path"].endswith(".json") and table_artifact["mimeType"] == "application/json"
    assert json.loads(table_artifact["content"]) == {
        "columns": ["audio", "transcript", "score", "reference"],
        "data": [
            [
                {"type": "audio", "filepath": cell_paths[0]},
                "こんにちは",
                0.9,
                f"mmt-artifact://runs/{other_run}/eval/ref.wav",
            ],
            [{"type": "audio", "filepath": cell_paths[1]}, "さようなら", None, None],
        ],
    }
    ((item,),) = [request["items"] for request in api.media_requests]
    assert item["kind"] == "table" and item["step"] == 100 and item["artifactId"] == table_artifact["id"]
    assert item["metadata"] == {"rowCount": 2, "columnCount": 4}


class FakeDataFrame:
    """The part of pandas.DataFrame that log_table uses."""

    columns = ["image", "label"]

    def to_dict(self, *, orient: str) -> dict:
        assert orient == "split"
        return {"index": [0], "columns": self.columns, "data": [[Image(np.ones((2, 2))), np.int64(3)]]}


def test_a_split_mapping_and_a_dataframe_are_logged_as_tables(api, run):
    run.log_table("mapping", {"columns": ["a"], "data": [[1], [2]]}, step=0)
    run.log_table("frame", FakeDataFrame(), step=1)

    assert json.loads(api.artifacts[0]["content"]) == {"columns": ["a"], "data": [[1], [2]]}
    image_path = api.artifacts[1]["path"]
    assert api.artifacts[1]["mimeType"] == "image/png"
    assert json.loads(api.artifacts[2]["content"])["data"] == [[{"type": "image", "filepath": image_path}, 3]]


def test_a_pil_image_and_a_video_file_are_logged(api, run, tmp_path):
    video = tmp_path / "rollout.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16)

    run.log_image("pil", PilImage.new("RGB", (5, 3), "red"), step=1)
    run.log_video("rollout", Video(video, caption="episode 1"), step=2)

    assert PilImage.open(io.BytesIO(api.artifacts[0]["content"])).size == (5, 3)
    assert api.media_requests[0]["items"][0]["metadata"] == {"width": 5, "height": 3}
    assert api.artifacts[1]["path"].endswith(".mp4") and api.artifacts[1]["mimeType"] == "video/mp4"
    assert api.media_requests[1]["items"][0]["caption"] == "episode 1"


@pytest.mark.parametrize("key", ["", "../escape", "a//b", "/absolute", "a\\b", "a%2fb"])
def test_unsafe_media_keys_are_refused_before_anything_is_sent(api, run, key):
    with pytest.raises(ConfigurationError):
        run.log_audio(key, wav_bytes())
    assert api.artifacts == [] and api.media_requests == []


def test_a_file_of_another_media_kind_or_an_unknown_format_is_refused(api, run):
    with pytest.raises(ConfigurationError, match="cannot be logged as image"):
        run.log_image("image", wav_bytes())
    with pytest.raises(ConfigurationError, match="Cannot tell"):
        run.log_audio("audio", b"not audio")
    with pytest.raises(ConfigurationError, match="sample_rate"):
        run.log_audio("audio", np.zeros(10))
    with pytest.raises(ConfigurationError, match="non-negative"):
        run.log_audio("audio", wav_bytes(), step=-1)
    assert api.artifacts == []


def test_auto_mode_spools_the_file_and_the_same_media_id_when_registration_cannot_reach_the_api(
    api, tmp_path
):
    api.media_unreachable = True
    client = api.client()
    record = spool_record_from_entity(
        {"id": RUN_ID, "experimentId": str(uuid4()), "name": "auto"},
        project_id=PROJECT_ID,
        api_url=client.settings.url,
    )
    transport = AutoRunTransport(
        HttpRunTransport(client, PROJECT_ID, RUN_ID),
        lambda: RunSpool.create(tmp_path / "offline", record, run_created=True),
    )
    run = Run(client, PROJECT_ID, {"id": RUN_ID, "status": "running"}, transport=transport)

    run.log_audio("audio", wav_bytes(), step=5)
    run.transport.close()

    sent_ids = {request["items"][0]["id"] for request in api.media_requests}
    (spooled,) = read_media(run.offline_directory)
    assert sent_ids == {spooled["id"]}
    artifacts = [
        json.loads(line) for line in (run.offline_directory / "artifacts.jsonl").read_text().splitlines()
    ]
    assert [artifact["path"] for artifact in artifacts] == [spooled["artifactPath"]]
    assert (run.offline_directory / artifacts[0]["localPath"]).read_bytes() == wav_bytes()


NO_OPTIONAL_PACKAGES_SCRIPT = """
import sys

class BlockOptionalPackages:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {"numpy", "PIL", "pandas"}:
            raise ImportError(f"{name} is not installed")
        return None

sys.meta_path.insert(0, BlockOptionalPackages())
from mado_tracking.client import start_run_offline

audio, image, video = sys.argv[1:4]
run = start_run_offline(project_id=sys.argv[4], experiment_id=sys.argv[5], name="no-optional-packages")
run.log_audio("audio", audio, step=1)
run.log_audio("audio", open(audio, "rb").read(), step=2)
run.log_image("image", open(image, "rb").read(), step=1)
run.log_video("video", video, step=1)
run.log_table("table", {"columns": ["text"], "data": [["ok"]]}, step=1)
run.finish()
assert not {"numpy", "PIL", "pandas"} & set(sys.modules)
print(run.offline_directory)
"""


def test_path_and_bytes_inputs_work_without_numpy_pillow_or_pandas(tmp_path, monkeypatch):
    audio = tmp_path / "speech.wav"
    audio.write_bytes(wav_bytes())
    image = tmp_path / "plot.png"
    image.write_bytes(png_bytes(b"\x00\xff\x00\xff", width=2, height=2, color_type=0))
    video = tmp_path / "clip.webm"
    video.write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 16)
    monkeypatch.setenv("MMT_OFFLINE_DIR", str(tmp_path / "offline"))
    monkeypatch.delenv("MMT_JOB_ID", raising=False)

    completed = subprocess.run(
        [sys.executable, "-c", NO_OPTIONAL_PACKAGES_SCRIPT, str(audio), str(image), str(video)]
        + [PROJECT_ID, str(uuid4())],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    directory = Path(completed.stdout.strip().splitlines()[-1])
    kinds = [(media["kind"], media["step"]) for media in read_media(directory)]
    assert kinds == [("audio", 1), ("audio", 2), ("image", 1), ("video", 1), ("table", 1)]
