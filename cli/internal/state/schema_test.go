package state

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestSchemaMirrorInSync makes sure the embedded copy under internal/state/
// matches the canonical schemas/state-json.schema.json at the repo root.
// The two-file layout exists so plain `go build` keeps working (embed needs
// the file inside the package tree) while non-Go tooling can still consume
// the root schemas/ directory. Drift between the two would be silent without
// this check.
func TestSchemaMirrorInSync(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	pkgDir := filepath.Dir(thisFile)
	canonical := filepath.Join(pkgDir, "..", "..", "..", "schemas", "state-json.schema.json")
	canonicalBytes, err := os.ReadFile(canonical)
	if err != nil {
		t.Fatalf("读取根目录 schema 失败: %v", err)
	}
	if !bytes.Equal(canonicalBytes, schemaBytes) {
		t.Fatalf("internal/state/schema.json 与 schemas/state-json.schema.json 内容不一致；请 `make sync-schema` 同步")
	}
}

func TestValidateAcceptsEmpty(t *testing.T) {
	if err := Validate([]byte(`{}`)); err != nil {
		t.Fatalf("空对象应当通过校验，得到: %v", err)
	}
}

func TestValidateRejectsBadColumn(t *testing.T) {
	err := Validate([]byte(`{"column":"todoo"}`))
	if err == nil {
		t.Fatal("非法 column 应当被拒绝")
	}
}

func TestValidateRejectsUnknownField(t *testing.T) {
	err := Validate([]byte(`{"weirdField":1}`))
	if err == nil {
		t.Fatal("未声明字段应当被 additionalProperties:false 拒绝")
	}
}

func TestValidateRejectsBadSpecFile(t *testing.T) {
	err := Validate([]byte(`{"specFile":"..."}`))
	if err == nil {
		t.Fatal("占位 `...` 应当被 pattern 拒绝")
	}
}

func TestValidateAcceptsFullState(t *testing.T) {
	full := `{
        "column":"in-progress",
        "sessionId":"abc",
        "implementSessionId":"impl-1",
        "reviewSessionId":"rev-1",
        "profilePath":"/home/x/.claude/settings.json",
        "specFile":"docs/superpowers/specs/foo.md",
        "planFile":"docs/superpowers/plans/foo.md",
        "pr":"42",
        "prMerged":true,
        "branch":"feature/abc",
        "worktreePath":".worktrees/foo",
        "implementStatus":"done",
        "color":"terminal.ansiBlue",
        "autoReview":true
    }`
	if err := Validate([]byte(full)); err != nil {
		t.Fatalf("完整合法 state 应当通过校验，得到: %v", err)
	}
}
