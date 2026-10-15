import base64
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fish_server import FishEngine, Handler, RequestError, split_text, validate_request


class ContractTests(unittest.TestCase):
    def request(self, **changes):
        data = {
            "text": "[warm] Hello there!",
            "reference_text": "This is the reference recording.",
            "reference_audio": base64.b64encode(b"RIFF\x00\x00\x00\x00WAVE").decode(),
        }
        data.update(changes)
        return data

    def test_reference_is_required_no_random_voice(self):
        for changes in ({"reference_text": ""}, {"reference_audio": ""}):
            with self.assertRaises(RequestError):
                validate_request(self.request(**changes))

    def test_rejects_non_wav_and_non_finite_controls(self):
        for changes in (
            {"reference_audio": "not base64!"},
            {"temperature": float("nan")},
            {"seed": True},
            {"text": "<|speaker:1|>Hello"},
        ):
            with self.assertRaises(RequestError):
                validate_request(self.request(**changes))

    def test_generates_valid_defaults(self):
        value = validate_request(self.request())
        self.assertEqual(value["temperature"], 0.7)
        self.assertEqual(value["seed"], 42)
        self.assertTrue(value["request_id"])

    def test_text_planner_preserves_directions_and_words(self):
        text = "[professional broadcast tone] " + "This is a natural sentence. " * 50
        chunks = split_text(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 360 for chunk in chunks))
        self.assertEqual(" ".join(chunks), text.strip())

    def test_missing_checkpoint_does_not_download(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = FishEngine(Path(folder))
            engine.load()
            self.assertEqual(engine.health()["status"], "missing")
            self.assertFalse(engine.cancel("unknown"))
            with self.assertRaises(RequestError) as error:
                engine.generate(validate_request(self.request()))
            self.assertEqual(error.exception.status, 503)
            engine.executor.shutdown(wait=False)

    def test_verified_download_triggers_exactly_one_first_load(self):
        engine = SimpleNamespace(status="missing", model_dir=Path("unused"))
        engine.load = Mock(side_effect=lambda: setattr(engine, "status", "loading"))
        engine.health = Mock(side_effect=lambda: {"status": engine.status})
        handler = Handler.__new__(Handler)
        handler.server = SimpleNamespace(engine=engine, auto_load=True)
        handler.path = "/health"
        handler.allowed = lambda: True
        handler.respond = Mock()
        with patch("fish_server.model_present", return_value=True):
            handler.do_GET()
            handler.do_GET()
        engine.load.assert_called_once()
        handler.respond.assert_called_with(200, {"status": "loading"})


if __name__ == "__main__":
    unittest.main()
