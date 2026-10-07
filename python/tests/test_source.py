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


def test_git_source_checks_out_exact_commit_and_rejects_branch_name(tmp_path: Path):
    repository = tmp_path / "git repository"
    subprocess.run(["git", "init", "--quiet", str(repository)], check=True)
    (repository / "main.py").write_text("print('first')\n")
    subprocess.run(["git", "-C", str(repository), "add", "main.py"], check=True)
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
            "first",
        ],
        check=True,
    )
    commit = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
    materialize_source({"kind": "git", "url": str(repository), "commit": commit}, tmp_path / "source")
    assert (tmp_path / "source/main.py").read_text() == "print('first')\n"
    with pytest.raises(ValueError, match="pinned"):
        materialize_source({"kind": "git", "url": str(repository), "commit": "main"}, tmp_path / "other")
