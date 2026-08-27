"""Import shim for the generated protobuf stubs.

`python -m grpc_tools.protoc` emits ``prediction_pb2_grpc.py`` containing a
flat ``import prediction_pb2`` — a top-level import, not a package-relative
one. Rather than rewriting generated code, we put the output directory on
``sys.path`` and import the modules by their generated names.

The location is resolved in this order:
  1. ``$SHARED_PYTHON_DIR`` (set in the container image)
  2. ``<repo>/shared/python`` (working from a source checkout)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_ENV_DIR = os.getenv("SHARED_PYTHON_DIR")
_REPO_DEFAULT = Path(__file__).resolve().parents[2] / "shared" / "python"

_STUB_DIR = Path(_ENV_DIR).resolve() if _ENV_DIR else _REPO_DEFAULT

if not (_STUB_DIR / "prediction_pb2.py").exists():
    raise ImportError(
        f"generated protobuf stubs not found in {_STUB_DIR}. "
        "Run `pnpm run proto:python` (or `make proto`) from the repository root, "
        "or set SHARED_PYTHON_DIR to the directory containing prediction_pb2.py."
    )

if str(_STUB_DIR) not in sys.path:
    sys.path.insert(0, str(_STUB_DIR))

import prediction_pb2 as prediction_pb2  # noqa: E402
import prediction_pb2_grpc as prediction_pb2_grpc  # noqa: E402

STUB_DIR = _STUB_DIR

__all__ = ["prediction_pb2", "prediction_pb2_grpc", "STUB_DIR"]
