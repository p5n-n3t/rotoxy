"""Fail-closed capability planning for heterogeneous provider tasks.

This module deliberately does not own task persistence. Plans are inputs to the
existing durable job system; execution adapters must be injected by trusted
application wiring. In particular, a capability snapshot is not proof of live
dispatch, and this planner never calls a provider.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Mapping, Sequence

MAX_TASKS = 100
MAX_DEPENDENCIES = 8
MAX_SNAPSHOT_AGE_SECONDS = 300
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class PlanError(ValueError):
    """The scenario is invalid or has no eligible pinned execution resource."""


@dataclass(frozen=True)
class Resource:
    """Caller-supplied, sanitized resource snapshot from an authorized inventory."""

    resource_id: str
    provider: str
    modes: frozenset[str]
    capabilities: frozenset[str]
    models: frozenset[str]
    enabled: bool
    authorized: bool
    health: str
    capacity: int
    occupied: int
    quota: str
    observed_at: float


@dataclass(frozen=True)
class TaskPlan:
    task_id: str
    dependencies: tuple[str, ...]
    resource_id: str
    provider: str
    mode: str
    model: str | None
    idempotency_key: str


@dataclass(frozen=True)
class FleetPlan:
    scenario_id: str
    tasks: tuple[TaskPlan, ...]
    layers: tuple[tuple[str, ...], ...]
    exclusions: Mapping[str, tuple[str, ...]]

    def as_dict(self) -> dict[str, Any]:
        return {
            "scenarioId": self.scenario_id,
            "tasks": [
                {"taskId": t.task_id, "dependsOn": list(t.dependencies),
                 "resourceId": t.resource_id, "provider": t.provider,
                 "mode": t.mode, "model": t.model,
                 "idempotencyKey": t.idempotency_key}
                for t in self.tasks
            ],
            "layers": [list(layer) for layer in self.layers],
            "exclusions": {key: list(value) for key, value in self.exclusions.items()},
            "dispatchState": "not_dispatched",
        }


class FleetPlanner:
    """Choose bounded task-to-resource pins using only current, explicit inventory.

    Selection is round-robin across eligible resource IDs, providing stable fair
    rotation within this planner instance. Durable cross-process fairness remains
    the responsibility of the existing job registry.
    """

    def __init__(self, resources: Sequence[Resource], *, executors: Mapping[str, Any],
                 clock, max_snapshot_age: int = MAX_SNAPSHOT_AGE_SECONDS):
        if not 1 <= max_snapshot_age <= 3600:
            raise ValueError("max_snapshot_age must be between 1 and 3600 seconds")
        self.resources = tuple(resources)
        if len({r.resource_id for r in self.resources}) != len(self.resources):
            raise ValueError("resource IDs must be unique")
        self.executors = dict(executors)
        self.clock = clock
        self.max_snapshot_age = max_snapshot_age
        self._cursor: dict[tuple[str, ...], int] = {}

    def plan(self, scenario: Mapping[str, Any]) -> FleetPlan:
        if not isinstance(scenario, Mapping) or set(scenario) != {"scenarioId", "tasks"}:
            raise PlanError("scenario requires only scenarioId and tasks")
        scenario_id = scenario["scenarioId"]
        tasks = scenario["tasks"]
        if not isinstance(scenario_id, str) or not _ID.fullmatch(scenario_id):
            raise PlanError("invalid scenarioId")
        if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
            raise PlanError("tasks must contain 1 to 100 entries")
        by_id: dict[str, Mapping[str, Any]] = {}
        for task in tasks:
            if not isinstance(task, Mapping) or set(task) - {
                "taskId", "dependsOn", "mode", "capabilities", "model", "providers", "resourceId"
            } or not {"taskId", "dependsOn", "mode", "capabilities"} <= set(task):
                raise PlanError("invalid task fields")
            task_id = task["taskId"]
            if not isinstance(task_id, str) or not _ID.fullmatch(task_id) or task_id in by_id:
                raise PlanError("task IDs must be unique stable IDs")
            by_id[task_id] = task
        for task in by_id.values():
            deps = task["dependsOn"]
            if (not isinstance(deps, list) or len(deps) > MAX_DEPENDENCIES or
                    any(not isinstance(dep, str) or dep not in by_id or dep == task["taskId"] for dep in deps) or
                    len(set(deps)) != len(deps)):
                raise PlanError("invalid task dependencies")
            if task["mode"] not in {"inference", "agent-session"}:
                raise PlanError("unsupported execution mode")
            caps = task["capabilities"]
            if (not isinstance(caps, list) or not caps or
                    any(not isinstance(cap, str) or not _ID.fullmatch(cap) for cap in caps) or
                    len(set(caps)) != len(caps)):
                raise PlanError("capabilities must be a nonempty unique list")
            for key in ("model", "resourceId"):
                if key in task and (not isinstance(task[key], str) or not task[key]):
                    raise PlanError(f"invalid {key}")
            providers = task.get("providers", [])
            if not isinstance(providers, list) or any(not isinstance(p, str) or not _ID.fullmatch(p) for p in providers):
                raise PlanError("providers must be stable provider IDs")

        layers = _topological_layers(by_id)
        plans = []
        exclusions: dict[str, tuple[str, ...]] = {}
        for task_id, task in by_id.items():
            eligible, reasons = self._eligible(task)
            exclusions[task_id] = tuple(reasons)
            if not eligible:
                raise PlanError(f"task {task_id} has no eligible resource: {'; '.join(reasons)}")
            pool = tuple(sorted(r.resource_id for r in eligible))
            index = self._cursor.get(pool, 0) % len(pool)
            selected_id = pool[index]
            self._cursor[pool] = (index + 1) % len(pool)
            resource = next(r for r in eligible if r.resource_id == selected_id)
            import hashlib
            idem = hashlib.sha256(f"{scenario_id}\0{task_id}\0{selected_id}".encode()).hexdigest()
            plans.append(TaskPlan(task_id, tuple(task["dependsOn"]), resource.resource_id,
                                  resource.provider, task["mode"], task.get("model"), idem))
        return FleetPlan(scenario_id, tuple(plans), tuple(tuple(layer) for layer in layers), exclusions)

    def _eligible(self, task: Mapping[str, Any]) -> tuple[list[Resource], list[str]]:
        now = self.clock()
        reasons = []
        wanted_providers = set(task.get("providers", []))
        pin = task.get("resourceId")
        eligible = []
        for resource in self.resources:
            why = []
            if pin and resource.resource_id != pin:
                continue
            if wanted_providers and resource.provider not in wanted_providers:
                continue
            if resource.provider not in self.executors:
                why.append("no trusted executor is registered")
            if task["mode"] not in resource.modes:
                why.append("execution mode unsupported")
            if not set(task["capabilities"]).issubset(resource.capabilities):
                why.append("required capabilities unavailable")
            model = task.get("model")
            if model and model not in resource.models:
                why.append("requested model unavailable")
            if not resource.enabled:
                why.append("resource disabled")
            if not resource.authorized:
                why.append("resource not authorized")
            if resource.health != "healthy":
                why.append("resource health is not verified healthy")
            if type(resource.capacity) is not int or resource.capacity < 1 or type(resource.occupied) is not int or resource.occupied < 0 or resource.occupied >= resource.capacity:
                why.append("resource capacity unavailable")
            if resource.quota not in {"available", "unmetered"}:
                why.append("quota unavailable or unknown")
            age = now - resource.observed_at
            if age < 0 or age > self.max_snapshot_age:
                why.append("resource snapshot stale")
            if why:
                reasons.extend(f"{resource.resource_id}: {reason}" for reason in why)
            else:
                eligible.append(resource)
        if pin and not any(r.resource_id == pin for r in self.resources):
            reasons.append(f"{pin}: pinned resource not found")
        elif not eligible and not reasons:
            reasons.append("no resource matches provider constraints")
        return eligible, reasons


def _topological_layers(tasks: Mapping[str, Mapping[str, Any]]) -> list[list[str]]:
    remaining = {task_id: set(task["dependsOn"]) for task_id, task in tasks.items()}
    layers = []
    completed: set[str] = set()
    while remaining:
        layer = sorted(task_id for task_id, deps in remaining.items() if deps <= completed)
        if not layer:
            raise PlanError("task dependency cycle")
        layers.append(layer)
        completed.update(layer)
        for task_id in layer:
            del remaining[task_id]
    return layers

