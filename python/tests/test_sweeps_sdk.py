from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fake_http_api import TrackingServer

from mado_tracking.client import Client
from mado_tracking.errors import ApiError, ConfigurationError
from mado_tracking.sweep_config import convert_sweep_config
from mado_tracking.sweeps import SweepsClient, trial_parameters

PROJECT_ID = str(uuid4())
SWEEP_ID = str(uuid4())
TASK_ID = str(uuid4())
EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
# DEFAULT_PARAMETERS["epochs"] in examples/sweep_training.py.
DEFAULT_EPOCHS = 9
SWEEP_PATH = f"/api/projects/{PROJECT_ID}/sweeps/{SWEEP_ID}"

WANDB_CONFIG = {
    "method": "bayes",
    "metric": {"name": "val_loss", "goal": "minimize"},
    "parameters": {
        "lr": {"distribution": "log_uniform_values", "min": 1e-5, "max": 1e-2},
        "batch_size": {"values": [16, 32, 64]},
        "epochs": {"value": 10},
    },
    "early_terminate": {"type": "hyperband", "min_iter": 1, "eta": 3},
    "run_cap": 30,
    "parallelism": 4,
}


class FakeSweepApi:
    """Records each request and answers from per-path queues; unknown paths are 404."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.responses: dict[tuple[str, str], list[httpx.Response]] = {}

    def reply(self, method: str, path: str, *responses: httpx.Response) -> None:
        self.responses.setdefault((method, path), []).extend(responses)

    def serve(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.responses.get((request.method, request.url.path))
        if not queue:
            return httpx.Response(404, json={"error": "not found"})
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def bodies(self) -> list[object]:
        return [json.loads(request.content) if request.content else None for request in self.requests]


@pytest.fixture
def api() -> FakeSweepApi:
    return FakeSweepApi()


@pytest.fixture
def sweeps(api: FakeSweepApi) -> Iterator[SweepsClient]:
    client = Client(
        api_url="http://localhost/api", api_token="test-token", transport=httpx.MockTransport(api.serve)
    )
    yield SweepsClient(client)
    client.close()


def sweep_entity(**fields: object) -> dict[str, object]:
    return {"id": SWEEP_ID, "projectId": PROJECT_ID, "status": "running", "bestTrial": None, **fields}


def page(items: list[dict[str, object]], next_cursor: str | None) -> httpx.Response:
    return httpx.Response(200, json={"items": items, "nextCursor": next_cursor})


@pytest.fixture
def clean_parameter_environment(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.delenv("MMT_PARAMETERS_JSON", raising=False)
    monkeypatch.delenv("MMT_PARAMETERS_FILE", raising=False)
    return monkeypatch


def test_outside_the_worker_trial_parameters_returns_the_defaults(clean_parameter_environment):
    defaults = {"lr": 0.1, "batch_size": 32}
    parameters = trial_parameters(defaults)
    assert parameters == defaults
    parameters["lr"] = 1.0
    assert defaults["lr"] == 0.1
    assert trial_parameters() == {}


def test_parameters_json_overrides_defaults_and_wins_over_the_file(
    clean_parameter_environment, tmp_path: Path
):
    parameters_file = tmp_path / "parameters.json"
    parameters_file.write_text(json.dumps({"lr": 0.5, "from_file": True}), encoding="utf-8")
    clean_parameter_environment.setenv("MMT_PARAMETERS_FILE", str(parameters_file))
    clean_parameter_environment.setenv("MMT_PARAMETERS_JSON", json.dumps({"lr": 0.01}))
    assert trial_parameters({"lr": 0.1, "batch_size": 32}) == {"lr": 0.01, "batch_size": 32}


def test_parameters_file_is_read_when_parameters_json_is_absent(clean_parameter_environment, tmp_path: Path):
    parameters_file = tmp_path / "parameters.json"
    parameters_file.write_text(json.dumps({"batch_size": 64}), encoding="utf-8")
    clean_parameter_environment.setenv("MMT_PARAMETERS_FILE", str(parameters_file))
    assert trial_parameters({"lr": 0.1, "batch_size": 32}) == {"lr": 0.1, "batch_size": 64}


def test_trial_parameters_keep_json_types(clean_parameter_environment):
    clean_parameter_environment.setenv(
        "MMT_PARAMETERS_JSON", json.dumps({"lr": "0.1", "epochs": 3, "amp": False})
    )
    parameters = trial_parameters()
    assert parameters == {"lr": "0.1", "epochs": 3, "amp": False}
    assert isinstance(parameters["lr"], str)


@pytest.mark.parametrize("encoded", ["not json", "[1, 2]", "null"])
def test_malformed_worker_parameters_raise_instead_of_falling_back(clean_parameter_environment, encoded):
    clean_parameter_environment.setenv("MMT_PARAMETERS_JSON", encoded)
    with pytest.raises(ConfigurationError, match="MMT_PARAMETERS_JSON"):
        trial_parameters({"lr": 0.1})


def test_missing_parameters_file_raises(clean_parameter_environment, tmp_path: Path):
    clean_parameter_environment.setenv("MMT_PARAMETERS_FILE", str(tmp_path / "missing.json"))
    with pytest.raises(ConfigurationError, match="MMT_PARAMETERS_FILE"):
        trial_parameters({"lr": 0.1})


def test_wandb_config_converts_to_the_sweep_create_fields():
    assert convert_sweep_config(WANDB_CONFIG) == {
        "method": "bayes",
        "searchSpace": {
            "lr": {"distribution": "log_uniform", "min": 1e-5, "max": 1e-2},
            "batch_size": {"values": [16, 32, 64]},
            "epochs": {"value": 10},
        },
        "objective": {"metric": "val_loss", "goal": "minimize"},
        "maxTrials": 30,
        "parallelism": 4,
        "earlyStopping": {"type": "hyperband", "minIter": 1, "eta": 3},
    }


def test_wandb_distributions_and_inference_follow_the_documented_rules():
    request = convert_sweep_config(
        {
            "method": "random",
            "metric": {"name": "acc", "goal": "maximize", "aggregation": "max"},
            "parameters": {
                "layers": {"min": 1, "max": 8},
                "dropout": {"min": 0, "max": 0.5},
                "width": {"distribution": "q_uniform", "min": 64, "max": 512, "q": 64},
                "optimizer": {"distribution": "categorical", "values": ["adam", "sgd"]},
                "seed": {"distribution": "constant", "value": 7},
            },
            "early_terminate": {"type": "hyperband", "min_iter": 2, "max_iter": 27},
            "run_cap": 5,
        }
    )
    assert request["searchSpace"] == {
        "layers": {"distribution": "int_uniform", "min": 1, "max": 8},
        "dropout": {"distribution": "uniform", "min": 0, "max": 0.5},
        "width": {"distribution": "q_uniform", "min": 64, "max": 512, "q": 64},
        "optimizer": {"values": ["adam", "sgd"]},
        "seed": {"value": 7},
    }
    assert request["objective"] == {"metric": "acc", "goal": "maximize", "aggregation": "max"}
    assert request["earlyStopping"] == {"type": "hyperband", "minIter": 2, "eta": 3, "maxIter": 27}
    assert "parallelism" not in request


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"program": "train.py"}, "Unsupported keys in sweep config: program"),
        ({"method": "hyperopt"}, "method must be one of"),
        (
            {"metric": {"name": "loss", "goal": "minimize", "target": 0.1}},
            "Unsupported keys in metric: target",
        ),
        ({"metric": {"name": "loss", "goal": "min"}}, "metric.goal"),
        ({"parameters": {"lr": {"distribution": "log_uniform", "min": -5, "max": -2}}}, "log_uniform_values"),
        ({"parameters": {"lr": {"distribution": "normal", "mu": 0, "sigma": 1}}}, "not supported"),
        (
            {"parameters": {"lr": {"distribution": "q_log_uniform_values", "min": 1, "max": 2}}},
            "not supported",
        ),
        ({"parameters": {"x": {"values": [1, 2], "probabilities": [0.5, 0.5]}}}, "probabilities"),
        ({"parameters": {"opt": {"parameters": {"lr": {"value": 1}}}}}, "nested parameters"),
        (
            {"parameters": {"lr": {"distribution": "uniform", "min": 0, "max": 1, "q": 0.1}}},
            "Unsupported keys",
        ),
        ({"parameters": {"lr": {"min": 0}}}, "needs values, value, or min and max"),
        ({"parameters": {}}, "non-empty mapping"),
        ({"early_terminate": {"type": "hyperband", "min_iter": 1, "s": 2}}, "early_terminate: s"),
        ({"early_terminate": {"type": "envelope"}}, "hyperband"),
        ({"run_cap": 0}, "run_cap must be a positive integer"),
        ({"parallelism": True}, "parallelism must be a positive integer"),
    ],
)
def test_unsupported_wandb_config_raises_configuration_error(change, message):
    with pytest.raises(ConfigurationError, match=message):
        convert_sweep_config({**WANDB_CONFIG, **change})


def test_missing_run_cap_raises():
    config = {key: value for key, value in WANDB_CONFIG.items() if key != "run_cap"}
    with pytest.raises(ConfigurationError, match="run_cap"):
        convert_sweep_config(config)


def test_create_sweep_posts_the_converted_config(api: FakeSweepApi, sweeps: SweepsClient):
    api.reply("POST", f"/api/projects/{PROJECT_ID}/sweeps", httpx.Response(201, json=sweep_entity()))
    target_id = str(uuid4())
    created = sweeps.create_sweep(
        PROJECT_ID, task_id=TASK_ID, config=WANDB_CONFIG, name="lr-search", target_id=target_id, seed=42
    )
    assert created["id"] == SWEEP_ID
    assert api.requests[0].headers["Authorization"] == "Bearer test-token"
    assert api.bodies() == [
        {
            "name": "lr-search",
            "taskId": TASK_ID,
            **convert_sweep_config(WANDB_CONFIG),
            "targetId": target_id,
            "gpuIds": None,
            "seed": 42,
        }
    ]


def test_create_sweep_omits_seed_so_the_server_picks_one(api: FakeSweepApi, sweeps: SweepsClient):
    api.reply("POST", f"/api/projects/{PROJECT_ID}/sweeps", httpx.Response(201, json=sweep_entity()))
    sweeps.create_sweep(PROJECT_ID, task_id=TASK_ID, config=WANDB_CONFIG, name="lr-search")
    body = api.bodies()[0]
    assert isinstance(body, dict) and "seed" not in body and body["targetId"] is None


def test_invalid_config_sends_no_request(api: FakeSweepApi, sweeps: SweepsClient):
    with pytest.raises(ConfigurationError):
        sweeps.create_sweep(PROJECT_ID, task_id=TASK_ID, config={**WANDB_CONFIG, "command": []}, name="x")
    assert api.requests == []


def test_writes_are_sent_once_even_on_a_retryable_status(api: FakeSweepApi, sweeps: SweepsClient):
    api.reply("POST", f"/api/projects/{PROJECT_ID}/sweeps", httpx.Response(503, json={"error": "busy"}))
    api.reply("POST", f"{SWEEP_PATH}/cancel", httpx.Response(503, json={"error": "busy"}))
    with pytest.raises(ApiError) as created:
        sweeps.create_sweep(PROJECT_ID, task_id=TASK_ID, config=WANDB_CONFIG, name="lr-search")
    with pytest.raises(ApiError):
        sweeps.cancel(PROJECT_ID, SWEEP_ID)
    assert created.value.status_code == 503
    assert len(api.requests) == 2


def test_controls_post_to_their_paths(api: FakeSweepApi, sweeps: SweepsClient):
    for action, status in (("pause", "paused"), ("resume", "running"), ("cancel", "canceled")):
        api.reply("POST", f"{SWEEP_PATH}/{action}", httpx.Response(200, json=sweep_entity(status=status)))
    assert sweeps.pause(PROJECT_ID, SWEEP_ID)["status"] == "paused"
    assert sweeps.resume(PROJECT_ID, SWEEP_ID)["status"] == "running"
    assert sweeps.cancel(PROJECT_ID, SWEEP_ID, cancel_running_trials=True)["status"] == "canceled"
    assert [request.url.path for request in api.requests] == [
        f"{SWEEP_PATH}/pause",
        f"{SWEEP_PATH}/resume",
        f"{SWEEP_PATH}/cancel",
    ]
    assert api.bodies() == [None, None, {"cancelRunningTrials": True}]


def test_cancel_leaves_running_trials_by_default(api: FakeSweepApi, sweeps: SweepsClient):
    api.reply("POST", f"{SWEEP_PATH}/cancel", httpx.Response(200, json=sweep_entity(status="canceled")))
    sweeps.cancel(PROJECT_ID, SWEEP_ID)
    assert api.bodies() == [{"cancelRunningTrials": False}]


def test_iter_trials_follows_cursors_lazily(api: FakeSweepApi, sweeps: SweepsClient):
    first_cursor, second_cursor = str(uuid4()), str(uuid4())
    api.reply(
        "GET",
        f"{SWEEP_PATH}/trials",
        page([{"trialIndex": 0}, {"trialIndex": 1}], first_cursor),
        page([{"trialIndex": 2}], second_cursor),
        page([], None),
    )
    trials = sweeps.iter_trials(PROJECT_ID, SWEEP_ID, order_by="objective", page_size=2)
    assert next(trials) == {"trialIndex": 0}
    assert len(api.requests) == 1
    assert [trial["trialIndex"] for trial in trials] == [1, 2]
    queries = [dict(request.url.params) for request in api.requests]
    assert queries == [
        {"orderBy": "objective", "limit": "2"},
        {"orderBy": "objective", "limit": "2", "cursor": first_cursor},
        {"orderBy": "objective", "limit": "2", "cursor": second_cursor},
    ]


def test_a_repeated_cursor_stops_the_iteration_with_an_error(api: FakeSweepApi, sweeps: SweepsClient):
    cursor = str(uuid4())
    api.reply("GET", f"{SWEEP_PATH}/trials", page([{"trialIndex": 0}], cursor))
    with pytest.raises(ConfigurationError, match="repeated pagination cursor"):
        list(sweeps.iter_trials(PROJECT_ID, SWEEP_ID))


def test_iter_sweeps_filters_by_status_and_follows_cursors(api: FakeSweepApi, sweeps: SweepsClient):
    cursor = str(uuid4())
    api.reply(
        "GET",
        f"/api/projects/{PROJECT_ID}/sweeps",
        page([sweep_entity(id="a")], cursor),
        page([sweep_entity(id="b")], None),
    )
    assert [sweep["id"] for sweep in sweeps.iter_sweeps(PROJECT_ID, status="finished")] == ["a", "b"]
    assert [dict(request.url.params) for request in api.requests] == [
        {"limit": "50", "status": "finished"},
        {"limit": "50", "status": "finished", "cursor": cursor},
    ]


def test_list_arguments_are_checked_before_any_request(api: FakeSweepApi, sweeps: SweepsClient):
    with pytest.raises(ConfigurationError, match="order_by"):
        sweeps.iter_trials(PROJECT_ID, SWEEP_ID, order_by="created_at")
    with pytest.raises(ConfigurationError, match="page_size"):
        sweeps.iter_trials(PROJECT_ID, SWEEP_ID, page_size=501)
    with pytest.raises(ConfigurationError, match="page_size"):
        sweeps.iter_sweeps(PROJECT_ID, page_size=201)
    assert api.requests == []


def test_best_trial_reads_the_sweep_and_retries_a_temporary_failure(
    api: FakeSweepApi, sweeps: SweepsClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("mado_tracking.http.retry_delay", lambda *_arguments: 0.0)
    best = {"trialIndex": 3, "objectiveValue": 0.12, "parameters": {"lr": 0.001}}
    api.reply(
        "GET",
        SWEEP_PATH,
        httpx.Response(503, json={"error": "busy"}),
        httpx.Response(200, json=sweep_entity(bestTrial=best)),
    )
    assert sweeps.best_trial(PROJECT_ID, SWEEP_ID) == best
    assert len(api.requests) == 2


def test_best_trial_is_none_before_any_trial_finishes(api: FakeSweepApi, sweeps: SweepsClient):
    api.reply("GET", SWEEP_PATH, httpx.Response(200, json=sweep_entity()))
    assert sweeps.best_trial(PROJECT_ID, SWEEP_ID) is None


def test_get_sweep_of_another_project_surfaces_the_api_error(api: FakeSweepApi, sweeps: SweepsClient):
    with pytest.raises(ApiError) as error:
        sweeps.get_sweep(str(uuid4()), SWEEP_ID)
    assert error.value.status_code == 404


def test_sweep_training_example_logs_val_loss_per_epoch_with_the_trial_parameters(tmp_path: Path):
    run_id = str(uuid4())
    with TrackingServer() as server:
        server.runs[run_id] = {"id": run_id, "status": "running", "kind": "training"}
        environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
        environment.update(
            MMT_API_URL=server.url,
            MMT_API_TOKEN="example-only-test-token",
            MMT_PROJECT_ID="project-example",
            MMT_RUN_ID=run_id,
            MMT_PARAMETERS_JSON=json.dumps({"lr": 0.1, "batch_size": 8, "epochs": 5}),
        )
        subprocess.run(
            [sys.executable, str(EXAMPLES / "sweep_training.py")],
            check=True,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
    points = [point for point in server.metrics if point["name"] == "val_loss"]
    assert [point["step"] for point in points] == [1, 2, 3, 4, 5]
    assert points[-1]["value"] < points[0]["value"]


def test_sweep_training_example_runs_offline_with_the_defaults():
    environment = {name: value for name, value in os.environ.items() if not name.startswith("MMT_")}
    completed = subprocess.run(
        [sys.executable, str(EXAMPLES / "sweep_training.py"), "--offline"],
        check=True,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.stdout.count("val_loss=") == 1 + DEFAULT_EPOCHS
