from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from mado_tracking import Client, http
from mado_tracking.dataset_upload import (
    LocalDatasetFile,
    dataset_manifest_digest,
    upload_dataset_directory,
)
from mado_tracking.errors import ApiError, ConfigurationError

PROJECT_ID = str(uuid4())
DATASET_ID = str(uuid4())
TOKEN = "dataset-upload-test-secret"


class FakeDatasetApi:
    """In-memory Artifacts, by-digest lookup and 'artifacts' version creation as the API contract states."""

    def __init__(self) -> None:
        self.artifacts: dict[str, dict] = {}
        self.uploaded_paths: list[str] = []
        self.versions: list[dict] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix(f"/api/projects/{PROJECT_ID}/")
        if request.method == "GET" and path == "artifacts/by-digest":
            return self.by_digest(request.url.params["sha256"], int(request.url.params["size"]))
        if request.method == "PUT" and path == "artifacts":
            return self.store(request.url.params["path"], request.read(), request.headers["Content-Type"])
        if request.method == "POST" and path == f"datasets/{DATASET_ID}/versions":
            return self.create_version(json.loads(request.read()))
        return httpx.Response(404, json={"error": "not found", "code": "not_found"})

    def by_digest(self, sha256: str, size: int) -> httpx.Response:
        for artifact in reversed(self.artifacts.values()):
            if artifact["sha256"] == sha256 and artifact["size"] == size:
                return httpx.Response(200, json=artifact)
        return httpx.Response(404, json={"error": "Artifactが見つかりません", "code": "not_found"})

    def store(self, path: str, body: bytes, mime_type: str) -> httpx.Response:
        self.uploaded_paths.append(path)
        artifact = {
            "id": str(uuid4()),
            "path": path,
            "size": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "mimeType": mime_type,
        }
        self.artifacts[artifact["id"]] = artifact
        return httpx.Response(201, json=artifact)

    def create_version(self, body: dict) -> httpx.Response:
        version = body.get("version", str(len(self.versions) + 1))
        if any(existing["version"] == version for existing in self.versions):
            return httpx.Response(409, json={"error": "exists", "code": "already_exists"})
        files = body["content"]["files"]
        # The server's digest comes from the stored Artifacts, not from the client's files.
        entries = sorted(
            (
                {
                    "path": file["path"],
                    "sha256": self.artifacts[file["artifactId"]]["sha256"],
                    "size": self.artifacts[file["artifactId"]]["size"],
                }
                for file in files
            ),
            key=lambda entry: entry["path"].encode("utf-8"),
        )
        canonical = json.dumps(entries, separators=(",", ":"), ensure_ascii=False)
        digest = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if body.get("digest") not in (None, digest):
            return httpx.Response(422, json={"error": "mismatch", "code": "dataset_digest_mismatch"})
        created = {"id": str(uuid4()), "version": version, "digest": digest, "files": files, **body}
        self.versions.append(created)
        return httpx.Response(201, json=created)


@pytest.fixture(autouse=True)
def immediate_retries(monkeypatch):
    monkeypatch.setattr(http, "retry_delay", lambda *_arguments: 0)


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    (root / "train").mkdir(parents=True)
    (root / "train" / "a.wav").write_bytes(b"RIFF-a")
    (root / "train" / "b.wav").write_bytes(b"RIFF-b")
    (root / "meta.jsonl").write_text('{"audio":"train/a.wav"}\n')
    return root


def client_for(api: FakeDatasetApi) -> Client:
    return Client(api_url="http://localhost", api_token=TOKEN, transport=httpx.MockTransport(api.handle))


def test_directory_becomes_a_version_listing_every_file_by_relative_path(corpus):
    api = FakeDatasetApi()
    with client_for(api) as client:
        version = upload_dataset_directory(
            client, PROJECT_ID, DATASET_ID, corpus, metadata={"language": "ja"}, schema={"sampleRate": 16000}
        )
    assert version["version"] == "1"
    assert version["metadata"] == {"language": "ja"}
    assert version["schema"] == {"sampleRate": 16000}
    assert [file["path"] for file in version["files"]] == ["meta.jsonl", "train/a.wav", "train/b.wav"]
    assert sorted(api.uploaded_paths) == [
        f"datasets/{DATASET_ID}/meta.jsonl",
        f"datasets/{DATASET_ID}/train/a.wav",
        f"datasets/{DATASET_ID}/train/b.wav",
    ]
    wave = next(artifact for artifact in api.artifacts.values() if artifact["path"].endswith("a.wav"))
    assert wave["mimeType"].startswith("audio/")


def test_rerun_skips_uploads_of_files_the_project_already_stored(corpus):
    api = FakeDatasetApi()
    with client_for(api) as client:
        first = upload_dataset_directory(client, PROJECT_ID, DATASET_ID, corpus, version="v1")
        (corpus / "train" / "c.wav").write_bytes(b"RIFF-c")
        api.uploaded_paths.clear()
        second = upload_dataset_directory(client, PROJECT_ID, DATASET_ID, corpus, version="v2")
    assert api.uploaded_paths == [f"datasets/{DATASET_ID}/train/c.wav"]
    first_ids = {file["path"]: file["artifactId"] for file in first["files"]}
    second_ids = {file["path"]: file["artifactId"] for file in second["files"]}
    assert {path: second_ids[path] for path in first_ids} == first_ids
    assert second["digest"] != first["digest"]


def test_same_content_under_another_name_reuses_the_stored_artifact(corpus):
    api = FakeDatasetApi()
    (corpus / "copy.wav").write_bytes(b"RIFF-a")
    with client_for(api) as client:
        version = upload_dataset_directory(client, PROJECT_ID, DATASET_ID, corpus)
    ids = {file["path"]: file["artifactId"] for file in version["files"]}
    assert len(api.uploaded_paths) == 3
    assert ids["copy.wav"] == ids["train/a.wav"]


def test_recreating_an_existing_version_raises_the_api_conflict(corpus):
    api = FakeDatasetApi()
    with client_for(api) as client:
        upload_dataset_directory(client, PROJECT_ID, DATASET_ID, corpus, version="v1")
        with pytest.raises(ApiError) as raised:
            upload_dataset_directory(client, PROJECT_ID, DATASET_ID, corpus, version="v1")
    assert raised.value.status_code == 409


def test_empty_directory_and_missing_directory_are_rejected_before_any_request(tmp_path):
    api = FakeDatasetApi()
    (tmp_path / "empty").mkdir()
    with client_for(api) as client:
        with pytest.raises(ConfigurationError, match="no files"):
            upload_dataset_directory(client, PROJECT_ID, DATASET_ID, tmp_path / "empty")
        with pytest.raises(ConfigurationError, match="not a directory"):
            upload_dataset_directory(client, PROJECT_ID, DATASET_ID, tmp_path / "missing")
    assert api.uploaded_paths == []
    assert api.versions == []


def test_manifest_digest_matches_the_api_vector_and_ignores_file_order():
    # Same vector as datasetManifestDigest.test.ts: UTF-8 byte order puts U+FF21 before U+1F600.
    files = [
        LocalDatasetFile(path="\U0001f600.wav", source=Path("unused"), size=1, sha256="e" * 64),
        LocalDatasetFile(path="Ａ.wav", source=Path("unused"), size=2, sha256="f" * 64),
    ]
    expected = "sha256:710944fa3af4b732ca1b3b5f64a70e3bfcffd96c6ddddd094caf21c8d2e71157"
    assert dataset_manifest_digest(files) == expected
    assert dataset_manifest_digest(list(reversed(files))) == expected
