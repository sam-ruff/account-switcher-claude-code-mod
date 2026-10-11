"""Run the real terminal mod against a local API with exhausted accounts."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("enabled,all_exhausted,ledger_width", [(False, False, 0), (True, False, 0), (True, True, 0), (False, False, 140), (False, False, 80)])
def test_budget_failover(tmp_path, enabled, all_exhausted, ledger_width):
    requests = []
    usage_requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length", 0)))
            token = self.headers.get("authorization", "").rsplit(" ", 1)[-1]
            is_message = "/messages" in self.path
            if is_message:
                requests.append(token)
            exhausted = is_message and (all_exhausted or token != "token-carol")
            payload = {
                "type": "error",
                "error": {"type": "rate_limit_error", "message": "Account usage limit reached"},
            } if exhausted else {
                "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-test",
                "content": [{"type": "text", "text": "Task continued successfully."}],
                "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1},
            }
            if self.path == "/api/oauth/usage":
                usage_requests.append(token)
                payload = {
                    "five_hour": {"utilization": 36 if token == "token-bob" else 100 if token == "token-carol" else 8, "resets_at": "2099-10-11T15:30:00Z"},
                    "seven_day": {"utilization": 72, "resets_at": "2099-10-14T08:00:00Z"},
                }
            streaming = is_message and not exhausted and "text/event-stream" in self.headers.get("accept", "")
            if streaming:
                events = [
                    ("message_start", {"type": "message_start", "message": {
                        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-test",
                        "content": [], "stop_reason": None, "stop_sequence": None,
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                    }}),
                    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Task continued successfully."}}),
                    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                    ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                    ("message_stop", {"type": "message_stop"}),
                ]
                body = "".join(f"event: {name}\ndata: {json.dumps(event)}\n\n" for name, event in events).encode()
                content_type = "text/event-stream"
            else:
                body = json.dumps(payload).encode()
                content_type = "application/json"
            self.send_response(429 if exhausted else 200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.send_header("x-should-retry", "false")
            if exhausted:
                self.send_header("anthropic-ratelimit-unified-status", "rejected")
                self.send_header("anthropic-ratelimit-unified-representative-claim", "five_hour")
                self.send_header("anthropic-ratelimit-unified-reset", str(int(time.time()) + 3600))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    home = tmp_path / "home"
    project = tmp_path / "project"
    project.mkdir()
    mod = tmp_path / "account-switcher"
    shutil.copytree(ROOT / "mods/account-switcher", mod)
    config = home / ".claude"
    config.mkdir(parents=True)

    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    identities = [
        {"accountUuid": name, "emailAddress": f"{name}@example.com", "organizationUuid": f"org-{name}"}
        for name in ["bob", "alice", "carol"]
    ]
    write(home / ".claude.json", {
        "hasCompletedOnboarding": True, "theme": "dark", "oauthAccount": identities[0],
        "projects": {str(project): {"hasTrustDialogAccepted": True}},
    })
    for index, identity in enumerate(identities):
        name = identity["accountUuid"]
        directory = config if index == 0 else config / "accounts" / f"{name}_org-{name}"
        write(directory / ".credentials.json", {"claudeAiOauth": {
            "accessToken": f"token-{name}", "refreshToken": f"refresh-{name}",
            "expiresAt": 4102444800000, "scopes": ["user:inference", "user:profile"], "subscriptionType": "max",
        }})
        if index:
            write(directory / "account.json", {"label": name.title(), "oauthAccount": identity})

    steps = []
    if enabled:
        steps.extend([["type", "/account-switch auto on"], ["key", "enter"], ["wait", 1]])
    steps.extend([["type", "Say hello"], ["key", "enter"], ["wait", 15], ["screen", "result"]])
    if ledger_width:
        steps = [["type", "/account-switch"], ["key", "enter"], ["wait", 4], ["screen", "ledger"]]
        if os.environ.get("LEDGER_SCREENSHOTS"):
            steps.append(["png", [str(Path(os.environ["LEDGER_SCREENSHOTS"]) / f"ledger-{ledger_width}.png"), 0, 60]])
            if ledger_width == 140:
                docs = Path(os.environ["LEDGER_SCREENSHOTS"]).parent
                steps.extend([
                    ["png", [str(docs / "sidebar.png"), 0, 56, 88, 140]],
                    ["frame", [0, 60]], ["key", "right"], ["wait", 1], ["frame", [0, 60]],
                    ["key", "tab"], ["wait", 1],
                    ["png", [str(Path(os.environ["LEDGER_SCREENSHOTS"]) / "ledger-selected.png"), 0, 60]],
                    ["frame", [0, 60]], ["key", "enter"], ["wait", 1], ["frame", [0, 60]],
                    ["type", "/status"], ["key", "enter"], ["wait", 2], ["frame", [0, 60]], ["key", "esc"],
                    ["type", "/logout"], ["key", "enter"], ["wait", 1],
                    ["png", [str(docs / "logout.png"), 0, 60]], ["frame", [0, 60]],
                    ["gif", str(docs / "demo.gif")], ["key", "esc"],
                ])
        if ledger_width == 80:
            steps.extend([["key", "down"], ["key", "down"], ["wait", 16], ["screen", "ledger-footer"]])
            if os.environ.get("LEDGER_SCREENSHOTS"):
                steps.append(["png", [str(Path(os.environ["LEDGER_SCREENSHOTS"]) / "ledger-80-footer.png"), 0, 60]])
            steps.extend([["key", "up"], ["wait", 1], ["screen", "focused-account"], ["key", "enter"], ["wait", 1], ["screen", "selected-account"]])
        steps.append(["key", "esc"])
    cli = os.environ.get("CLAUDE_TEST_BINARY") or shutil.which("claude")
    assert cli, "Claude Code must be installed"
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/lib/drive.py"), str(project), str(home), cli,
             str(mod), json.dumps(steps)],
            env={**os.environ, "DRIVE_BASE_URL": f"http://127.0.0.1:{server.server_port}", "DRIVE_COLS": str(ledger_width or 120), "DRIVE_ROWS": "60" if ledger_width else "40"},
            capture_output=True, text=True, timeout=60,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert result.returncode == 0, result.stderr
    if ledger_width:
        assert set(usage_requests) == {"token-bob", "token-alice", "token-carol"}, result.stdout
        assert "64%" in result.stdout, result.stdout
        assert "exhausted" in result.stdout, result.stdout
        assert "16:30" in result.stdout or "15:30" in result.stdout, result.stdout
        assert "Auto-switch: off" in result.stdout, result.stdout
        if ledger_width == 80:
            assert "Account: Alice" in result.stdout, result.stdout
            footer_rows = re.findall(r"^\s*(\d+) .*Auto-switch: off", result.stdout, re.MULTILINE)
            assert len(footer_rows) == 3 and len(set(footer_rows)) == 1, result.stdout
            assert len(usage_requests) >= 6, "The open panel should refresh usage automatically"
        return
    transitions = [token for index, token in enumerate(requests) if index == 0 or requests[index - 1] != token]
    expected = ["token-bob", "token-alice", "token-carol"] if enabled else ["token-bob"]
    assert transitions == expected, f"{requests}\n{result.stdout}\n{result.stderr}"
    transcripts = "\n".join(path.read_text() for path in (config / "projects").rglob("*.jsonl"))
    if enabled and all_exhausted:
        assert "all available accounts are out of budget" in transcripts, result.stdout
    elif enabled:
        assert "Task continued successfully" in transcripts, result.stdout
