import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("ORACLE_API_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(__file__))
import app as oracle_api
import httpx
from fastapi.responses import JSONResponse


class McpEndpointTests(unittest.TestCase):
    def setUp(self):
        oracle_api._rate.clear()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=oracle_api.app),
            base_url="http://oracle.test",
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
        )

    def tearDown(self):
        asyncio.run(self.client.aclose())

    def post(self, path, payload):
        return asyncio.run(self.client.post(path, json=payload))

    @staticmethod
    def rpc(request_id, method, params=None):
        return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}

    def test_initialize_and_distinct_tool_catalogs(self):
        init = self.post("/search/mcp", self.rpc(1, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}))
        self.assertEqual(init.status_code, 200)
        self.assertEqual(init.json()["result"]["protocolVersion"], "2025-11-25")
        search_tools = self.post("/search/mcp", self.rpc(2, "tools/list")).json()["result"]["tools"]
        model_tools = self.post("/models/mcp", self.rpc(3, "tools/list")).json()["result"]["tools"]
        self.assertEqual([tool["name"] for tool in search_tools], ["search_web", "extract_url"])
        self.assertEqual([tool["name"] for tool in model_tools], ["oracle_chat"])

    def test_search_tool_uses_existing_bounded_search_handler(self):
        async def fake_search(body, _token):
            self.assertEqual(body.query, "python docs")
            self.assertEqual(body.limit, 3)
            return JSONResponse({"query": body.query, "results": [{"title": "Docs", "url": "https://example.org", "content": "ok", "engine": "test"}]})

        with patch.object(oracle_api, "search", fake_search):
            response = self.post("/search/mcp", self.rpc(7, "tools/call", {"name": "search_web", "arguments": {"query": "python docs", "limit": 3}}))
        result = response.json()["result"]
        self.assertFalse(result["isError"])
        self.assertIn("example.org", result["content"][0]["text"])

    def test_extraction_and_model_tool_dispatch(self):
        with patch.object(oracle_api, "_probe_extraction_worker", new=AsyncMock(return_value=False)), \
             patch.object(oracle_api, "_safe_fetch", return_value=("example.org", "Example", "bounded extracted text")):
            extracted = self.post("/search/mcp", self.rpc(8, "tools/call", {"name": "extract_url", "arguments": {"url": "https://example.org/page"}})).json()["result"]
        self.assertFalse(extracted["isError"])
        self.assertIn("bounded extracted text", extracted["content"][0]["text"])
        self.assertIn('"source_host": "example.org"', extracted["content"][0]["text"])
        self.assertIn('"worker_id": "local"', extracted["content"][0]["text"])

        async def fake_chat(body, _token):
            self.assertEqual(body.model, "deepseek-r1:1.5b")
            self.assertEqual(body.messages[0].content, "say hello")
            return JSONResponse({"model": body.model, "choices": [{"message": {"content": "hello"}, "finish_reason": "length"}], "usage": {"prompt_tokens": 3, "completion_tokens": 12, "total_tokens": 15}}, headers={"x-oracle-host": "ora3"})

        with patch.object(oracle_api, "chat", fake_chat):
            completed = self.post("/models/mcp", self.rpc(9, "tools/call", {"name": "oracle_chat", "arguments": {"model": "deepseek-r1:1.5b", "prompt": "say hello", "max_tokens": 12}})).json()["result"]
        self.assertFalse(completed["isError"])
        self.assertIn('"host": "ora3"', completed["content"][0]["text"])
        self.assertIn('"finish_reason": "length"', completed["content"][0]["text"])
        self.assertIn('"total_tokens": 15', completed["content"][0]["text"])

    def test_auth_origin_invalid_input_and_notification(self):
        no_auth = httpx.AsyncClient(transport=httpx.ASGITransport(app=oracle_api.app), base_url="http://oracle.test")
        response = asyncio.run(no_auth.post("/search/mcp", json=self.rpc(1, "tools/list"), headers={"accept": "application/json, text/event-stream"}))
        asyncio.run(no_auth.aclose())
        self.assertEqual(response.status_code, 401)

        browser = asyncio.run(self.client.post("/search/mcp", json=self.rpc(1, "tools/list"), headers={"origin": "https://evil.example"}))
        self.assertEqual(browser.status_code, 403)

        browser_get = asyncio.run(self.client.get("/search/mcp", headers={"origin": "https://evil.example", "accept": "text/event-stream"}))
        self.assertEqual(browser_get.status_code, 403)

        bad_post_version = asyncio.run(self.client.post("/search/mcp", json=self.rpc(1, "tools/list"), headers={"mcp-protocol-version": "future-version"}))
        self.assertEqual(bad_post_version.status_code, 400)
        bad_get_version = asyncio.run(self.client.get("/search/mcp", headers={"mcp-protocol-version": "future-version", "accept": "text/event-stream"}))
        self.assertEqual(bad_get_version.status_code, 400)

        invalid = self.post("/search/mcp", self.rpc(5, "tools/call", {"name": "extract_url", "arguments": {"url": "http://127.0.0.1/"}})).json()["result"]
        self.assertTrue(invalid["isError"])
        self.assertIn("url_destination_not_public", invalid["content"][0]["text"])

        notification = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        response = self.post("/search/mcp", notification)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.content, b"")

    def test_unknown_tool_is_protocol_error(self):
        response = self.post("/models/mcp", self.rpc(10, "tools/call", {"name": "shell", "arguments": {}}))
        self.assertEqual(response.json()["error"]["code"], -32602)

    def test_reject_batch_and_invalid_json_rpc_shapes(self):
        batch = asyncio.run(self.client.post("/search/mcp", json=[self.rpc(1, "tools/list"), self.rpc(2, "tools/list")]))
        self.assertEqual(batch.status_code, 400)
        self.assertEqual(batch.json()["error"]["code"], -32600)

        for request_id in (None, True, [], {}):
            invalid_id = asyncio.run(self.client.post("/search/mcp", json={"jsonrpc": "2.0", "id": request_id, "method": "tools/list"}))
            self.assertEqual(invalid_id.json()["error"]["code"], -32600)

        invalid_params = asyncio.run(self.client.post("/search/mcp", json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": []}))
        self.assertEqual(invalid_params.json()["error"]["code"], -32600)

        notification_with_id = asyncio.run(self.client.post("/search/mcp", json={"jsonrpc": "2.0", "id": 4, "method": "notifications/initialized"}))
        self.assertEqual(notification_with_id.json()["error"]["code"], -32600)

    def test_model_tool_rejects_extra_empty_and_oversized_arguments(self):
        extra = self.post("/models/mcp", self.rpc(12, "tools/call", {"name": "oracle_chat", "arguments": {"model": "deepseek-r1:1.5b", "prompt": "hello", "temperature": 0}}))
        self.assertTrue(extra.json()["result"]["isError"])

        with patch.object(oracle_api, "chat") as fake_chat:
            for prompt in ("", "é" * 12_001):
                invalid = self.post("/models/mcp", self.rpc(13, "tools/call", {"name": "oracle_chat", "arguments": {"model": "deepseek-r1:1.5b", "prompt": prompt}})).json()["result"]
                self.assertTrue(invalid["isError"])
            fake_chat.assert_not_called()

    def test_tool_catalogs_are_enforced_at_call_time(self):
        for path, name in (("/search/mcp", "oracle_chat"), ("/models/mcp", "search_web")):
            response = self.post(path, self.rpc(14, "tools/call", {"name": name, "arguments": {}}))
            self.assertEqual(response.json()["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
