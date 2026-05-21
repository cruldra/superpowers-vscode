// Package marker manages spx HTML-comment markers embedded in issue/PR bodies.
//
// Markers look like:  <!-- spx:spec=docs/specs/foo.md -->
//
// They let spx and the surrounding tooling round-trip metadata (spec/plan
// paths, review flags, etc.) without dedicated Gitea fields.
package marker

import (
	"fmt"
	"regexp"
	"strings"
)

// markerRegex builds a regex matching a full marker line of the given type.
//
// The "value" capture group accepts any sequence of non-whitespace, non-'>'
// characters, mirroring how the marker is written by UpsertMarker.
func markerRegex(markerType string) *regexp.Regexp {
	return regexp.MustCompile(`<!--\s*spx:` + regexp.QuoteMeta(markerType) + `=([^\s>]*)\s*-->`)
}

// reviewMarkerRegex matches the review-comment lead marker.
var reviewMarkerRegex = regexp.MustCompile(`<!--\s*spx:review=1\s*-->`)

// UpsertMarker inserts or updates a marker of the given type in body.
//
// If a marker of this type already exists, the matching marker (just the tag,
// not the whole line) is replaced in place. Otherwise the marker is appended
// to the end of the body, separated by a newline so it sits on its own line.
//
// Other marker types in the body are preserved untouched.
func UpsertMarker(body, markerType, value string) string {
	newMarker := fmt.Sprintf("<!-- spx:%s=%s -->", markerType, value)
	re := markerRegex(markerType)
	if re.MatchString(body) {
		return re.ReplaceAllString(body, newMarker)
	}
	if body == "" {
		return newMarker
	}
	// Ensure separation: end with at least one newline before the new marker.
	if strings.HasSuffix(body, "\n") {
		return body + newMarker
	}
	return body + "\n" + newMarker
}

// PrependReviewMarker prepends "<!-- spx:review=1 -->\n\n" to body if not
// already present. Idempotent: bodies already containing the marker are
// returned unchanged.
func PrependReviewMarker(body string) string {
	if reviewMarkerRegex.MatchString(body) {
		return body
	}
	const lead = "<!-- spx:review=1 -->\n\n"
	return lead + body
}
