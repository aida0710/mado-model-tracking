"""Job templates: mmt-job.toml, tag → digest through the OCI distribution API, registration."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import httpx
import pytest

from mado_tracking.client import Client
from mado_tracking.code_cli import register_template
from mado_tracking.errors import ConfigurationError
from mado_tracking.image_digest import parse_image_reference, resolve_image_digest
from mado_tracking.job_template import default_version, load_job_template

COMMIT = "0123456789abcdef0123456789abcdef01234567"
TEMPLATE = f"""
name = "tts-gen"
image = "forge.example.org/team/tts-gen:2026-10"
command = ["python", "-m", "gen.run", "--config", "configs/base.yaml"]
working_directory = "/mmt/source"
task_types = ["processing"]
model_families = ["vits"]
description = "Synthetic speech"

[source]
url = "https://forge.example.org/team/tts-gen.git"
commit = "{COMMIT}"

[environment]
HF_HUB_OFFLINE = "1"
"""
INDEX = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [
        {"digest": "sha256:" + "1" * 64, "platform": {"os": "linux", "architecture": "amd64"}},
        {
            "digest": "sha256:" + "2" * 64,
            "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"},
        },
        {"digest": "sha256:" + "3" * 64, "platform": {"os": "unknown", "architecture": "unknown"}},
    ],
}


def write_template(tmp_path: Path, text: str = TEMPLATE) -> Path:
    path = tmp_path / "mmt-job.toml"
    path.write_text(text)
    return path


def test_a_template_is_read_strictly(tmp_path):
    template = load_job_template(write_template(tmp_path))
    assert template.command == ("python", "-m", "gen.run", "--config", "configs/base.yaml")
    assert template.source == {
        "kind": "git",
        "url": "https://forge.example.org/team/tts-gen.git",
        "commit": COMMIT,
    }
    assert template.environment == {"HF_HUB_OFFLINE": "1"} and template.task_types == ("processing",)
    assert default_version(template, "sha256:" + "f" * 64) == f"{COMMIT[:12]}-{'f' * 12}"
    for broken, message in (
        ("resources = { gpus = 1 }\n" + TEMPLATE, "resources"),
        (TEMPLATE.replace(COMMIT, "main"), "commit"),
        (TEMPLATE.replace('"/mmt/source"', '"relative"'), "working_directory"),
        (TEMPLATE.replace('["processing"]', '["sweeping"]'), "task_types"),
    ):
        with pytest.raises(ConfigurationError, match=message):
            load_job_template(write_template(tmp_path, broken))


@pytest.mark.parametrize(
    ("image", "registry", "repository", "tag", "base_url"),
    [
        ("python:3.12", "docker.io", "library/python", "3.12", "https://registry-1.docker.io"),
        ("team/tts", "docker.io", "team/tts", "latest", "https://registry-1.docker.io"),
        (
            "forge.example.org:5000/team/tts:2026-10",
            "forge.example.org:5000",
            "team/tts",
            "2026-10",
            "https://forge.example.org:5000",
        ),
        ("localhost:5000/tts:dev", "localhost:5000", "tts", "dev", "http://localhost:5000"),
    ],
)
def test_image_references_are_split_like_docker(image, registry, repository, tag, base_url):
    reference = parse_image_reference(image)
    assert (reference.registry, reference.repository, reference.tag, reference.base_url) == (
        registry,
        repository,
        tag,
        base_url,
    )


class Registry:
    """A registry that wants a Bearer token from its realm, like Docker Hub and Forgejo."""

    def __init__(self, *, announced_digest: str | None = None, require_login: bool = False):
        self.body = json.dumps(INDEX).encode()
        self.digest = "sha256:" + hashlib.sha256(self.body).hexdigest()
        self.announced_digest = announced_digest or self.digest
        self.require_login = require_login
        self.token_requests: list[httpx.Request] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "auth.example.org":
            self.token_requests.append(request)
            if (
                self.require_login
                and request.headers.get("Authorization")
                != "Basic " + base64.b64encode(b"puller:secret").decode()
            ):
                return httpx.Response(401, json={"errors": []})
            return httpx.Response(200, json={"token": "pull-token"})
        assert request.url.path == "/v2/team/tts-gen/manifests/2026-10"
        assert "application/vnd.oci.image.index.v1+json" in request.headers["Accept"]
        if request.headers.get("Authorization") != "Bearer pull-token":
            challenge = 'Bearer realm="https://auth.example.org/token",service="forge.example.org",scope="repository:team/tts-gen:pull"'
            return httpx.Response(401, headers={"WWW-Authenticate": challenge})
        return httpx.Response(
            200,
            content=self.body,
            headers={"Content-Type": INDEX["mediaType"], "Docker-Content-Digest": self.announced_digest},
        )


def test_a_tag_resolves_to_the_digest_of_the_manifest_bytes_with_an_anonymous_token():
    registry = Registry()
    resolved = resolve_image_digest(
        "forge.example.org/team/tts-gen:2026-10", transport=httpx.MockTransport(registry.serve)
    )
    assert resolved.image == f"forge.example.org/team/tts-gen@{registry.digest}"
    assert resolved.platforms == ["linux/amd64", "linux/arm64/v8"]
    [token_request] = registry.token_requests
    assert token_request.url.params["scope"] == "repository:team/tts-gen:pull"
    assert (
        token_request.url.params["service"] == "forge.example.org"
        and "Authorization" not in token_request.headers
    )


def test_a_private_registry_gets_the_credentials_and_a_wrong_digest_is_refused():
    registry = Registry(require_login=True)
    transport = httpx.MockTransport(registry.serve)
    with pytest.raises(ConfigurationError, match="pull token"):
        resolve_image_digest("forge.example.org/team/tts-gen:2026-10", transport=transport)
    resolved = resolve_image_digest(
        "forge.example.org/team/tts-gen:2026-10", username="puller", password="secret", transport=transport
    )
    assert resolved.digest == registry.digest
    lying = Registry(announced_digest="sha256:" + "0" * 64)
    with pytest.raises(ConfigurationError, match="does not match"):
        resolve_image_digest(
            "forge.example.org/team/tts-gen:2026-10", transport=httpx.MockTransport(lying.serve)
        )


def test_a_pinned_image_needs_no_registry():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    pinned = "python@sha256:" + "a" * 64
    resolved = resolve_image_digest(pinned, transport=httpx.MockTransport(refuse))
    assert resolved.image == "docker.io/library/python@sha256:" + "a" * 64


class RegistryApi:
    def __init__(self, codes: list[dict]):
        self.codes = codes
        self.requests: list[tuple[str, str, dict]] = []

    def serve(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append((request.method, request.url.path, body))
        if request.method == "GET" and request.url.path.endswith("/codes"):
            return httpx.Response(200, json={"items": self.codes})
        if request.url.path.endswith("/codes"):
            return httpx.Response(201, json={"id": "code-new", **body})
        return httpx.Response(
            201, json={"id": "version-1", "codeId": request.url.path.split("/")[-2], **body}
        )


@pytest.mark.parametrize("existing", [False, True])
def test_register_adds_a_version_to_the_named_code_with_the_pinned_image(tmp_path, existing):
    template = load_job_template(write_template(tmp_path))
    resolved = resolve_image_digest(
        "forge.example.org/team/tts-gen:2026-10", transport=httpx.MockTransport(Registry().serve)
    )
    api = RegistryApi([{"id": "code-old", "name": "tts-gen"}] if existing else [])
    with Client(
        api_url="http://api.invalid", api_token="mmt_token", transport=httpx.MockTransport(api.serve)
    ) as client:
        version = register_template(
            client, "project-1", template, resolved, code_name="tts-gen", version="v1"
        )
    posts = [(path, body) for method, path, body in api.requests if method == "POST"]
    assert [path for path, _body in posts][
        -1
    ] == f"/api/projects/project-1/codes/{'code-old' if existing else 'code-new'}/versions"
    assert len(posts) == (1 if existing else 2)
    body = posts[-1][1]
    assert body["runtime"] == {"kind": "docker", "image": resolved.image, "workingDirectory": "/mmt/source"}
    assert body["entrypoint"][:3] == ["python", "-m", "gen.run"] and body["source"]["commit"] == COMMIT
    assert body["taskTypes"] == ["processing"] and body["supportedModelFamilies"] == ["vits"]
    assert version["version"] == "v1"


def test_the_example_template_is_valid():
    example = Path(__file__).resolve().parent.parent / "examples" / "mmt-job.toml"
    template = load_job_template(example)
    assert template.name == "tts-gen" and template.source is not None
