import asyncio
import os
import sys
import unittest

os.environ.setdefault("ORACLE_API_TOKEN", "test-token")
sys.path.insert(0, os.path.dirname(__file__))
import app


class HostSelectionTests(unittest.TestCase):
    def test_host_restrictions_cannot_add_or_empty_the_fixed_inventory(self):
        base = {"model": "qwen3.5:2b", "messages": [{"role": "user", "content": "test"}]}
        for hosts in [[], ["ora3", "ora3"], ["http://evil.example"], ["ora99"]]:
            with self.assertRaises(ValueError):
                app.ChatRequest.model_validate({**base, "allowed_hosts": hosts})
        self.assertIsNone(app.ChatRequest.model_validate(base).allowed_hosts)

    def test_selection_obeys_restriction_and_never_falls_back_to_disabled_host(self):
        async def run():
            first = await app._reserve_node("qwen3.5:2b", ["ora3"])
            try:
                self.assertEqual(first["id"], "ora3")
                with self.assertRaises(app.HTTPException) as error:
                    await app._reserve_node("qwen3.5:2b", ["ora3"])
                self.assertEqual(error.exception.status_code, 503)
            finally:
                app._node_locks[first["id"]].release()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
