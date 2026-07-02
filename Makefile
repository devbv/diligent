.PHONY: help test test-e2e lint lint-fix typecheck build build-all dev clean \
       release-local \
	       setup check-env config \
	       web-dev web-build web-start \
	       debug-dev debug-build \
	       dev-agent dev-cross dev-agent-nostudio \
	       check

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Development:"
	@echo "  dev             Run the diligent CLI (interactive terminal coding agent,"
	@echo "                  uses .diligent; local dev assistant, NOT the OVERDARE product."
	@echo "                  Same CLI binary is what CI runs, but make dev does not run CI)"
	@echo "  dev-agent       Run the OVERDARE agent in dev (sidecar + Vite, local Studio;"
	@echo "                  uses .overdare). STUDIO_HOST defaults to localhost"
	@echo "                  [STUDIO_PORT=13377] [STUDIO_PROJECT_DIR=/path for editing]"
	@echo "  dev-cross       Same as dev-agent but for a remote Studio (e.g. Windows):"
	@echo "                  STUDIO_HOST=<ip> [STUDIO_PORT=13377] [STUDIO_PROJECT_DIR=/Volumes/...]"
	@echo "  dev-agent-nostudio  Run the OVERDARE agent in dev WITHOUT Studio (no 13377 connect;"
	@echo "                  UI/chat only, edit & rollback tools unavailable)"
	@echo "  web-dev         Run the Web CLI locally: backend (:7433) + Vite (:5174), no Studio"
	@echo "  web-start       Run web backend server"
	@echo "  debug-dev       Run debug-viewer dev server"
	@echo ""
	@echo "Test / Lint:"
	@echo "  test            Run all tests"
	@echo "  test-e2e        Run end-to-end tests only"
	@echo "  lint            Lint (Biome)"
	@echo "  lint-fix        Lint + auto-fix"
	@echo "  typecheck       TypeScript type check"
	@echo "  check           Typecheck + test all packages (workspace coherence)"
	@echo ""
	@echo "Build:"
	@echo "  build           Build native binary (current platform)"
	@echo "  build-all       Build for all platforms (linux/darwin/windows)"
	@echo "  release-local   Build and install diligent into a user bin directory"
	@echo "  web-build       Build web frontend (Vite)"
	@echo "  debug-build     Build debug-viewer (Vite)"
	@echo "  clean           Remove dist/"
	@echo ""
	@echo "Setup:"
	@echo "  setup           Create .env from .env.example (won't overwrite)"
	@echo "  check-env       Verify API keys are configured"
	@echo "  config          Show current provider configuration"

# Storage namespace resolution: shell env > .env.local > overdare (product default).
# (The TS runtime defaults to 'diligent' when env is unset, but this repo/exe uses
#  overdare, so the diagnostic output reflects the .env.local value — same intent as
#  bun loading .env.local.)
STORAGE_NS := $(shell ns="$${DILIGENT_STORAGE_NAMESPACE}"; \
	if [ -z "$$ns" ] && [ -f .env.local ]; then \
		ns=$$(grep -E '^[[:space:]]*DILIGENT_STORAGE_NAMESPACE=' .env.local | tail -1 | cut -d= -f2- | tr -d ' "'); \
	fi; \
	echo "$${ns:-overdare}")

# --- Development ---

node_modules: package.json bun.lock
	bun install
	@touch node_modules

test: node_modules
	bun test

test-e2e: node_modules
	bun test packages/e2e/

lint: node_modules
	bun run lint

lint-fix: node_modules
	bun run lint:fix

typecheck: node_modules
	bun run typecheck

check: node_modules
	bun run verify

dev: node_modules
	bun run packages/cli/src/index.ts

# --- Web ---

# Run the Web CLI locally: web-only backend (:7433) + Vite frontend (:5174).
# Browser: http://localhost:5174 (Vite proxies /rpc to the backend). Ctrl+C stops both.
# No Studio tools (bundledToolProviders: []). For the OVERDARE agent use dev-agent*.
web-dev: node_modules
	@bun run packages/web/src/server/index.ts --dev & backend=$$!; \
	 trap "kill $$backend 2>/dev/null || true" EXIT INT TERM; \
	 bun run --cwd packages/web dev

web-build: node_modules
	bun run --cwd packages/web build

web-start: node_modules
	bun run --cwd packages/web start -- --cwd=$(CURDIR)

# Run the OVERDARE agent (the product) in dev — connect to a local Studio, use .overdare.
# (make dev is the diligent CLI dev assistant; this is the OVERDARE agent itself.)
#   make dev-agent [STUDIO_PORT=13377] [STUDIO_PROJECT_DIR=/path/to/StudioProject]
# STUDIO_HOST defaults to localhost. Same script, just with the host kept local.
dev-agent: node_modules
	@STUDIO_HOST="$(or $(STUDIO_HOST),localhost)" STUDIO_PORT="$(STUDIO_PORT)" STUDIO_PROJECT_DIR="$(STUDIO_PROJECT_DIR)" bash scripts/dev-cross-studio.sh

# Same as above but for a remote Studio (e.g. Windows) — STUDIO_HOST must be set.
#   make dev-cross STUDIO_HOST=192.168.0.42 [STUDIO_PORT=13377] [STUDIO_PROJECT_DIR=/Volumes/StudioProject]
# Values are also read from .env.local, so `make dev-cross` with no args works too.
dev-cross: node_modules
	@STUDIO_HOST="$(STUDIO_HOST)" STUDIO_PORT="$(STUDIO_PORT)" STUDIO_PROJECT_DIR="$(STUDIO_PROJECT_DIR)" bash scripts/dev-cross-studio.sh

# Run the OVERDARE agent in dev WITHOUT Studio — no connection to 13377 at all.
# The Studio RPC provider is skipped, so UI/chat work but edit & rollback tools
# are unavailable. Use when no Studio is running (e.g. web/UI development).
#   make dev-agent-nostudio
dev-agent-nostudio: node_modules
	@STUDIO_DISABLED=1 bash scripts/dev-cross-studio.sh

# --- Debug Viewer ---

debug-dev: node_modules
	bun run --cwd packages/debug-viewer dev

debug-build: node_modules
	bun run --cwd packages/debug-viewer build

# --- Build ---

build:
	bun run build

build-all:
	bun run build:all

release-local: build
	@bin_dir="$$BIN_DIR"; \
	if [ -z "$$bin_dir" ]; then \
	  for candidate in $$(printf '%s\n' "$$PATH" | tr ':' '\n'); do \
	    case "$$candidate" in \
	      "$$HOME"/*) \
	        case "$$candidate" in \
	          */node_modules/.bin) ;; \
	          *) bin_dir="$$candidate"; break ;; \
	        esac ;; \
	    esac; \
	  done; \
	fi; \
	if [ -z "$$bin_dir" ]; then bin_dir="$$HOME/.local/bin"; fi; \
	mkdir -p "$$bin_dir"; \
	cp -f dist/diligent "$$bin_dir/diligent"; \
	if [ "$(shell uname -s)" = "Darwin" ]; then codesign --force --sign - "$$bin_dir/diligent"; fi; \
	chmod +x "$$bin_dir/diligent"; \
	echo "Released diligent locally to $$bin_dir/diligent"; \
	case ":$$PATH:" in \
	  *:"$$bin_dir":*) ;; \
	  *) echo "Note: $$bin_dir is not currently on PATH. Add it to use 'diligent' directly." ;; \
	esac

clean:
	rm -rf dist/

# --- Setup ---

setup:
	@if [ -f .env ]; then \
		echo ".env already exists, skipping (edit manually or remove first)"; \
	else \
		cp .env.example .env; \
		echo "Created .env from .env.example"; \
		echo "Edit .env and add your API keys"; \
	fi

check-env:
	@echo "Checking provider credentials..."
	@has_any=0; \
	if [ -n "$$ANTHROPIC_API_KEY" ]; then \
		echo "  Anthropic: OK"; \
		has_any=1; \
	else \
		echo "  Anthropic: not set"; \
	fi; \
	if [ -n "$$OPENAI_API_KEY" ]; then \
		echo "  OpenAI:    OK"; \
		has_any=1; \
	else \
		echo "  OpenAI:    not set"; \
	fi; \
	model=$$(grep -hoE '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$$HOME/.$(STORAGE_NS)/config.jsonc" ".$(STORAGE_NS)/config.jsonc" 2>/dev/null | tail -1 | sed -E 's/.*"([^"]*)"$$/\1/'); \
	if [ -n "$$model" ]; then \
		echo "  Model:     $$model (from config.jsonc)"; \
	else \
		echo "  Model:     (set 'model' in config.jsonc to override default)"; \
	fi; \
	if [ $$has_any -eq 0 ]; then \
		echo ""; \
		echo "No API key found. Run: make setup"; \
		exit 1; \
	fi

config:
	@echo "=== Environment ==="
	@if [ -n "$$ANTHROPIC_API_KEY" ]; then echo "  ANTHROPIC_API_KEY: set"; else echo "  ANTHROPIC_API_KEY: (empty)"; fi
	@if [ -n "$$OPENAI_API_KEY" ]; then echo "  OPENAI_API_KEY: set"; else echo "  OPENAI_API_KEY: (empty)"; fi
	@model=$$(grep -hoE '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$$HOME/.$(STORAGE_NS)/config.jsonc" ".$(STORAGE_NS)/config.jsonc" 2>/dev/null | tail -1 | sed -E 's/.*"([^"]*)"$$/\1/'); \
	if [ -n "$$model" ]; then echo "  model (config.jsonc): $$model"; else echo "  model (config.jsonc): (not set)"; fi
	@echo ""
	@echo "=== Config Files (namespace: $(STORAGE_NS)) ==="
	@if [ -f .env ]; then echo "  .env: exists"; else echo "  .env: missing (run: make setup)"; fi
	@if [ -f ".$(STORAGE_NS)/config.jsonc" ]; then echo "  .$(STORAGE_NS)/config.jsonc (project): exists"; else echo "  .$(STORAGE_NS)/config.jsonc (project): none"; fi
	@if [ -f "$$HOME/.$(STORAGE_NS)/config.jsonc" ]; then echo "  ~/.$(STORAGE_NS)/config.jsonc (global): exists"; else echo "  ~/.$(STORAGE_NS)/config.jsonc (global): none"; fi
