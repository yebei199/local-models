"""Serve one speech model over the contract Breeze already speaks, so the gate treats all alike."""

import argparse
import email.parser
import email.policy
import http.server
import tempfile

import numpy as np


def arguments(*extra):
    """The port comes from the gate; `extra` names the flags a model needs to load."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    for name in extra:
        parser.add_argument(name, required=True)
    return parser.parse_args()


def fields(content_type, body):
    """Read a multipart form; the cgi module that used to do this left the standard library."""
    head = b"Content-Type: " + content_type.encode() + b"\r\n\r\n"
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(head + body)
    return {
        part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
        for part in message.iter_parts()
    }


def pcm(audio):
    """Mono 16-bit little-endian samples, which is what Breeze streams."""
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def serve(port, synthesize):
    """Answer one request at a time; `synthesize(form, reference)` returns (samples, rate)."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def respond(self, status, payload, rate=None):
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            if rate:
                self.send_header("X-Sample-Rate", str(rate))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self.respond(200, b"ready")

        def do_POST(self):
            length = int(self.headers["Content-Length"])
            form = fields(self.headers["Content-Type"], self.rfile.read(length))
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav") as reference:
                    reference.write(form["ref_audio"])
                    reference.flush()
                    audio, rate = synthesize(form, reference.name)
            except Exception as error:
                self.respond(500, str(error).encode())
                return
            self.respond(200, pcm(audio), rate)

    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()


def text(form, name, default=""):
    """A form field as text; absent optional fields are normal."""
    value = form.get(name)
    return value.decode() if value is not None else default


def seed(form):
    """Seeds arrive as arbitrary precision text, but samplers take 63 bits."""
    value = text(form, "seed")
    return int(value) % 2**63 if value else None
