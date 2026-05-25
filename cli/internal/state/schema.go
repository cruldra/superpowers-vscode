// Package state embeds the issue state JSON schema and exposes a Validate
// helper for spx subcommands.
//
// The schema lives in the repo root under schemas/ so non-Go tooling
// (TypeScript / docs) can pick it up too; we embed it at build time so the
// shipped binary doesn't depend on the source tree.
package state

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

//go:embed schema.json
var schemaBytes []byte

var (
	compiled     *jsonschema.Schema
	compiledOnce sync.Once
	compiledErr  error
)

// SchemaBytes returns the embedded schema document. Useful for tooling that
// wants to dump or re-publish the schema.
func SchemaBytes() []byte {
	out := make([]byte, len(schemaBytes))
	copy(out, schemaBytes)
	return out
}

// compile parses the embedded schema once and caches it.
func compile() (*jsonschema.Schema, error) {
	compiledOnce.Do(func() {
		c := jsonschema.NewCompiler()
		c.Draft = jsonschema.Draft7
		// Use a synthetic URL — the real $id in the schema is just a marker.
		const url = "memory://state-json.schema.json"
		if err := c.AddResource(url, strings.NewReader(string(schemaBytes))); err != nil {
			compiledErr = fmt.Errorf("加载内嵌 schema 失败: %w", err)
			return
		}
		sch, err := c.Compile(url)
		if err != nil {
			compiledErr = fmt.Errorf("编译内嵌 schema 失败: %w", err)
			return
		}
		compiled = sch
	})
	return compiled, compiledErr
}

// Validate parses jsonBytes as JSON and validates the resulting value against
// the embedded state schema. Returns nil on success and a descriptive error
// (listing failing fields and rules) on validation failure.
func Validate(jsonBytes []byte) error {
	sch, err := compile()
	if err != nil {
		return err
	}
	var doc any
	if err := json.Unmarshal(jsonBytes, &doc); err != nil {
		return fmt.Errorf("state JSON 解析失败: %w", err)
	}
	if err := sch.Validate(doc); err != nil {
		return formatValidationError(err)
	}
	return nil
}

// ValidateValue validates an already-parsed value (e.g. the merged map).
func ValidateValue(v any) error {
	sch, err := compile()
	if err != nil {
		return err
	}
	if err := sch.Validate(v); err != nil {
		return formatValidationError(err)
	}
	return nil
}

// formatValidationError flattens a jsonschema validation tree into a
// human-readable, multi-line error listing each failing field and rule.
func formatValidationError(err error) error {
	ve, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return fmt.Errorf("state JSON 校验失败: %w", err)
	}
	var lines []string
	collectValidationLines(ve, &lines)
	if len(lines) == 0 {
		return fmt.Errorf("state JSON 校验失败: %s", ve.Error())
	}
	return fmt.Errorf("state JSON 校验失败:\n  - %s", strings.Join(lines, "\n  - "))
}

// collectValidationLines walks the validation tree and emits one line per leaf
// failure: "<json-pointer>: <message>".
func collectValidationLines(ve *jsonschema.ValidationError, out *[]string) {
	if ve == nil {
		return
	}
	if len(ve.Causes) == 0 {
		loc := ve.InstanceLocation
		if loc == "" {
			loc = "(root)"
		}
		*out = append(*out, fmt.Sprintf("%s: %s", loc, ve.Message))
		return
	}
	for _, c := range ve.Causes {
		collectValidationLines(c, out)
	}
}
