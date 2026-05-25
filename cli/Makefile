.PHONY: build install test clean sync-schema

BINARY := spx
BUILD_DIR := bin
INSTALL_PATH := $(HOME)/.local/bin
SCHEMA_SRC := ../schemas/state-json.schema.json
SCHEMA_DST := internal/state/schema.json
# Optional: if the skill repo is present on this machine, mirror the schema
# into the using-spx-cli skill's references/ so agents loading the skill see
# the same version. Skipped silently when the path doesn't exist.
SKILL_SCHEMA_DST := $(HOME)/Sources/skills/skills/using-spx-cli/references/state-json.schema.json

sync-schema:
	@cp $(SCHEMA_SRC) $(SCHEMA_DST)
	@if [ -d "$(dir $(SKILL_SCHEMA_DST))" ]; then cp $(SCHEMA_SRC) $(SKILL_SCHEMA_DST); fi

build: sync-schema
	go build -o $(BUILD_DIR)/$(BINARY) ./cmd/spx

install: build
	mkdir -p $(INSTALL_PATH)
	cp $(BUILD_DIR)/$(BINARY) $(INSTALL_PATH)/

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)
