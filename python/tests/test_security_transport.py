from __future__ import annotations

import shlex
from pathlib import Path

import pytest

from mado_tracking import ConfigurationError
from mado_tracking.security import SecretMasker, StreamMasker
from mado_tracking.worker.contracts import WorkerJob
from mado_tracking.worker.transport import LocalTransport, SSHTransport


def test_secret_is_masked_even_when_split_at_every_possible_boundary():
    for boundary in range(1, len("abca-secret-abca")):
        masker = StreamMasker(SecretMasker(["abca-secret-abca"]))
        output = masker.feed("prefix abca-secret-abca"[: 7 + boundary])
        output += masker.feed("abca-secret-abca"[boundary:] + " suffix")
        output += masker.feed("", final=True)
        assert output == "prefix [REDACTED] suffix"


def test_overlapping_secrets_do_not_leak_a_longer_secret_suffix():
    masker = StreamMasker(SecretMasker(["abc", "abcdef"]))
    assert masker.feed("abc") == ""
    assert masker.feed("def-") == "[REDACTED]-"


def test_ssh_argv_strictly_checks_existing_host_keys_and_quotes_each_argument(tmp_path: Path):
    key, hosts = tmp_path / "private key", tmp_path / "known hosts"
    key.write_text("test-only-placeholder")
    key.chmod(0o600)
    hosts.write_text("test-only-placeholder")
    transport = SSHTransport(
        host="example.invalid",
        port=2222,
        username="worker",
        ssh_key_path=str(key),
        known_hosts_path=str(hosts),
        masker=SecretMasker(),
    )
    command = ["python with spaces", "-c", "print('quoted')", "$(touch /tmp/never); 'single'", "\n"]
    argv = transport.command_argv(command)
    assert "StrictHostKeyChecking=yes" in argv
    assert f"UserKnownHostsFile={hosts}" in argv
    assert shlex.split(argv[-1]) == command
    assert "test-only-placeholder" not in str(argv)


def test_unknown_known_hosts_and_implicit_local_execution_are_rejected(tmp_path: Path):
    with pytest.raises(ConfigurationError):
        SSHTransport(
            host="example.invalid",
            port=22,
            username="worker",
            ssh_key_path=str(tmp_path / "key"),
            known_hosts_path=str(tmp_path / "missing"),
            masker=SecretMasker(),
        )
    with pytest.raises(ConfigurationError):
        LocalTransport(allow_local_executor=False, masker=SecretMasker())


@pytest.mark.parametrize("kind", ["inference", "evaluation", "training", "finetuning", "processing"])
def test_supported_run_kinds_are_validated_against_code_version(job_payload: dict, kind: str):
    job_payload["run"]["kind"] = kind
    job_payload["codeVersion"]["taskTypes"] = [kind]
    assert WorkerJob.parse(job_payload).run["kind"] == kind
    job_payload["codeVersion"]["taskTypes"] = []
    with pytest.raises(ConfigurationError):
        WorkerJob.parse(job_payload)
