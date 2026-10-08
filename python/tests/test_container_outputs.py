from __future__ import annotations

import base64
import hashlib
import json
import os

import pytest

from mado_tracking.worker.container_outputs import read_output_chunk, validate_results


def completed_result(root, *, content=b'[{"prediction":0.9}]'):
    (root / "predictions.json").write_bytes(content)
    manifest = {
        "version": 1,
        "complete": True,
        "artifacts": [
            {"path": "predictions.json", "sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
        ],
        "metrics": [{"name": "accuracy", "value": 0.9}],
    }
    (root / "result.json").write_text(json.dumps(manifest))
    return manifest


def test_completed_files_are_verified_and_read_in_bounded_chunks_with_stable_metric_timestamps(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    content = b"output" * 30_000
    completed_result(outputs, content=content)
    results = validate_results(outputs)
    assert results["metrics"][0]["step"] == 0
    assert results["metrics"][0]["timestamp"].endswith("Z")
    state = {"status": "finished", "results": results}
    offset, received = 0, bytearray()
    while offset < len(content):
        chunk = read_output_chunk(tmp_path, {"path": "predictions.json", "offset": offset}, state)
        assert chunk["nextOffset"] > offset
        received.extend(base64.b64decode(chunk["content"]))
        offset = chunk["nextOffset"]
    assert received == content
    with pytest.raises(ValueError, match="declared"):
        read_output_chunk(tmp_path, {"path": "../spec.json"}, state)


@pytest.mark.parametrize(
    "path", ["../private", "/etc/passwd", "nested/../../private", "x\\y", "predictions.partial"]
)
def test_result_manifest_rejects_paths_outside_outputs_or_unfinished_names(tmp_path, path):
    manifest = completed_result(tmp_path)
    manifest["artifacts"][0]["path"] = path
    (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Output path"):
        validate_results(tmp_path)


@pytest.mark.parametrize("link_kind", ["file-symlink", "directory-symlink", "hardlink", "fifo"])
def test_result_collection_never_follows_links_or_reads_special_files(tmp_path, link_kind):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    completed_result(outputs)
    private = tmp_path / "private"
    private.write_bytes(b"private bytes")
    path = outputs / "predictions.json"
    path.unlink()
    if link_kind == "file-symlink":
        path.symlink_to(private)
    elif link_kind == "directory-symlink":
        path.write_bytes(b"output")
        (outputs / "nested").symlink_to(tmp_path, target_is_directory=True)
    elif link_kind == "hardlink":
        os.link(private, path)
    else:
        os.mkfifo(path)
    with pytest.raises((ValueError, OSError)):
        validate_results(outputs)


@pytest.mark.parametrize(
    "change", ["no-manifest", "incomplete", "sha-mismatch", "size-mismatch", "undeclared", "partial"]
)
def test_missing_or_incomplete_outputs_cannot_be_reported_as_success(tmp_path, change):
    manifest = completed_result(tmp_path)
    if change == "no-manifest":
        (tmp_path / "result.json").unlink()
    else:
        if change == "incomplete":
            manifest["complete"] = False
        elif change == "sha-mismatch":
            manifest["artifacts"][0]["sha256"] = "0" * 64
        elif change == "size-mismatch":
            manifest["artifacts"][0]["size"] += 1
        else:
            (tmp_path / ("extra.txt" if change == "undeclared" else "download.partial")).write_text(
                "incomplete"
            )
        (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        validate_results(tmp_path)


@pytest.mark.parametrize(
    "metric",
    [
        {"name": "loss", "value": float("nan")},
        {"name": "loss", "value": float("inf")},
        {"name": "loss", "value": True},
        {"name": "loss", "value": 0, "step": -1},
        {"name": "loss", "value": 0, "timestamp": "2026-10-08"},
        {"name": "", "value": 0},
    ],
)
def test_invalid_metrics_fail_result_validation_before_any_file_is_uploaded(tmp_path, metric):
    manifest = completed_result(tmp_path)
    manifest["metrics"] = [metric]
    (tmp_path / "result.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        validate_results(tmp_path)


def test_read_after_completion_rejects_new_symlinks_and_changed_file_sizes(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    completed_result(outputs)
    state = {"status": "finished", "results": validate_results(outputs)}
    path = outputs / "predictions.json"
    path.write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed"):
        read_output_chunk(tmp_path, {"path": "predictions.json"}, state)
    path.unlink()
    path.symlink_to(tmp_path / "spec.json")
    with pytest.raises(OSError):
        read_output_chunk(tmp_path, {"path": "predictions.json"}, state)
