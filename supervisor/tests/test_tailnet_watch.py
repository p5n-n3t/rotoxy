import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from snooze import tailnet_watch as watch


class TailnetWatchTests(unittest.TestCase):
    def test_public_resolution_never_contacts_gateway(self):
        with patch.object(watch.socket, "getaddrinfo", return_value=[(None, None, None, None, ("203.0.113.2", 443))]), patch.object(watch.urllib.request, "build_opener") as opener:
            self.assertFalse(watch.probe()["healthy"])
            opener.assert_not_called()

    def test_receipt_contains_only_allowlisted_health_metadata(self):
        response = io.BytesIO(json.dumps({"ok": True, "accounts": 12, "selectable": 11, "token": "never-store", "prompt": "private"}).encode())
        response.status = 200
        with patch.object(watch.socket, "getaddrinfo", return_value=[(None, None, None, None, ("100.95.66.22", 443))]), patch.object(watch.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            receipt = watch.probe()
        self.assertTrue(receipt["healthy"])
        self.assertEqual(receipt["selectable"], 11)
        self.assertNotIn("private", json.dumps(receipt))
        self.assertNotIn("never-store", json.dumps(receipt))

    def test_redirect_is_refused_and_history_is_bounded(self):
        with self.assertRaises(ValueError):
            watch.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "history.jsonl").write_text("x" * watch.MAX_HISTORY)
            watch.record(directory, {"healthy": False})
            self.assertEqual(json.loads((directory / "latest.json").read_text()), {"healthy": False})
            self.assertLess((directory / "history.jsonl").stat().st_size, 100)
            self.assertEqual((directory / "history.previous.jsonl").stat().st_size, watch.MAX_HISTORY)
