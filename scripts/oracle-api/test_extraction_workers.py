import asyncio
import json
import os
import sys
import threading
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("ORACLE_API_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(__file__))
import app as oracle_api
import httpx
import safe_extraction_worker as worker


class WorkerEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=worker.app),
            base_url="http://worker.test",
            headers={"authorization": "Bearer test-token", "content-type": "application/json"},
        )
        worker._worker_slots = asyncio.Semaphore(1)

    def tearDown(self):
        asyncio.run(self.client.aclose())

    def test_worker_auth_health_and_safe_fetch_reuse(self):
        health = asyncio.run(self.client.get("/health"))
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.json()["available"])

        with patch.object(worker, "_safe_fetch", return_value=("example.org", "Example", "safe text")):
            response = asyncio.run(self.client.post("/internal/extract", json={"url": "https://example.org/"}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "safe text")

        no_auth = httpx.AsyncClient(transport=httpx.ASGITransport(app=worker.app), base_url="http://worker.test")
        denied = asyncio.run(no_auth.get("/health"))
        asyncio.run(no_auth.aclose())
        self.assertEqual(denied.status_code, 401)

    def test_private_destination_guard_is_active_on_worker(self):
        response = asyncio.run(self.client.post("/internal/extract", json={"url": "http://127.0.0.1/"}))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "url_destination_not_public")

    def test_worker_enforces_one_active_extraction(self):
        entered = threading.Event()
        finish = threading.Event()

        def slow_fetch(_url):
            entered.set()
            finish.wait(timeout=3)
            return "example.org", "Example", "done"

        async def calls():
            first = asyncio.create_task(self.client.post("/internal/extract", json={"url": "https://example.org/"}))
            await asyncio.to_thread(entered.wait, 1)
            second = await self.client.post("/internal/extract", json={"url": "https://example.org/other"})
            finish.set()
            return await first, second

        with patch.object(worker, "_safe_fetch", slow_fetch):
            first, second = asyncio.run(calls())
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 503)


class WorkerDispatchTests(unittest.TestCase):
    def test_skipping_unhealthy_host_advances_beyond_selected_worker(self):
        async def call(node_id, _url, _token):
            return "example.org", "Example", "text", node_id

        with patch.object(oracle_api, "_extraction_worker_rr", 0), \
             patch.object(oracle_api, "_probe_extraction_worker", new=AsyncMock(side_effect=lambda node, _token: node != "ora1")), \
             patch.object(oracle_api, "_call_extraction_worker", new=AsyncMock(side_effect=call)):
            async def run():
                return [await oracle_api._dispatch_extraction("https://example.org/", "test-token") for _ in range(3)]
            results = asyncio.run(run())
        self.assertEqual([item[3] for item in results], ["ora3", "ora5", "ora6"])

    def test_fair_health_aware_worker_selection_and_per_host_slot(self):
        async def probe(node_id, _token):
            return node_id in {"ora1", "ora5"}

        async def call(node_id, _url, _token):
            return "example.org", node_id, "text", node_id

        for slot in oracle_api._extraction_worker_slots.values():
            if slot.locked():
                slot.release()
        with patch.object(oracle_api, "_extraction_worker_rr", 0), \
             patch.object(oracle_api, "_probe_extraction_worker", new=AsyncMock(side_effect=probe)), \
             patch.object(oracle_api, "_call_extraction_worker", new=AsyncMock(side_effect=call)):
            async def dispatch_twice():
                first_result = await oracle_api._dispatch_extraction("https://example.org/", "test-token")
                await oracle_api._extraction_worker_slots["ora1"].acquire()
                try:
                    second_result = await oracle_api._dispatch_extraction("https://example.org/", "test-token")
                finally:
                    oracle_api._extraction_worker_slots["ora1"].release()
                return first_result, second_result

            first, second = asyncio.run(dispatch_twice())
        self.assertEqual(first[3], "ora1")
        self.assertEqual(second[3], "ora5")

    def test_local_guarded_fallback_when_all_workers_unhealthy(self):
        with patch.object(oracle_api, "_probe_extraction_worker", new=AsyncMock(return_value=False)), \
             patch.object(oracle_api, "_safe_fetch", return_value=("example.org", "Example", "local result")):
            result = asyncio.run(oracle_api._dispatch_extraction("https://example.org/", "test-token"))
        self.assertEqual(result, ("example.org", "Example", "local result", "local"))

    def test_no_replay_after_worker_dispatch_failure(self):
        with patch.object(oracle_api, "_probe_extraction_worker", new=AsyncMock(side_effect=lambda node, _token: node == "ora1")), \
             patch.object(oracle_api, "_call_extraction_worker", new=AsyncMock(side_effect=oracle_api.HTTPException(502, "extraction_worker_unavailable"))), \
             patch.object(oracle_api, "_safe_fetch") as local_fetch:
            with self.assertRaises(oracle_api.HTTPException) as raised:
                asyncio.run(oracle_api._dispatch_extraction("https://example.org/", "test-token"))
        self.assertEqual(raised.exception.status_code, 502)
        local_fetch.assert_not_called()

    def test_rest_payload_keeps_source_and_worker_attribution(self):
        with patch.object(oracle_api, "_dispatch_extraction", new=AsyncMock(return_value=("origin.example", "Title", "text", "ora5"))):
            response = asyncio.run(oracle_api.extract(oracle_api.ExtractRequest(url="https://origin.example/"), "test-token"))
        payload = json.loads(response.body)
        self.assertEqual(payload["source_host"], "origin.example")
        self.assertEqual(payload["worker_id"], "ora5")
        self.assertEqual(response.headers["x-extraction-worker"], "ora5")


if __name__ == "__main__":
    unittest.main()
