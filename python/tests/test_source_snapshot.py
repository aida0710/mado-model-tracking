from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import zipfile

import pytest

from mado_tracking.worker.runtime import execution_specification
from mado_tracking.worker.source import extract_archive, materialize_source
from mado_tracking.worker.source_snapshot import create_source_snapshot, read_source_snapshot_chunk
from mado_tracking.worker.source_tree import walk_source_entries


def snapshot_fixture(tmp_path, worker_job, worker_settings):
    source = tmp_path / "source"
    materialize_source(worker_job.code_version["source"], source)
    specification = execution_specification(worker_job, worker_settings)
    return source, specification


def create_snapshot(tmp_path, specification):
    return create_source_snapshot(
        tmp_path, specification, actual_commit=None, check_cancellation=lambda: None
    )


def test_binary_source_is_zipped_and_read_in_bounded_chunks_after_a_failed_execution(
    tmp_path, worker_job, worker_settings
):
    source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    binary = os.urandom(160_000)
    (source / "binary.bin").write_bytes(binary)
    snapshot = create_snapshot(tmp_path, specification)
    state = {"status": "failed", "sourceSnapshot": snapshot}
    descriptor = next(artifact for artifact in snapshot["artifacts"] if artifact["path"] == ".mmt/source.zip")
    received = bytearray()
    while len(received) < descriptor["size"]:
        response = read_source_snapshot_chunk(
            tmp_path, {"path": descriptor["path"], "offset": len(received)}, state
        )
        chunk = base64.b64decode(response["content"])
        assert 0 < len(chunk) <= 64 * 1024
        received.extend(chunk)
    assert hashlib.sha256(received).hexdigest() == descriptor["sha256"]
    with zipfile.ZipFile(tmp_path / "source-snapshot/source.zip") as archive:
        assert archive.read("binary.bin") == binary
    manifest = json.loads((tmp_path / "source-snapshot/source-manifest.json").read_text())
    assert (
        next(file for file in manifest["files"] if file["path"] == "binary.bin")["sha256"]
        == hashlib.sha256(binary).hexdigest()
    )


@pytest.mark.parametrize(
    "path", ["../spec.json", ".mmt/../spec.json", "source.zip", ".mmt/source-manifest.json/extra"]
)
def test_snapshot_protocol_rejects_unreserved_paths(tmp_path, worker_job, worker_settings, path):
    _source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    snapshot = create_snapshot(tmp_path, specification)
    with pytest.raises(ValueError, match="reserved"):
        read_source_snapshot_chunk(tmp_path, {"path": path}, {"sourceSnapshot": snapshot})


@pytest.mark.parametrize("link_kind", ["symlink", "hardlink", "fifo", "directory-symlink", "git-metadata"])
def test_snapshot_never_publishes_links_special_files_or_unregistered_git_metadata(
    tmp_path, worker_job, worker_settings, link_kind
):
    source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    private = tmp_path / "private"
    private.write_bytes(b"private")
    path = source / "bad"
    if link_kind == "symlink":
        path.symlink_to(private)
    elif link_kind == "hardlink":
        os.link(private, path)
    elif link_kind == "fifo":
        os.mkfifo(path)
    elif link_kind == "directory-symlink":
        path.symlink_to(tmp_path, target_is_directory=True)
    else:
        (source / ".git").mkdir()
        (source / ".git/config").write_text("unregistered")
    with pytest.raises(ValueError):
        create_snapshot(tmp_path, specification)
    assert not (tmp_path / "source-snapshot").exists() and not list(tmp_path.glob(".snapshot-*"))


@pytest.mark.parametrize("limit", ["file", "total", "manifest", "zip"])
def test_snapshot_size_failure_never_publishes_partial_evidence(
    tmp_path, worker_job, worker_settings, monkeypatch, limit
):
    _source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    constant = {
        "file": "MAX_SOURCE_FILE_BYTES",
        "total": "MAX_SOURCE_BYTES",
        "manifest": "MAX_MANIFEST_BYTES",
        "zip": "MAX_SNAPSHOT_BYTES",
    }[limit]
    monkeypatch.setattr(f"mado_tracking.worker.source_snapshot.{constant}", 1)
    with pytest.raises(ValueError, match="limit"):
        create_snapshot(tmp_path, specification)
    assert not (tmp_path / "source-snapshot").exists() and not list(tmp_path.glob(".snapshot-*"))


def test_existing_snapshot_cannot_be_replaced_by_modified_source(tmp_path, worker_job, worker_settings):
    source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    snapshot = create_snapshot(tmp_path, specification)
    original_zip = (tmp_path / "source-snapshot/source.zip").read_bytes()
    (source / "main.py").write_text("changed")
    with pytest.raises(ValueError, match="already exists"):
        create_snapshot(tmp_path, specification)
    assert (tmp_path / "source-snapshot/source.zip").read_bytes() == original_zip
    state = {"sourceSnapshot": snapshot}
    path = tmp_path / "source-snapshot/source.zip"
    path.unlink()
    path.symlink_to(tmp_path / "private")
    with pytest.raises(OSError):
        read_source_snapshot_chunk(tmp_path, {"path": ".mmt/source.zip"}, state)


@pytest.mark.parametrize("format", ["zip", "tar"])
def test_artifact_snapshot_restores_empty_directories_and_runs_the_same_entrypoint(
    tmp_path, worker_job, worker_settings, format
):
    directories = {"cache": 0o755, "empty": 0o755, "empty/nested": 0o755, "readonly": 0o555}
    files = {
        "main.py": (
            "from pathlib import Path\n"
            "assert Path('empty/nested').is_dir()\n"
            "Path('cache/output.txt').write_text(Path('readonly/reference.txt').read_text())\n"
        ),
        "readonly/reference.txt": "reproducible output",
    }
    artifact = tmp_path / f"input.{format}"
    if format == "zip":
        with zipfile.ZipFile(artifact, "w") as archive:
            for name, mode in directories.items():
                member = zipfile.ZipInfo(name + "/")
                member.external_attr = (stat.S_IFDIR | mode) << 16 | 0x10
                archive.writestr(member, b"")
            for name, content in files.items():
                archive.writestr(name, content)
    else:
        with tarfile.open(artifact, "w") as archive:
            for name, mode in directories.items():
                member = tarfile.TarInfo(name)
                member.type, member.mode = tarfile.DIRTYPE, mode
                archive.addfile(member)
            for name, content in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(content.encode())
                archive.addfile(member, io.BytesIO(content.encode()))
    worker_job.code_version["source"] = {"kind": "artifact", "artifactId": "source-artifact"}
    source = tmp_path / "source"
    materialize_source(worker_job.code_version["source"], source, artifact=artifact)
    create_snapshot(tmp_path, execution_specification(worker_job, worker_settings))
    subprocess.run([sys.executable, "main.py"], cwd=source, check=True)
    restored = tmp_path / "restored"
    extract_archive(tmp_path / "source-snapshot/source.zip", restored)
    assert not (restored / "cache/output.txt").exists()
    subprocess.run([sys.executable, "main.py"], cwd=restored, check=True)
    assert (source / "cache/output.txt").read_text() == (restored / "cache/output.txt").read_text()
    assert stat.S_IMODE((restored / "readonly").stat().st_mode) == 0o555
    manifest = json.loads((tmp_path / "source-snapshot/source-manifest.json").read_text())
    assert {item["path"]: item["mode"] for item in manifest["directories"]} == directories
    assert {item["path"] for item in manifest["files"]} == set(files)


def test_empty_directories_exceeding_the_entry_limit_never_publish_a_snapshot(
    tmp_path, worker_job, worker_settings, monkeypatch
):
    source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    for name in ("first", "second", "third"):
        (source / name).mkdir()
    monkeypatch.setattr("mado_tracking.worker.source_tree.MAX_SOURCE_ENTRIES", 3)
    with pytest.raises(ValueError, match="directory count limit"):
        create_snapshot(tmp_path, specification)
    assert not (tmp_path / "source-snapshot").exists()


def test_implicit_archive_directories_are_bounded_before_any_extraction(tmp_path, monkeypatch):
    artifact = tmp_path / "deep.zip"
    with zipfile.ZipFile(artifact, "w") as archive:
        archive.writestr("first/second/main.py", "print('code')")
    monkeypatch.setattr("mado_tracking.worker.source.MAX_SOURCE_ENTRIES", 2)
    with pytest.raises(ValueError, match="directory count limit"):
        materialize_source(
            {"kind": "artifact", "artifactId": "source"}, tmp_path / "source", artifact=artifact
        )
    assert not (tmp_path / "source").exists()


def test_verified_git_metadata_is_excluded_but_nested_git_and_directory_links_are_rejected(tmp_path):
    source = tmp_path / "source"
    (source / ".git/objects").mkdir(parents=True)
    (source / "empty").mkdir()
    assert [entry.relative_path for entry in walk_source_entries(source, has_git_metadata=True)] == ["empty"]
    (source / "empty/.git").mkdir()
    with pytest.raises(ValueError, match=".git"):
        list(walk_source_entries(source, has_git_metadata=True))
    (source / "empty/.git").rmdir()
    (source / "link").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        list(walk_source_entries(source, has_git_metadata=True))


@pytest.mark.parametrize("extra_byte", [False, True])
def test_source_archive_limit_accepts_the_snapshot_at_the_limit_and_rejects_a_larger_one(
    tmp_path, worker_job, worker_settings, monkeypatch, extra_byte
):
    source, specification = snapshot_fixture(tmp_path, worker_job, worker_settings)
    (source / "empty").mkdir()
    create_snapshot(tmp_path, specification)
    artifact = tmp_path / "source-snapshot/source.zip"
    monkeypatch.setattr("mado_tracking.worker.source.MAX_SOURCE_ARCHIVE_BYTES", artifact.stat().st_size)
    if extra_byte:
        with artifact.open("ab") as output:
            output.write(b"x")
        with pytest.raises(ValueError, match="size limit"):
            extract_archive(artifact, tmp_path / "restored")
    else:
        extract_archive(artifact, tmp_path / "restored")
        assert (tmp_path / "restored/empty").is_dir()
