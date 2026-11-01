import unittest

from snooze.fleet_orchestration import FleetPlanner, PlanError, Resource


class FleetPlannerTests(unittest.TestCase):
    def setUp(self):
        self.resources = [
            Resource("oracle-node", "oracle", frozenset({"inference"}),
                     frozenset({"text-generation"}), frozenset({"oracle/qwen3.5:2b"}),
                     True, True, "healthy", 2, 0, "available", 100),
            Resource("cf-account", "cloudflare", frozenset({"inference"}),
                     frozenset({"text-generation", "json-mode"}), frozenset({"@cf/model-a"}),
                     True, True, "healthy", 1, 0, "available", 100),
            Resource("codex-session", "codex", frozenset({"agent-session"}),
                     frozenset({"read-only-review"}), frozenset(), True, True,
                     "healthy", 1, 0, "available", 100),
        ]
        self.planner = FleetPlanner(self.resources, executors={
            "oracle": object(), "cloudflare": object(), "codex": object(),
        }, clock=lambda: 100)

    def test_mixed_provider_dag_plans_only_matching_resources(self):
        plan = self.planner.plan({"scenarioId": "research-1", "tasks": [
            {"taskId": "collect", "dependsOn": [], "mode": "inference",
             "capabilities": ["text-generation"], "model": "oracle/qwen3.5:2b",
             "providers": ["oracle"]},
            {"taskId": "summarize", "dependsOn": ["collect"], "mode": "inference",
             "capabilities": ["text-generation", "json-mode"], "model": "@cf/model-a",
             "providers": ["cloudflare"]},
            {"taskId": "review", "dependsOn": ["summarize"], "mode": "agent-session",
             "capabilities": ["read-only-review"], "providers": ["codex"]},
        ]})
        self.assertEqual(plan.layers, (("collect",), ("summarize",), ("review",)))
        self.assertEqual([task.resource_id for task in plan.tasks], ["oracle-node", "cf-account", "codex-session"])
        self.assertEqual(plan.as_dict()["dispatchState"], "not_dispatched")

    def test_resource_pin_fails_closed_on_stale_health_or_quota(self):
        unavailable = [Resource("oracle-node", "oracle", frozenset({"inference"}),
                                frozenset({"text-generation"}), frozenset({"m"}),
                                True, True, "unknown", 1, 0, "unknown", 1)]
        planner = FleetPlanner(unavailable, executors={"oracle": object()}, clock=lambda: 100)
        with self.assertRaisesRegex(PlanError, "health is not verified healthy"):
            planner.plan({"scenarioId": "pinned", "tasks": [{
                "taskId": "one", "dependsOn": [], "mode": "inference", "capabilities": ["text-generation"],
                "model": "m", "providers": ["oracle"], "resourceId": "oracle-node",
            }]})

    def test_unknown_executor_and_cycle_are_rejected(self):
        planner = FleetPlanner(self.resources, executors={}, clock=lambda: 100)
        with self.assertRaisesRegex(PlanError, "no trusted executor"):
            planner.plan({"scenarioId": "no-executor", "tasks": [{
                "taskId": "one", "dependsOn": [], "mode": "agent-session", "capabilities": ["read-only-review"],
                "providers": ["codex"],
            }]})
        with self.assertRaisesRegex(PlanError, "dependency cycle"):
            self.planner.plan({"scenarioId": "cycle", "tasks": [
                {"taskId": "one", "dependsOn": ["two"], "mode": "inference", "capabilities": ["text-generation"]},
                {"taskId": "two", "dependsOn": ["one"], "mode": "inference", "capabilities": ["text-generation"]},
            ]})


if __name__ == "__main__":
    unittest.main()
