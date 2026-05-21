.PHONY: build install test clean

BINARY := spx
BUILD_DIR := bin
INSTALL_PATH := $(HOME)/.local/bin

build:
	go build -o $(BUILD_DIR)/$(BINARY) ./cmd/spx

install: build
	mkdir -p $(INSTALL_PATH)
	cp $(BUILD_DIR)/$(BINARY) $(INSTALL_PATH)/

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)
