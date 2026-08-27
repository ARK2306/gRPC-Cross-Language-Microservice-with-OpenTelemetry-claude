# Convenience wrapper around the pnpm scripts. `pnpm build` is the canonical
# entrypoint; every target here delegates to it so the two cannot drift.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE ?= docker compose
MAX_IMAGE_MB ?= 300   # size budget both container images must meet

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install workspace dependencies
	pnpm install --frozen-lockfile

.PHONY: proto
proto: ## Compile prediction.proto for Node and Python into /shared
	pnpm run proto

.PHONY: build
build: ## Compile protos and build both services
	pnpm run build

.PHONY: up
up: ## Build images and start the full stack
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack and remove volumes
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Follow logs from all services
	$(COMPOSE) logs -f

.PHONY: test
test: ## Run the integration suite against a running stack
	pnpm test

.PHONY: verify
verify: up ## Start the stack, wait for health, then run the tests
	@echo "waiting for the gateway to report healthy..."
	@for i in $$(seq 1 60); do \
	  curl -fsS localhost:3000/healthz >/dev/null 2>&1 && break; \
	  sleep 2; \
	done
	pnpm test

.PHONY: size
size: ## Assert both images are under the 300 MB budget
	@scripts/check-image-size.sh --max-mb $(MAX_IMAGE_MB) \
	  ghcr.io/ark2306/grpc-prediction-api:local \
	  ghcr.io/ark2306/grpc-prediction-sidecar:local

.PHONY: clean
clean: ## Remove build output and generated stubs
	pnpm run clean
