from __future__ import annotations

import asyncio
import gzip
import hashlib
import io
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from mado_tracking.errors import ApiError
from mado_tracking.worker.api import WorkerApi
from mado_tracking.worker.session_inputs import download_external_weights

# Repeated binary weights make the transfer and stored sizes intentionally different.
WEIGHTS = bytes(range(256)) * 64


@pytest.fixture
def download_server():
    response = {"body": b"", "encoding": None, "length": None}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_arguments):
            pass

        def do_GET(self):
            requests.append(self.headers.get("Authorization"))
            self.send_response(200)
            if response["encoding"] is not None:
                self.send_header("Content-Encoding", response["encoding"])
            if response["length"] is not None:
                self.send_header("Content-Length", str(response["length"]))
            self.end_headers()
            body = response["body"]
            # Split the encoded body so decoder completion crosses HTTP stream chunks.
            for offset in range(0, len(body), 17):
                self.wfile.write(body[offset : offset + 17])
                self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", response, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


async def download_from(url, *, kind, destination):
    if kind == "external":
        return await download_external_weights(url + "/weights", destination)
    api = WorkerApi(url=url, token="download-fixture-token")
    try:
        return await api.download_artifact("project", "artifact", destination)
    finally:
        await api.close()


async def download_mock_response(response):
    api = WorkerApi(
        url="http://localhost",
        token="download-fixture-token",
        transport=httpx.MockTransport(lambda _request: response),
    )
    try:
        destination = io.BytesIO()
        metadata = await api.download_artifact("project", "artifact", destination)
        return metadata, destination.getvalue()
    finally:
        await api.close()


@pytest.mark.parametrize("kind", ["external", "artifact"])
@pytest.mark.parametrize("encoding", ["gzip", "deflate", "raw-deflate", "gzip-members", "gzip-deflate"])
def test_encoded_download_checks_transfer_length_and_returns_decoded_weights_hash(
    download_server, kind, encoding
):
    url, response, requests = download_server
    header = encoding
    if encoding == "raw-deflate":
        compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
        encoded = compressor.compress(WEIGHTS) + compressor.flush()
        header = "deflate"
    elif encoding == "gzip-members":
        encoded = gzip.compress(WEIGHTS[:100]) + gzip.compress(WEIGHTS[100:])
        header = "gzip"
    elif encoding == "gzip-deflate":
        encoded = zlib.compress(gzip.compress(WEIGHTS))
        header = "gzip, deflate"
    else:
        encoded = gzip.compress(WEIGHTS) if encoding == "gzip" else zlib.compress(WEIGHTS)
    assert len(encoded) != len(WEIGHTS)
    response.update(body=encoded, encoding=header, length=len(encoded))
    destination = io.BytesIO()
    metadata = asyncio.run(download_from(url, kind=kind, destination=destination))
    assert destination.getvalue() == WEIGHTS
    assert metadata == {"sha256": hashlib.sha256(WEIGHTS).hexdigest(), "size": len(WEIGHTS)}
    assert requests == [None if kind == "external" else "Bearer download-fixture-token"]


@pytest.mark.parametrize("kind", ["external", "artifact"])
@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("failure", ["wire-cut", "trailer-cut", "no-length-cut", "invalid-checksum"])
def test_incomplete_or_corrupt_encoded_download_is_rejected_before_it_can_be_staged(
    download_server, kind, encoding, failure
):
    url, response, _requests = download_server
    encoded = gzip.compress(WEIGHTS) if encoding == "gzip" else zlib.compress(WEIGHTS)
    trailer_bytes = 8 if encoding == "gzip" else 4
    if failure == "invalid-checksum":
        body = encoded[:-trailer_bytes] + bytes([encoded[-trailer_bytes] ^ 1]) + encoded[-trailer_bytes + 1 :]
    else:
        body = encoded[:-trailer_bytes]
    length = len(encoded) if failure == "wire-cut" else len(body)
    response.update(body=body, encoding=encoding, length=None if failure == "no-length-cut" else length)
    with pytest.raises(ApiError):
        asyncio.run(download_from(url, kind=kind, destination=io.BytesIO()))


def test_cached_httpx_response_does_not_compare_decoded_weights_to_encoded_content_length():
    encoded = gzip.compress(WEIGHTS)
    response = httpx.Response(
        200, headers={"Content-Encoding": "gzip", "Content-Length": str(len(encoded))}, content=encoded
    )
    metadata, saved = asyncio.run(download_mock_response(response))
    assert saved == WEIGHTS
    assert metadata == {"sha256": hashlib.sha256(WEIGHTS).hexdigest(), "size": len(WEIGHTS)}


@pytest.mark.parametrize("with_content_length", [False, True])
def test_cached_httpx_response_cannot_hide_missing_gzip_trailer_in_already_decoded_weights(
    with_content_length,
):
    encoded = gzip.compress(WEIGHTS)[:-8]
    response = httpx.Response(200, headers={"Content-Encoding": "gzip"}, content=encoded)
    assert response.content == WEIGHTS, "HTTPX alone has not noticed the missing gzip trailer"
    if not with_content_length:
        del response.headers["Content-Length"]
    with pytest.raises(ApiError, match="invalid"):
        asyncio.run(download_mock_response(response))


def test_cached_unencoded_response_still_rejects_an_incorrect_transfer_length():
    response = httpx.Response(200, headers={"Content-Length": "100"}, content=b"cut")
    with pytest.raises(ApiError, match="transfer size mismatch"):
        asyncio.run(download_mock_response(response))


def test_transfer_size_mismatch_from_a_streaming_transport_is_not_mistaken_for_decoded_size():
    encoded = gzip.compress(WEIGHTS)

    class EncodedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield encoded

    response = httpx.Response(
        200,
        headers={"Content-Encoding": "gzip", "Content-Length": str(len(WEIGHTS))},
        stream=EncodedStream(),
    )
    with pytest.raises(ApiError, match="transfer size mismatch"):
        asyncio.run(download_mock_response(response))
