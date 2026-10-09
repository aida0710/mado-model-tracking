"""Resolve a container image tag to its immutable digest with the OCI distribution API.

GET /v2/<repository>/manifests/<tag> asks for an image index or a manifest. A 401 with a Bearer
challenge is answered with a pull token from the registry's realm, anonymous or for
MMT_REGISTRY_USERNAME and MMT_REGISTRY_PASSWORD. The digest is the sha256 of the bytes returned.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from .errors import ConfigurationError
from .http import REQUEST_TIMEOUT_SECONDS

MANIFEST_MEDIA_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)
INDEX_MEDIA_TYPES = set(MANIFEST_MEDIA_TYPES[:2])
DOCKER_HUB = "docker.io"
DOCKER_HUB_API_HOST = "registry-1.docker.io"
DEFAULT_TAG = "latest"
# Registries reached over plain HTTP: only ones on this machine.
LOCAL_REGISTRY_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
REPOSITORY = re.compile(r"^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$")
TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
CHALLENGE_PARAMETER = re.compile(r'(\w+)="([^"]*)"')
MAX_MANIFEST_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class ImageReference:
    registry: str
    repository: str
    tag: str
    digest: str | None = None

    @property
    def host(self) -> str:
        return DOCKER_HUB_API_HOST if self.registry == DOCKER_HUB else self.registry

    @property
    def base_url(self) -> str:
        scheme = "http" if _hostname(self.registry) in LOCAL_REGISTRY_HOSTS else "https"
        return f"{scheme}://{self.host}"

    def pinned(self, digest: str) -> str:
        return f"{self.registry}/{self.repository}@{digest}"


@dataclass(frozen=True)
class ResolvedImage:
    image: str
    digest: str
    # os/architecture[/variant] of an image index; empty for a single-platform manifest.
    platforms: list[str] = field(default_factory=list)


def _hostname(registry: str) -> str:
    """The registry without its port ([::1]:5000 -> [::1], localhost:5000 -> localhost)."""
    if registry.startswith("["):
        return registry.split("]", 1)[0] + "]"
    return registry.rsplit(":", 1)[0]


def parse_image_reference(text: str) -> ImageReference:
    if not text or any(character.isspace() for character in text):
        raise ConfigurationError(f"Invalid image reference {text!r}")
    name, _at, digest = text.partition("@")
    if digest and not DIGEST.fullmatch(digest):
        raise ConfigurationError(f"Image {text!r} has an invalid digest; use sha256:<64 hex>")
    components = name.split("/")
    if len(components) > 1 and ("." in components[0] or ":" in components[0] or components[0] == "localhost"):
        registry, path = components[0], components[1:]
    else:
        registry, path = DOCKER_HUB, components
    last, _colon, tag = path[-1].partition(":")
    path = [*path[:-1], last]
    if registry == DOCKER_HUB and len(path) == 1:
        path = ["library", *path]
    repository = "/".join(path)
    if not REPOSITORY.fullmatch(repository):
        raise ConfigurationError(f"Image {text!r} has an invalid repository name")
    tag = tag or DEFAULT_TAG
    if not TAG.fullmatch(tag):
        raise ConfigurationError(f"Image {text!r} has an invalid tag")
    return ImageReference(registry, repository, tag, digest or None)


def _challenge(header: str) -> tuple[str, dict[str, str]]:
    scheme, _space, rest = header.strip().partition(" ")
    return scheme.lower(), dict(CHALLENGE_PARAMETER.findall(rest))


def _pull_token(
    client: httpx.Client, reference: ImageReference, parameters: dict[str, str], auth: tuple[str, str] | None
) -> str:
    realm = parameters.get("realm", "")
    if not realm.startswith("https://") and not reference.base_url.startswith("http://"):
        raise ConfigurationError("The registry's token realm is not an HTTPS URL")
    query = {"scope": parameters.get("scope") or f"repository:{reference.repository}:pull"}
    if parameters.get("service"):
        query["service"] = parameters["service"]
    response = client.get(realm, params=query, auth=auth)
    if not response.is_success:
        raise ConfigurationError(f"The registry refused a pull token ({response.status_code})")
    body = response.json()
    token = (body.get("token") or body.get("access_token")) if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise ConfigurationError("The registry's token response has no token")
    return token


def _platforms(manifest: Any, media_type: str) -> list[str]:
    if media_type not in INDEX_MEDIA_TYPES or not isinstance(manifest, dict):
        return []
    platforms = []
    for entry in manifest.get("manifests") or []:
        platform = (entry or {}).get("platform") or {}
        if platform.get("os") and platform.get("architecture") and platform.get("os") != "unknown":
            parts = [platform["os"], platform["architecture"], platform.get("variant")]
            platforms.append("/".join(part for part in parts if part))
    return platforms


def resolve_image_digest(
    image: str,
    *,
    username: str | None = None,
    password: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> ResolvedImage:
    """The image pinned to its digest; an image that already names a digest is returned as is."""
    reference = parse_image_reference(image)
    if reference.digest is not None:
        return ResolvedImage(reference.pinned(reference.digest), reference.digest)
    auth = (username, password) if username and password else None
    url = f"{reference.base_url}/v2/{reference.repository}/manifests/{reference.tag}"
    headers = {"Accept": ", ".join(MANIFEST_MEDIA_TYPES)}
    with httpx.Client(transport=transport, timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        try:
            response = client.get(url, headers=headers)
            if response.status_code == 401:
                scheme, parameters = _challenge(response.headers.get("www-authenticate", ""))
                if scheme == "bearer":
                    token = _pull_token(client, reference, parameters, auth)
                    response = client.get(url, headers={**headers, "Authorization": f"Bearer {token}"})
                elif scheme == "basic" and auth is not None:
                    response = client.get(url, headers=headers, auth=auth)
        except httpx.HTTPError as error:
            raise ConfigurationError(f"The registry for {image} could not be reached: {error}") from None
        if response.status_code in {401, 403}:
            raise ConfigurationError(
                f"The registry refused {image}; set MMT_REGISTRY_USERNAME and MMT_REGISTRY_PASSWORD"
            )
        if not response.is_success:
            raise ConfigurationError(f"The registry has no manifest for {image} ({response.status_code})")
        content = response.content
    if len(content) > MAX_MANIFEST_BYTES:
        raise ConfigurationError(f"The manifest of {image} is too large")
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    announced = response.headers.get("docker-content-digest")
    if announced and announced != digest:
        raise ConfigurationError(f"The registry's digest for {image} does not match the manifest it returned")
    try:
        manifest = response.json()
    except ValueError:
        raise ConfigurationError(f"The registry returned an unreadable manifest for {image}") from None
    media_type = response.headers.get("content-type", "").split(";")[0].strip()
    if not media_type and isinstance(manifest, dict):
        media_type = str(manifest.get("mediaType", ""))
    return ResolvedImage(reference.pinned(digest), digest, _platforms(manifest, media_type))
