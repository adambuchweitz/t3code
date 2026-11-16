#!/usr/bin/env python3
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

node, release = sys.argv[1:]
entry = str(Path(release) / "apps/server/dist/bin.mjs")
expected_version = subprocess.check_output([node, entry, "--version"], text=True).strip().removeprefix("t3 v")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
with tempfile.TemporaryDirectory(prefix="t3-fleet-smoke-") as home:
    log = Path(home) / "server.log"
    with log.open("w+") as output:
        child = subprocess.Popen(
            [node, entry, "serve", "--host", "127.0.0.1", "--port", str(port),
             "--base-dir", home, "--no-browser"],
            stdout=output, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(120):
                if child.poll() is not None:
                    raise RuntimeError("Isolated server exited before becoming ready")
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=1
                    ) as response:
                        identity = json.load(response)
                    if identity.get("platform", {}).get("os") != "darwin":
                        raise RuntimeError("Isolated server returned the wrong platform")
                    if identity.get("serverVersion") != expected_version:
                        raise RuntimeError("Isolated server returned the wrong version")
                    print("Isolated server ready:", identity.get("serverVersion"))
                    break
                except (OSError, TimeoutError):
                    time.sleep(1)
            else:
                raise RuntimeError("Isolated server did not become ready")
        except Exception:
            output.flush()
            print(log.read_text()[-4000:], file=sys.stderr)
            raise
        finally:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
