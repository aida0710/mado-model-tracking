"""Target-side downloads of dataset files into a cache entry's data directory.

Sources: a relayed tar from the worker, the API with the Job token ('direct' transfer), an
unauthenticated HTTPS URL, and S3 with the target's own AWS_* environment. Runs inside the
target runner bundle, so it uses the standard library only.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import re
import ssl
import tarfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ElementTree
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import IO, Any
from urllib.parse import quote, unquote, urlsplit

from ..checkpoint_archive import is_safe_relative_path

DOWNLOAD_CHUNK_BYTES = 1024 * 1024
# A stalled socket fails the fetch instead of holding the Job's GPU reservation indefinitely.
SOCKET_TIMEOUT_SECONDS = 60.0
# Same bound as an 'artifacts' DatasetVersion (MAX_DATASET_VERSION_FILES in contracts).
MAX_DATASET_FILES = 100_000
# A URL whose path has no usable last segment is stored under this name.
DEFAULT_REFERENCE_FILE_NAME = "data"
S3_NAMESPACE = "{http://s3.amazonaws.com/doc/2006-03-01/}"
S3_DEFAULT_REGION = "us-east-1"
# Bucket names that are valid DNS labels can use the virtual-hosted AWS endpoint.
S3_VIRTUAL_HOST_BUCKET = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
S3_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
# Only a reference digest in this form says which bytes the downloaded file must have.
SHA256_DIGEST = re.compile(r"^(?:sha256:)?([a-f0-9]{64})$")


class DatasetFetchError(Exception):
    """A dataset source refused or failed. `retryable` marks network and server-side failures."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect could send the Job token, or the target's S3 signature, to another host.
    def redirect_request(self, *_arguments: Any, **_options: Any) -> None:
        raise DatasetFetchError("Dataset download refused an HTTP redirect")


def _open(request: urllib.request.Request, *, context: ssl.SSLContext | None = None) -> Any:
    opener = urllib.request.build_opener(_RefuseRedirect(), urllib.request.HTTPSHandler(context=context))
    try:
        return opener.open(request, timeout=SOCKET_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as error:
        error.close()
        raise DatasetFetchError(
            f"Dataset download failed with HTTP {error.code}",
            retryable=error.code >= 500 or error.code in {408, 429},
        ) from None
    except (urllib.error.URLError, OSError) as error:
        raise DatasetFetchError(f"Dataset download could not connect: {error}", retryable=True) from None


def _safe_destination(data_directory: Path, relative_path: str) -> Path:
    if not is_safe_relative_path(relative_path):
        raise DatasetFetchError(f"Unsafe dataset file path: {relative_path!r}")
    destination = data_directory / relative_path
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        raise DatasetFetchError(f"Duplicate dataset file path: {relative_path!r}")
    return destination


def write_stream(source: IO[bytes], destination: Path, *, maximum_bytes: int | None) -> tuple[str, int]:
    checksum, size = hashlib.sha256(), 0
    with destination.open("xb") as output:
        while chunk := source.read(DOWNLOAD_CHUNK_BYTES):
            size += len(chunk)
            if maximum_bytes is not None and size > maximum_bytes:
                raise DatasetFetchError("Dataset download exceeds the target's dataset cache limit")
            checksum.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return checksum.hexdigest(), size


def _download(
    request: urllib.request.Request,
    destination: Path,
    *,
    maximum_bytes: int | None,
    context: ssl.SSLContext | None = None,
) -> tuple[str, int]:
    try:
        with _open(request, context=context) as response:
            if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                raise DatasetFetchError("Dataset download arrived encoded; identity was requested")
            declared = response.headers.get("Content-Length")
            checksum, size = write_stream(response, destination, maximum_bytes=maximum_bytes)
    except OSError as error:
        if isinstance(error, DatasetFetchError):
            raise
        raise DatasetFetchError(f"Dataset download was interrupted: {error}", retryable=True) from None
    if declared is not None and int(declared) != size:
        raise DatasetFetchError("Dataset download ended before its Content-Length", retryable=True)
    return checksum, size


def receive_relayed_tar(stream: IO[bytes], data_directory: Path, files: list[dict[str, Any]]) -> None:
    """Extract the worker's tar of regular files; only the listed paths are accepted."""
    expected = {file["path"]: file for file in files}
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            if not member.isfile() or member.name not in expected:
                raise DatasetFetchError(f"Relayed dataset contains an unexpected entry: {member.name!r}")
            content = archive.extractfile(member)
            assert content is not None
            write_stream(content, _safe_destination(data_directory, member.name), maximum_bytes=member.size)


def fetch_api_files(
    data_directory: Path, files: list[dict[str, Any]], *, api_url: str, project_id: str, token: str
) -> None:
    """'direct' transfer: the target reads each Artifact with the Job token."""
    for file in files:
        request = urllib.request.Request(
            f"{api_url.rstrip('/')}/projects/{quote(project_id)}/artifacts/{quote(file['artifactId'])}/content",
            headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
        )
        _download(request, _safe_destination(data_directory, file["path"]), maximum_bytes=file["size"])


def reference_file_name(uri: str) -> str:
    """The file name an HTTPS reference is stored under: the URL's last path segment."""
    name = PurePosixPath(unquote(urlsplit(uri).path)).name
    return name if is_safe_relative_path(name) else DEFAULT_REFERENCE_FILE_NAME


def expected_reference_sha256(digest: str) -> str | None:
    """The sha256 an HTTPS reference must have, when its digest is written as one."""
    match = SHA256_DIGEST.fullmatch(digest)
    return match.group(1) if match else None


def validate_https_uri(uri: str) -> None:
    location = urlsplit(uri)
    if location.scheme != "https" or not location.hostname or location.username or location.password:
        raise DatasetFetchError("HTTPS dataset references need an https:// URI without credentials")


def fetch_https(data_directory: Path, uri: str, *, maximum_bytes: int) -> dict[str, Any]:
    validate_https_uri(uri)
    request = urllib.request.Request(uri, headers={"Accept-Encoding": "identity"})
    name = reference_file_name(uri)
    checksum, size = _download(request, _safe_destination(data_directory, name), maximum_bytes=maximum_bytes)
    return {"path": name, "sha256": checksum, "size": size}


def resolve_file_reference(uri: str) -> Path:
    """A file:// reference names data already on the target; it is read in place, not copied."""
    location = urlsplit(uri)
    if location.netloc not in {"", "localhost"} or location.query or location.fragment:
        raise DatasetFetchError("file:// dataset references must name a local absolute path")
    path = Path(unquote(location.path))
    if not path.is_absolute():
        raise DatasetFetchError("file:// dataset references must name a local absolute path")
    if not path.exists():
        raise DatasetFetchError(f"Dataset path does not exist on the target: {path}")
    if not os.access(path, os.R_OK):
        raise DatasetFetchError(f"Dataset path is not readable on the target: {path}")
    return path.resolve()


class S3Location:
    """Where to send requests for s3://bucket/key, configured from the target's environment."""

    def __init__(self, uri: str, environment: Mapping[str, str]):
        location = urlsplit(uri)
        if location.scheme != "s3" or not location.netloc or location.query or location.fragment:
            raise DatasetFetchError("S3 dataset references must be s3://bucket/key")
        self.bucket = location.netloc
        self.key = unquote(location.path.lstrip("/"))
        self.region = (
            environment.get("AWS_REGION") or environment.get("AWS_DEFAULT_REGION") or S3_DEFAULT_REGION
        )
        endpoint = environment.get("AWS_ENDPOINT_URL_S3") or environment.get("AWS_ENDPOINT_URL")
        if endpoint:
            # Self-hosted S3-compatible stores (MinIO and the like) usually only route paths.
            self.base_url, self.bucket_path = endpoint.rstrip("/"), "/" + quote(self.bucket, safe="")
        elif S3_VIRTUAL_HOST_BUCKET.fullmatch(self.bucket):
            self.base_url, self.bucket_path = f"https://{self.bucket}.s3.{self.region}.amazonaws.com", ""
        else:
            self.base_url = f"https://s3.{self.region}.amazonaws.com"
            self.bucket_path = "/" + quote(self.bucket, safe="")
        self.access_key = environment.get("AWS_ACCESS_KEY_ID")
        self.secret_key = environment.get("AWS_SECRET_ACCESS_KEY")
        self.session_token = environment.get("AWS_SESSION_TOKEN")
        ca_bundle = environment.get("AWS_CA_BUNDLE")
        self.context = ssl.create_default_context(cafile=ca_bundle) if ca_bundle else None

    def request(self, key: str | None, query: dict[str, str]) -> urllib.request.Request:
        path = self.bucket_path + ("/" + quote(key, safe="/~") if key is not None else "/")
        canonical_query = "&".join(
            f"{quote(name, safe='~')}={quote(value, safe='~')}" for name, value in sorted(query.items())
        )
        url = self.base_url + path + (f"?{canonical_query}" if canonical_query else "")
        headers: dict[str, str] = {"Accept-Encoding": "identity"}
        if self.access_key and self.secret_key:
            headers.update(
                sign_s3_request(
                    method="GET",
                    url=url,
                    region=self.region,
                    access_key=self.access_key,
                    secret_key=self.secret_key,
                    session_token=self.session_token,
                    now=datetime.datetime.now(datetime.UTC),
                )
            )
        return urllib.request.Request(url, headers=headers)


def sign_s3_request(
    *,
    method: str,
    url: str,
    region: str,
    access_key: str,
    secret_key: str,
    session_token: str | None,
    now: datetime.datetime,
) -> dict[str, str]:
    """AWS Signature Version 4 headers for a body-less S3 request (UNSIGNED-PAYLOAD)."""
    location = urlsplit(url)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz_date[:8]
    headers = {
        "host": location.netloc,
        "x-amz-content-sha256": S3_UNSIGNED_PAYLOAD,
        "x-amz-date": amz_date,
    }
    if session_token:
        headers["x-amz-security-token"] = session_token
    signed_headers = ";".join(sorted(headers))
    canonical_request = "\n".join(
        [
            method,
            location.path or "/",
            location.query,
            "".join(f"{name}:{headers[name].strip()}\n" for name in sorted(headers)),
            signed_headers,
            S3_UNSIGNED_PAYLOAD,
        ]
    )
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()]
    )
    signing_key = f"AWS4{secret_key}".encode()
    for part in (date, region, "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    signed = {name: value for name, value in headers.items() if name != "host"}
    signed["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return signed


def _list_s3_objects(location: S3Location, prefix: str) -> list[tuple[str, int]]:
    objects: list[tuple[str, int]] = []
    continuation: str | None = None
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if continuation:
            query["continuation-token"] = continuation
        with _open(location.request(None, query), context=location.context) as response:
            document = ElementTree.fromstring(response.read())
        for content in document.iter(f"{S3_NAMESPACE}Contents"):
            objects.append(
                (
                    content.findtext(f"{S3_NAMESPACE}Key", ""),
                    int(content.findtext(f"{S3_NAMESPACE}Size", "0")),
                )
            )
            if len(objects) > MAX_DATASET_FILES:
                raise DatasetFetchError(f"S3 dataset has more than {MAX_DATASET_FILES} objects")
        continuation = document.findtext(f"{S3_NAMESPACE}NextContinuationToken")
        if document.findtext(f"{S3_NAMESPACE}IsTruncated") != "true" or not continuation:
            return objects


def plan_s3_files(location: S3Location) -> list[dict[str, Any]]:
    """One object when the key names it exactly; otherwise every object below key/ (a folder)."""
    if location.key and not location.key.endswith("/"):
        exact = [size for key, size in _list_s3_objects(location, location.key) if key == location.key]
        if exact:
            return [{"key": location.key, "path": PurePosixPath(location.key).name, "size": exact[0]}]
    prefix = location.key if not location.key or location.key.endswith("/") else location.key + "/"
    files = [
        {"key": key, "path": key[len(prefix) :], "size": size}
        for key, size in _list_s3_objects(location, prefix)
        # Zero-byte keys ending in '/' are folder markers that consoles create.
        if not key.endswith("/")
    ]
    if not files:
        raise DatasetFetchError(f"S3 dataset reference has no objects: s3://{location.bucket}/{location.key}")
    return files


def fetch_s3(
    data_directory: Path, uri: str, *, maximum_bytes: int, environment: Mapping[str, str]
) -> list[dict[str, Any]]:
    location = S3Location(uri, environment)
    files = plan_s3_files(location)
    if sum(file["size"] for file in files) > maximum_bytes:
        raise DatasetFetchError("S3 dataset is larger than the target's dataset cache limit")
    fetched = []
    for file in files:
        checksum, size = _download(
            location.request(file["key"], {}),
            _safe_destination(data_directory, file["path"]),
            maximum_bytes=file["size"],
            context=location.context,
        )
        fetched.append({"path": file["path"], "sha256": checksum, "size": size})
    return fetched
