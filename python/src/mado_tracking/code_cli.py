"""`mado-tracking code register --job-file mmt-job.toml --project <id>`: register a job template.

The template's image tag is resolved to its digest first, so the CodeVersion pins the exact
image; the registry is asked anonymously, or as MMT_REGISTRY_USERNAME with MMT_REGISTRY_PASSWORD.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .client import Client
from .errors import ApiError, ConfigurationError
from .execution_runtime import DockerRuntime
from .image_digest import ResolvedImage, resolve_image_digest
from .job_template import JobTemplate, default_version, load_job_template

EXIT_CONFIGURATION_ERROR = 2


def add_parser(commands: Any) -> None:
    code = commands.add_parser("code", help="register code versions")
    actions = code.add_subparsers(dest="code_command", required=True)
    register = actions.add_parser(
        "register",
        help="register a CodeVersion from a job template (mmt-job.toml); MMT_API_URL, MMT_API_TOKEN",
        description="Resolve the template's image tag to its digest and register it as a Docker CodeVersion.",
    )
    register.add_argument("--job-file", type=Path, required=True, help="the job template (mmt-job.toml)")
    register.add_argument("--project", required=True, metavar="PROJECT_ID")
    register.add_argument(
        "--code", help="the Code's name; an existing Code gets a new version (default: name)"
    )
    register.add_argument("--version", help="the version label (default: version, else commit and digest)")
    register.set_defaults(handler=run_register)


def register_template(
    client: Client,
    project_id: str,
    template: JobTemplate,
    resolved: ResolvedImage,
    *,
    code_name: str,
    version: str,
) -> dict[str, Any]:
    runtime: DockerRuntime = {"kind": "docker", "image": resolved.image}
    if template.working_directory is not None:
        runtime["workingDirectory"] = template.working_directory
    fields: dict[str, Any] = {
        "version": version,
        "source": template.source,
        "entrypoint": list(template.command),
        "runtime": runtime,
        "environment": template.environment,
        "supported_model_families": list(template.model_families),
        "task_types": list(template.task_types),
    }
    existing = next(
        (code for code in client.list_project_items(project_id, "codes") if code["name"] == code_name), None
    )
    if existing is not None:
        return client.create_code_version(project_id, code_id=existing["id"], **fields)
    return client.register_code(project_id, name=code_name, description=template.description, **fields)


def run_register(arguments: argparse.Namespace) -> int:
    try:
        template = load_job_template(arguments.job_file)
        code_name = arguments.code or template.name
        if not code_name:
            raise ConfigurationError("Give --code or set name in the job template")
        resolved = resolve_image_digest(
            template.image,
            username=os.environ.get("MMT_REGISTRY_USERNAME") or None,
            password=os.environ.get("MMT_REGISTRY_PASSWORD") or None,
        )
        version = arguments.version or default_version(template, resolved.digest)
        with Client() as client:
            code_version = register_template(
                client, arguments.project, template, resolved, code_name=code_name, version=version
            )
    except (ConfigurationError, ApiError) as error:
        print(f"mado-tracking code register: {error}", file=sys.stderr)
        return EXIT_CONFIGURATION_ERROR
    print(
        json.dumps(
            {
                "codeId": code_version.get("codeId"),
                "codeVersionId": code_version.get("id"),
                "version": code_version.get("version"),
                "image": resolved.image,
                "platforms": resolved.platforms,
            }
        )
    )
    return 0
