"""
Dispatcher for the Radar analytics sidecar.

Protocol: reads a single JSON object from stdin:

    {"module": "kelly", "method": "size_bet", "data": {...}}

Routes to the appropriate module's handle_<method> function, writes the
result as JSON to stdout. Errors are returned as {"error": "...", "type": "..."}
with exit code 1. Diagnostic output goes to stderr only.

Invocation:
    cd src && python3 -m analytics        # preferred
    python3 src/analytics/__main__.py     # also works (adjusts sys.path)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Python 3.9+ required: kelly.py uses bare list[float] generic syntax
if sys.version_info < (3, 9):
    json.dump({"error": f"Python >=3.9 required, got {sys.version.split()[0]}", "type": "RuntimeError"}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)

# Ensure sibling packages (analytics.*) are importable regardless of cwd
_src_dir = str(Path(__file__).resolve().parent.parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from analytics import kelly  # noqa: E402
from analytics import thesis_validation  # noqa: E402

# Static module registry — add new analytics modules here
MODULES = {
    "kelly": kelly,
    "thesis_validation": thesis_validation,
}


def _error(msg: str, exc_type: str = "Error") -> None:
    json.dump({"error": msg, "type": exc_type}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


def main() -> None:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
    except json.JSONDecodeError as e:
        _error(f"Invalid JSON input: {e}", "JSONDecodeError")
        return

    module_name = request.get("module")
    method_name = request.get("method")
    data = request.get("data", {})

    if not module_name:
        _error("Missing 'module' in request")
    if not method_name:
        _error("Missing 'method' in request")

    mod = MODULES.get(module_name)
    if mod is None:
        _error(f"Unknown analytics module: '{module_name}'. Available: {list(MODULES.keys())}")

    handler_name = f"handle_{method_name}"
    handler = getattr(mod, handler_name, None)
    if handler is None:
        available = [n.replace("handle_", "") for n in dir(mod) if n.startswith("handle_")]
        _error(f"Module '{module_name}' has no method '{method_name}'. Available: {available}")

    try:
        result = handler(data)
    except Exception as e:
        _error(str(e), type(e).__name__)
        return

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
