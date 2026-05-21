package repo

import "testing"

func TestParseRemoteURL(t *testing.T) {
	cases := []struct {
		raw, owner, repo string
	}{
		{"https://gitea.example.com/foo/bar.git", "foo", "bar"},
		{"https://gitea.example.com/foo/bar", "foo", "bar"},
		{"http://localhost:3000/foo/bar.git", "foo", "bar"},
		{"git@gitea.example.com:foo/bar.git", "foo", "bar"},
		{"git@gitea.example.com:foo/bar", "foo", "bar"},
		{"ssh://git@gitea.example.com:22/foo/bar.git", "foo", "bar"},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			owner, repo, err := parseRemoteURL(c.raw)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if owner != c.owner || repo != c.repo {
				t.Fatalf("got %s/%s want %s/%s", owner, repo, c.owner, c.repo)
			}
		})
	}
}

func TestParseRemoteURLRejectsBadInput(t *testing.T) {
	bad := []string{
		"",
		"not a url",
		"https://gitea.example.com/",
		"https://gitea.example.com/onlyowner",
	}
	for _, raw := range bad {
		if _, _, err := parseRemoteURL(raw); err == nil {
			t.Fatalf("expected error for %q", raw)
		}
	}
}
