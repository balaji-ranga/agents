#!/usr/bin/env python3
"""Sandboxed Python / LangGraph custom script runner — JSON stdin/stdout."""
import json
import sys
import tempfile
import os
import signal
import importlib.util

TIMEOUT_SEC = int(os.environ.get("CUSTOM_SCRIPT_TIMEOUT_MS", "60000")) // 1000 or 60


class TimeoutError(Exception):
    pass


def _timeout_handler(signum, frame):
    raise TimeoutError("Script timeout")


def main():
    payload = json.load(sys.stdin)
    source = payload.get("source") or ""
    inputs = payload.get("inputs") or {}
    context = payload.get("context") or {}

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(TIMEOUT_SEC)

    try:
        with tempfile.TemporaryDirectory(prefix="aos-script-") as tmp:
            path = os.path.join(tmp, "user_script.py")
            with open(path, "w", encoding="utf-8") as f:
                f.write(source)

            spec = importlib.util.spec_from_file_location("user_script", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)

            fn = getattr(mod, "run_graph", None) or getattr(mod, "run", None)
            if not callable(fn):
                raise ValueError("Script must define run_graph(inputs) or run(inputs)")

            result = fn(inputs, context) if fn.__code__.co_argcount >= 2 else fn(inputs)
            if result is None:
                result = {"text": ""}
            elif not isinstance(result, dict):
                result = {"text": str(result)}

            print(json.dumps({"ok": True, "output": result}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)


if __name__ == "__main__":
    main()
