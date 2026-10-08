from __future__ import annotations

import io
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from mado_tracking.worker.source import extract_archive, materialize_source


@pytest.mark.parametrize(
    "unsafe", ["../outside.py", "/absolute.py", "dir/../../escape", "C:/evil", "dir\\evil"]
)
def test_inline_source_cannot_escape_workspace(tmp_path: Path, unsafe: str):
    with pytest.raises(ValueError):
        materialize_source({"kind": "inline", "files": {unsafe: "bad"}}, tmp_path / "source")


@pytest.mark.parametrize("format", ["zip", "tar"])
def test_artifact_source_extracts_real_code(tmp_path: Path, format: str):
    archive = tmp_path / f"source.{format}"
    if format == "zip":
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("main.py", "print('archive')\n")
    else:
        with tarfile.open(archive, "w") as output:
            content = b"print('archive')\n"
            member = tarfile.TarInfo("main.py")
            member.size = len(content)
            output.addfile(member, io.BytesIO(content))
    materialize_source({"kind": "artifact", "artifactId": "a"}, tmp_path / "source", artifact=archive)
    assert (tmp_path / "source/main.py").read_text() == "print('archive')\n"


def test_tar_created_with_dot_root_extracts_safely(tmp_path: Path):
    archive = tmp_path / "source.tar"
    with tarfile.open(archive, "w") as output:
        directory = tarfile.TarInfo(".")
        directory.type = tarfile.DIRTYPE
        output.addfile(directory)
        content = b"print('standard tar')\n"
        member = tarfile.TarInfo("./main.py")
        member.size = len(content)
        output.addfile(member, io.BytesIO(content))
    extract_archive(archive, tmp_path / "source")
    assert (tmp_path / "source/main.py").read_bytes() == content


@pytest.mark.parametrize(
    "format,kind",
    [("zip", "traversal"), ("zip", "symlink"), ("tar", "traversal"), ("tar", "symlink"), ("tar", "hardlink")],
)
def test_archive_rejects_traversal_symlinks_and_hardlinks(tmp_path: Path, format: str, kind: str):
    archive = tmp_path / f"unsafe.{format}"
    name = "../escape" if kind == "traversal" else "link"
    if format == "zip":
        with zipfile.ZipFile(archive, "w") as output:
            member = zipfile.ZipInfo(name)
            if kind == "symlink":
                member.external_attr = 0o120777 << 16
            output.writestr(member, "../outside")
    else:
        with tarfile.open(archive, "w") as output:
            member = tarfile.TarInfo(name)
            member.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE}.get(kind, tarfile.REGTYPE)
            member.linkname = "../outside"
            output.addfile(member, io.BytesIO())
    with pytest.raises(ValueError):
        extract_archive(archive, tmp_path / "source")
    assert not (tmp_path / "escape").exists()


def test_git_source_checks_out_exact_commit_and_rejects_branch_name(tmp_path: Path, git_source):
    materialize_source(git_source, tmp_path / "source")
    assert (tmp_path / "source/main.py").read_text() == "print('base')\n"
    with pytest.raises(ValueError, match="pinned"):
        materialize_source({**git_source, "commit": "main"}, tmp_path / "other")


@pytest.fixture
def git_source(tmp_path, request):
    repository = tmp_path / "base"
    object_format = getattr(request, "param", "sha1")
    subprocess.run(
        ["git", "init", "--quiet", f"--object-format={object_format}", str(repository)], check=True
    )
    (repository / "main.py").write_text("print('base')\n")
    (repository / "delete.py").write_text("print('deleted')\n")
    (repository / "unchanged.bin").write_bytes(b"base binary\x00")
    subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "base",
        ],
        check=True,
    )
    commit = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
    return {"kind": "git", "url": str(repository), "commit": commit}


def test_git_overlay_changes_adds_deletes_and_preserves_other_base_files(tmp_path, git_source):
    source = {
        **git_source,
        "files": {"main.py": "print('edited')\n", "nested/new.py": "print('new')\n"},
        "deletedFiles": ["delete.py", "absent.py"],
    }
    destination = tmp_path / "source"
    assert materialize_source(source, destination) == git_source["commit"]
    assert (destination / "main.py").read_text() == source["files"]["main.py"]
    assert (destination / "nested/new.py").read_text() == source["files"]["nested/new.py"]
    assert (destination / "unchanged.bin").read_bytes() == b"base binary\x00"
    assert not (destination / "delete.py").exists()
    assert (
        subprocess.check_output(["git", "-C", str(destination), "rev-parse", "HEAD"], text=True).strip()
        == git_source["commit"]
    )
    with pytest.raises(ValueError, match="already materialized"):
        materialize_source(source, destination)
    assert (destination / "main.py").read_text() == source["files"]["main.py"]


@pytest.mark.parametrize("field", ["files", "deletedFiles"])
@pytest.mark.parametrize(
    "unsafe",
    [
        "../secret",
        "/secret",
        ".git/config",
        "nested/.GIT/config",
        "a//b",
        "a/./b",
        "a\\b",
        "a\x00b",
        "a\tb",
        "a\x7fb",
    ],
)
def test_git_edits_reject_unsafe_paths_before_running_git(tmp_path, git_source, field, unsafe):
    source = {**git_source, field: {unsafe: "bad"} if field == "files" else [unsafe]}
    commands = []
    with pytest.raises(ValueError, match="unsafe"):
        materialize_source(source, tmp_path / "source", command_runner=lambda argv: commands.append(argv))
    assert not commands and not (tmp_path / "source").exists()


@pytest.mark.parametrize(
    "files,deletions",
    [
        ({"main.py": "new"}, ["main.py"]),
        ({"a/b": "new"}, ["a"]),
        ({"a": "new"}, ["a/b"]),
        ({}, ["main.py", "main.py"]),
    ],
)
def test_conflicting_additions_and_deletions_are_rejected_before_materialization(
    tmp_path, git_source, files, deletions
):
    with pytest.raises(ValueError, match="same file|conflict|duplicate"):
        materialize_source({**git_source, "files": files, "deletedFiles": deletions}, tmp_path / "source")
    assert not (tmp_path / "source").exists()


def test_git_symlink_is_rejected_even_when_an_overlay_would_replace_it(tmp_path, git_source):
    repository = Path(git_source["url"])
    (repository / "link.py").symlink_to(tmp_path / "secret")
    subprocess.run(["git", "-C", str(repository), "add", "link.py"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "link",
        ],
        check=True,
    )
    git_source["commit"] = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
    ).strip()
    with pytest.raises(ValueError, match="symlink"):
        materialize_source({**git_source, "files": {"link.py": "overlay"}}, tmp_path / "source")
    assert not (tmp_path / "source").exists() and not list(tmp_path.glob(".source-*"))


@pytest.mark.parametrize("format", ["zip", "tar"])
def test_archive_rejects_git_metadata_before_extracting_any_file(tmp_path, format):
    archive = tmp_path / f"metadata.{format}"
    if format == "zip":
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("main.py", "valid")
            output.writestr(".git/config", "unsafe")
    else:
        with tarfile.open(archive, "w") as output:
            for name in ("main.py", ".git/config"):
                member = tarfile.TarInfo(name)
                member.size = 1
                output.addfile(member, io.BytesIO(b"x"))
    with pytest.raises(ValueError, match=".git"):
        materialize_source({"kind": "artifact", "artifactId": "code"}, tmp_path / "source", artifact=archive)
    assert not (tmp_path / "source").exists()


def test_oversized_binary_archive_does_not_publish_a_partial_source(tmp_path, monkeypatch):
    monkeypatch.setattr("mado_tracking.worker.source.MAX_SOURCE_FILE_BYTES", 2)
    archive = tmp_path / "large.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("large.bin", b"abc")
    with pytest.raises(ValueError, match="binary size limit"):
        materialize_source({"kind": "artifact", "artifactId": "code"}, tmp_path / "source", artifact=archive)
    assert not (tmp_path / "source").exists()


def test_fetched_commit_mismatch_is_rejected_before_checkout(tmp_path, git_source):
    commands = []

    def altered_fetch(argv):
        commands.append(argv)
        if "rev-parse" in argv:
            return "0" * 40
        return ""

    with pytest.raises(ValueError, match="Fetched Git commit"):
        materialize_source(git_source, tmp_path / "source", command_runner=altered_fetch)
    assert not any("checkout" in argv for argv in commands)
    assert not (tmp_path / "source").exists()


@pytest.mark.parametrize("git_source", ["sha256"], indirect=True)
def test_sha256_git_repository_checks_out_the_exact_pinned_commit(tmp_path, git_source):
    assert len(git_source["commit"]) == 64
    actual_commit = materialize_source(git_source, tmp_path / "source")
    assert actual_commit == git_source["commit"]
    assert (tmp_path / "source/main.py").read_text() == "print('base')\n"
