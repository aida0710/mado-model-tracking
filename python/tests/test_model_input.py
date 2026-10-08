from __future__ import annotations

import json

import httpx
import pytest

from mado_tracking import Client, artifact_downloads
from mado_tracking.errors import ApiError, ConfigurationError
from mado_tracking.run import Run

# Large chunks expose whole-file buffering while keeping this test inexpensive.
CHUNK_BYTES = 1024 * 1024


def input_run(client: Client) -> Run:
    return Run(client, "project", {"id": "run", "kind": "finetuning", "modelVersionId": "pinned-version"})


def model_version(**attributes) -> dict:
    return {"id": "pinned-version", "projectId": "project", "artifactId": "weights-artifact", **attributes}


def test_input_artifact_is_streamed_privately_and_takes_priority_over_the_weights_uri(tmp_path):
    chunks = [b"a" * CHUNK_BYTES, b"b" * CHUNK_BYTES, b"tail"]

    class ModelStream(httpx.SyncByteStream):
        def __iter__(self):
            for index, chunk in enumerate(chunks):
                if index:
                    temporary = next(tmp_path.glob(".input-model-*"))
                    assert temporary.stat().st_size == sum(len(part) for part in chunks[:index])
                yield chunk

    def serve(request):
        assert request.headers["Authorization"] == "Bearer model-test-secret"
        assert request.url.path == "/api/projects/project/artifacts/weights-artifact/content"
        return httpx.Response(200, stream=ModelStream())

    destination = tmp_path / "weights.bin"
    with Client(
        api_url="http://localhost", api_token="model-test-secret", transport=httpx.MockTransport(serve)
    ) as client:
        assert (
            input_run(client).download_input_model(
                destination, model_version=model_version(weightsUri="https://[")
            )
            == destination
        )
    assert destination.read_bytes() == b"".join(chunks)
    assert destination.stat().st_mode & 0o777 == 0o600
    assert not list(tmp_path.glob(".input-model-*"))


def test_interrupted_input_download_keeps_the_previous_file_and_removes_partial_bytes(tmp_path, monkeypatch):
    # Every resume attempt is interrupted too; skip the backoff between them.
    monkeypatch.setattr(artifact_downloads, "retry_delay", lambda *_arguments: 0)

    class InterruptedStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"incomplete weights"
            raise httpx.ReadError("input model connection lost")

    destination = tmp_path / "weights.bin"
    destination.write_bytes(b"original")
    with (
        Client(
            api_url="http://localhost",
            api_token="model-test-secret",
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, stream=InterruptedStream())),
        ) as client,
        pytest.raises(ApiError, match="kept failing"),
    ):
        input_run(client).download_input_model(destination, model_version=model_version())
    assert destination.read_bytes() == b"original" and not list(tmp_path.glob(".input-model-*"))


@pytest.mark.parametrize("attributes", [{"id": "another-version"}, {"projectId": "another-project"}])
def test_input_model_must_match_the_runs_fixed_version_and_project_before_requesting_bytes(
    tmp_path, attributes
):
    def serve(_request):
        pytest.fail("Mismatched input must never be requested")

    with (
        Client(
            api_url="http://localhost", api_token="model-test-secret", transport=httpx.MockTransport(serve)
        ) as client,
        pytest.raises(ConfigurationError, match="does not match"),
    ):
        input_run(client).download_input_model(
            tmp_path / "weights", model_version=model_version(**attributes)
        )
    assert not list(tmp_path.iterdir())


def test_input_model_uses_the_worker_descriptor_and_a_local_file_uri(tmp_path, monkeypatch):
    source = tmp_path / "parent weights.json"
    source.write_bytes(b'{"weight": 1, "bias": 0.5}')
    descriptor = tmp_path / "model-version.json"
    descriptor.write_text(
        json.dumps({"modelVersion": model_version(artifactId=None, weightsUri=source.as_uri())})
    )
    monkeypatch.setenv("MMT_MODEL_VERSION_FILE", str(descriptor))
    with Client(api_url="http://localhost", api_token="model-test-secret") as client:
        destination = input_run(client).download_input_model(tmp_path / "outputs" / "weights.json")
    assert destination.read_bytes() == source.read_bytes()


def test_input_model_does_not_follow_an_arbitrary_external_weights_uri(tmp_path):
    with (
        Client(api_url="http://localhost", api_token="model-test-secret") as client,
        pytest.raises(ConfigurationError, match="Artifact or a local"),
    ):
        input_run(client).download_input_model(
            tmp_path / "weights",
            model_version=model_version(artifactId=None, weightsUri="https://example.invalid/weights"),
        )
    assert not list(tmp_path.iterdir())
