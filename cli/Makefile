.PHONY: build install test clean sync-schema

BINARY := spx
BUILD_DIR := bin
INSTALL_PATH := $(HOME)/.local/bin
SCHEMA_SRC := ../schemas/state-json.schema.json
SCHEMA_DST := internal/state/schema.json

sync-schema:
	@cp $(SCHEMA_SRC) $(SCHEMA_DST)

build: sync-schema
	go build -o $(BUILD_DIR)/$(BINARY) ./cmd/spx

install: build
	mkdir -p $(INSTALL_PATH)
	cp $(BUILD_DIR)/$(BINARY) $(INSTALL_PATH)/

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)
