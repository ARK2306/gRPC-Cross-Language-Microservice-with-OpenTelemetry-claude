# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Python gRPC inference sidecar. Final image < 300 MB.
#
#   protoc  -> `python -m grpc_tools.protoc` generates /shared/python
#   deps    -> installs runtime dependencies into a self-contained venv
#   runtime -> Alpine + that venv + application code (no compilers, no
#              grpcio-tools, no pip cache)
#
# Build context is the REPOSITORY ROOT because the build needs /proto.
# See docker-compose.yml.

ARG PYTHON_VERSION=3.12.8

# --------------------------------------------------------------------------
# Stage 1: generate the protobuf stubs.
# grpcio-tools (~50 MB, bundles protoc) never reaches the final image.
# --------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-alpine AS protoc

ARG GRPCIO_TOOLS_VERSION=1.83.0
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-compile "grpcio-tools==${GRPCIO_TOOLS_VERSION}"

WORKDIR /repo
COPY proto ./proto
RUN mkdir -p shared/python \
 && python -m grpc_tools.protoc \
      --proto_path=proto \
      --python_out=shared/python \
      --pyi_out=shared/python \
      --grpc_python_out=shared/python \
      prediction.proto \
 # Fail the build here rather than at container start if the generated stubs
 # cannot be imported (e.g. a protobuf runtime/generator version mismatch).
 && python -c "import sys; sys.path.insert(0, 'shared/python'); import prediction_pb2_grpc; print('stubs import cleanly')"

# --------------------------------------------------------------------------
# Stage 2: build the virtualenv.
# Separate stage so application-code changes reuse the cached dependency layer.
# --------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-alpine AS deps

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# binutils supplies `strip`, used below to shrink grpcio's and numpy's shared
# objects. It stays in this stage only.
RUN apk add --no-cache binutils \
 && python -m venv "$VIRTUAL_ENV"

COPY sidecar/requirements.txt /tmp/requirements.txt

# --only-binary=:all: turns a missing musl wheel into a loud build failure
# rather than a silent source build that would need a full toolchain here.
RUN pip install --no-compile --only-binary=:all: -r /tmp/requirements.txt \
 && find /opt/venv -name '__pycache__' -type d -prune -exec rm -rf {} + \
 # NB: *.dist-info is deliberately NOT pruned — opentelemetry-instrumentation
 # resolves package versions through importlib.metadata at startup and fails
 # to load its instrumentors without it.
 && find /opt/venv \( -name tests -o -name test \) -type d -prune -exec rm -rf {} + \
 && find /opt/venv -name '*.pyi' -type f -delete \
 && find /opt/venv -name '*.so' -type f -exec strip --strip-unneeded {} + \
 && du -sh /opt/venv

# --------------------------------------------------------------------------
# Stage 3: runtime.
# Alpine over Debian slim purely for size; every dependency resolves to a
# musllinux wheel, so nothing is built from source.
# --------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-alpine AS runtime

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    GRPC_HOST=0.0.0.0 \
    GRPC_PORT=50051 \
    SHARED_PYTHON_DIR=/app/shared/python

# tini reaps zombies and forwards SIGTERM so the drain path in server.py runs.
RUN apk add --no-cache tini \
 && adduser --disabled-password --uid 1000 --home /home/sidecar sidecar

WORKDIR /app

COPY --from=deps --chown=sidecar:sidecar /opt/venv /opt/venv
COPY --from=protoc --chown=sidecar:sidecar /repo/shared/python /app/shared/python
COPY --chown=sidecar:sidecar sidecar/app /app/app

USER sidecar
EXPOSE 50051

# Probes the standard gRPC health service; see app/healthcheck.py.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["python", "-m", "app.healthcheck"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["python", "-m", "app.server"]
