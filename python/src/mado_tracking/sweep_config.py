"""Convert a W&B-style sweep config into the fields of POST /projects/:p/sweeps.

The rules are listed in docs/sweeps.md ("SDK" section) so that the Web form (sweeps-web) converts
the same config to the same request. Unknown keys are rejected instead of ignored: a silently
dropped ``early_terminate`` or ``probabilities`` would run a different search than the user wrote.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .errors import ConfigurationError

SWEEP_METHODS = ("grid", "random", "bayes")
METRIC_GOALS = ("minimize", "maximize")
OBJECTIVE_AGGREGATIONS = ("last", "min", "max")
# W&B distribution name → API distribution. log_uniform_values takes the values themselves, which
# is what the API's log_uniform means; W&B's own log_uniform (exponents) is rejected below.
DISTRIBUTIONS = {
    "uniform": "uniform",
    "int_uniform": "int_uniform",
    "q_uniform": "q_uniform",
    "log_uniform_values": "log_uniform",
}
# W&B's default eta for hyperband.
DEFAULT_HYPERBAND_ETA = 3

CONFIG_KEYS = frozenset({"method", "metric", "parameters", "early_terminate", "run_cap", "parallelism"})
METRIC_KEYS = frozenset({"name", "goal", "aggregation"})
EARLY_TERMINATE_KEYS = frozenset({"type", "min_iter", "eta", "max_iter"})


def convert_sweep_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``method``, ``searchSpace``, ``objective``, ``maxTrials`` and the optional
    ``parallelism`` / ``earlyStopping`` for a sweep create request."""
    if not isinstance(config, Mapping):
        raise ConfigurationError("Sweep config must be a mapping")
    _reject_unknown_keys("sweep config", config, CONFIG_KEYS)
    method = config.get("method")
    if method not in SWEEP_METHODS:
        raise ConfigurationError(f"Sweep config method must be one of {', '.join(SWEEP_METHODS)}")
    request: dict[str, Any] = {
        "method": method,
        "searchSpace": _search_space(config.get("parameters")),
        "objective": _objective(config.get("metric")),
        "maxTrials": _positive_integer("run_cap", config.get("run_cap")),
    }
    if "parallelism" in config:
        request["parallelism"] = _positive_integer("parallelism", config["parallelism"])
    if "early_terminate" in config:
        request["earlyStopping"] = _early_stopping(config["early_terminate"])
    return request


def _objective(metric: object) -> dict[str, Any]:
    if not isinstance(metric, Mapping):
        raise ConfigurationError("Sweep config metric must be a mapping with name and goal")
    _reject_unknown_keys("metric", metric, METRIC_KEYS)
    name = metric.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ConfigurationError("Sweep config metric.name must be a non-empty string")
    goal = metric.get("goal")
    if goal not in METRIC_GOALS:
        raise ConfigurationError(f"Sweep config metric.goal must be one of {', '.join(METRIC_GOALS)}")
    objective: dict[str, Any] = {"metric": name, "goal": goal}
    if "aggregation" in metric:
        if metric["aggregation"] not in OBJECTIVE_AGGREGATIONS:
            raise ConfigurationError(
                f"Sweep config metric.aggregation must be one of {', '.join(OBJECTIVE_AGGREGATIONS)}"
            )
        objective["aggregation"] = metric["aggregation"]
    return objective


def _search_space(parameters: object) -> dict[str, dict[str, Any]]:
    if not isinstance(parameters, Mapping) or not parameters:
        raise ConfigurationError("Sweep config parameters must be a non-empty mapping")
    space = {}
    for name, definition in parameters.items():
        if not isinstance(name, str) or not name:
            raise ConfigurationError("Sweep parameter names must be non-empty strings")
        space[name] = _parameter_definition(name, definition)
    return space


def _parameter_definition(name: str, definition: object) -> dict[str, Any]:
    if not isinstance(definition, Mapping):
        raise ConfigurationError(f"Sweep parameter {name!r} must be a mapping")
    distribution = definition.get("distribution")
    if "parameters" in definition:
        raise ConfigurationError(f"Sweep parameter {name!r}: nested parameters are not supported")
    if distribution == "categorical" or (distribution is None and "values" in definition):
        _reject_unknown_keys(f"parameter {name!r}", definition, frozenset({"distribution", "values"}))
        values = definition.get("values")
        if not isinstance(values, list) or not all(_is_parameter_value(value) for value in values):
            raise ConfigurationError(f"Sweep parameter {name!r}: values must be a list of str/number/bool")
        return {"values": list(values)}
    if distribution == "constant" or (distribution is None and "value" in definition):
        _reject_unknown_keys(f"parameter {name!r}", definition, frozenset({"distribution", "value"}))
        if not _is_parameter_value(definition.get("value")):
            raise ConfigurationError(f"Sweep parameter {name!r}: value must be a str, number or bool")
        return {"value": definition["value"]}
    if distribution == "log_uniform":
        raise ConfigurationError(
            f"Sweep parameter {name!r}: W&B log_uniform takes exponents; "
            "use log_uniform_values with the values themselves"
        )
    if distribution is None:
        distribution = _inferred_distribution(name, definition)
    if distribution not in DISTRIBUTIONS:
        raise ConfigurationError(f"Sweep parameter {name!r}: distribution {distribution!r} is not supported")
    allowed = {"distribution", "min", "max"} | ({"q"} if distribution == "q_uniform" else set())
    _reject_unknown_keys(f"parameter {name!r}", definition, frozenset(allowed))
    bounds = {key: definition.get(key) for key in ("min", "max")}
    if not all(_is_number(value) for value in bounds.values()):
        raise ConfigurationError(f"Sweep parameter {name!r}: min and max must be numbers")
    converted: dict[str, Any] = {"distribution": DISTRIBUTIONS[distribution], **bounds}
    if "q" in definition:
        if not _is_number(definition["q"]):
            raise ConfigurationError(f"Sweep parameter {name!r}: q must be a number")
        converted["q"] = definition["q"]
    return converted


def _inferred_distribution(name: str, definition: Mapping[str, Any]) -> str:
    """W&B infers the distribution from min/max: both integers → int_uniform, otherwise uniform."""
    if "min" not in definition or "max" not in definition:
        raise ConfigurationError(f"Sweep parameter {name!r} needs values, value, or min and max")
    if all(
        isinstance(definition[key], int) and not isinstance(definition[key], bool) for key in ("min", "max")
    ):
        return "int_uniform"
    return "uniform"


def _early_stopping(early_terminate: object) -> dict[str, Any]:
    if not isinstance(early_terminate, Mapping):
        raise ConfigurationError("Sweep config early_terminate must be a mapping")
    _reject_unknown_keys("early_terminate", early_terminate, EARLY_TERMINATE_KEYS)
    if early_terminate.get("type") != "hyperband":
        raise ConfigurationError("Sweep config early_terminate.type must be hyperband")
    stopping: dict[str, Any] = {
        "type": "hyperband",
        "minIter": _positive_integer("early_terminate.min_iter", early_terminate.get("min_iter")),
        "eta": _positive_integer("early_terminate.eta", early_terminate.get("eta", DEFAULT_HYPERBAND_ETA)),
    }
    if "max_iter" in early_terminate:
        stopping["maxIter"] = _positive_integer("early_terminate.max_iter", early_terminate["max_iter"])
    return stopping


def _reject_unknown_keys(where: str, mapping: Mapping[str, Any], allowed: frozenset[str]) -> None:
    unknown = sorted(str(key) for key in mapping if key not in allowed)
    if unknown:
        raise ConfigurationError(
            f"Unsupported keys in {where}: {', '.join(unknown)} (supported: {', '.join(sorted(allowed))})"
        )


def _positive_integer(key: str, value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ConfigurationError(f"Sweep config {key} must be a positive integer")
    return value


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _is_parameter_value(value: object) -> bool:
    return isinstance(value, str | int | float | bool)
