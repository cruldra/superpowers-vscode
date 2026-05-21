package marker

import (
	"strings"
	"testing"
)

func TestUpsertMarkerAppendsWhenAbsent(t *testing.T) {
	got := UpsertMarker("hello body", "spec", "docs/specs/x.md")
	want := "hello body\n<!-- spx:spec=docs/specs/x.md -->"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestUpsertMarkerReplacesWhenPresent(t *testing.T) {
	body := "intro\n<!-- spx:spec=old.md -->\nmore"
	got := UpsertMarker(body, "spec", "new.md")
	if strings.Contains(got, "old.md") {
		t.Fatalf("old value should be gone: %q", got)
	}
	if !strings.Contains(got, "<!-- spx:spec=new.md -->") {
		t.Fatalf("new marker missing: %q", got)
	}
	// Other content preserved.
	if !strings.Contains(got, "intro") || !strings.Contains(got, "more") {
		t.Fatalf("surrounding content lost: %q", got)
	}
}

func TestUpsertMarkerLeavesOtherTypesAlone(t *testing.T) {
	body := "<!-- spx:plan=p.md -->\n<!-- spx:spec=old.md -->"
	got := UpsertMarker(body, "spec", "new.md")
	if !strings.Contains(got, "<!-- spx:plan=p.md -->") {
		t.Fatalf("plan marker should be preserved: %q", got)
	}
	if !strings.Contains(got, "<!-- spx:spec=new.md -->") {
		t.Fatalf("spec marker should be updated: %q", got)
	}
}

func TestUpsertMarkerEmptyBody(t *testing.T) {
	got := UpsertMarker("", "plan", "p.md")
	want := "<!-- spx:plan=p.md -->"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestPrependReviewMarkerAdds(t *testing.T) {
	got := PrependReviewMarker("body")
	want := "<!-- spx:review=1 -->\n\nbody"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestPrependReviewMarkerIdempotent(t *testing.T) {
	body := "<!-- spx:review=1 -->\n\nbody"
	got := PrependReviewMarker(body)
	if got != body {
		t.Fatalf("expected unchanged, got %q", got)
	}
}
