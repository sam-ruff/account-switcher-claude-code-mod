"""Stand-in for the Messages API that logs which session sent which bearer token.

Usage: fake_api.py <port> <log-file>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        if "/messages" in self.path:
            token = self.headers.get("authorization", "").rsplit(" ", 1)[-1]
            with open(LOG, "a") as f:
                f.write(f"{self.headers.get('x-session-tag', '-')} {token}\n")
        body = json.dumps({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test",
            "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
