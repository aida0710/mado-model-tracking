"""A job template, mmt-job.toml: the image, command and code a CodeVersion is registered from.

name = "tts-gen"                          # optional; --code wins
version = "2026-10"                       # optional; --version wins
image = "forge.example.org/team/tts-gen:2026-10"   # a tag is resolved to its digest
command = ["python", "-m", "gen.run", "--config", "configs/base.yaml"]
working_directory = "/mmt/source"         # optional, absolute in the container
task_types = ["processing"]
model_families = []
description = "Synthetic speech generation"

[source]                                  # optional: the git commit mounted at /mmt/source
url = "https://forge.example.org/team/tts-gen.git"
commit = "0123456789abcdef0123456789abcdef01234567"

[environment]
HF_HUB_OFFLINE = "1"
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .code_source import validate_code_source
from .errors import ConfigurationError
from .execution_runtime import validate_entrypoint
from .toml_tables import TableReader, load_toml

TEMPLATE_KEYS = {
    "name",
    "version",
    "image",
    "command",
    "working_directory",
    "task_types",
    "model_families",
    "description",
    "source",
    "environment",
}
RUN_KINDS = {"inference", "evaluation", "training", "finetuning", "processing"}
# Characters of a commit and an image digest that name a version when none is given.
DEFAULT_VERSION_CHARACTERS = 12


@dataclass(frozen=True)
class JobTemplate:
    image: str
    command: tuple[str, ...]
    task_types: tuple[str, ...]
    model_families: tuple[str, ...] = ()
    working_directory: str | None = None
    source: dict[str, Any] | None = None
    environment: dict[str, str] = field(default_factory=dict)
    name: str | None = None
    version: str | None = None
    description: str = ""


def load_job_template(path: Path) -> JobTemplate:
    reader = TableReader(load_toml(path), label=str(path), allowed=TEMPLATE_KEYS, base_directory=path.parent)
    command = reader.string_list("command")
    try:
        validate_entrypoint(command)
    except ValueError as error:
        raise ConfigurationError(f"{path}: command {error}") from None
    task_types = reader.string_list("task_types")
    if not task_types or not set(task_types) <= RUN_KINDS:
        raise ConfigurationError(f"{path}: task_types must name Run kinds ({', '.join(sorted(RUN_KINDS))})")
    source = None
    if reader.has("source"):
        source_reader = TableReader(
            reader.table_value("source"), label=f"{path} [source]", allowed={"url", "commit"}
        )
        source = {"kind": "git", "url": source_reader.string("url"), "commit": source_reader.string("commit")}
        try:
            validate_code_source(source)
        except ValueError as error:
            raise ConfigurationError(f"{path} [source]: {error}") from None
    working_directory = reader.optional_string("working_directory")
    if working_directory is not None and not working_directory.startswith("/"):
        raise ConfigurationError(f"{path}: working_directory must be an absolute container path")
    return JobTemplate(
        image=reader.string("image"),
        command=command,
        task_types=task_types,
        model_families=reader.string_list("model_families", default=()),
        working_directory=working_directory,
        source=source,
        environment=reader.string_table("environment"),
        name=reader.optional_string("name"),
        version=reader.optional_string("version"),
        description=reader.string("description", default="") if reader.has("description") else "",
    )


def default_version(template: JobTemplate, image_digest: str) -> str:
    """The template's version, else the commit and image digest it pins (stable for the same pair)."""
    if template.version:
        return template.version
    digest = image_digest.removeprefix("sha256:")[:DEFAULT_VERSION_CHARACTERS]
    if template.source is not None:
        return f"{template.source['commit'][:DEFAULT_VERSION_CHARACTERS]}-{digest}"
    return digest
