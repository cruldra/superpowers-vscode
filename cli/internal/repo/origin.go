// Package repo detects the owner/repo pair from a git working directory's
// origin remote.
package repo

import (
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
)

// sshLikeRegex matches `git@host:owner/repo(.git)?` style remotes.
//
// Excludes URI-shaped strings (anything with "://") so those go through
// url.Parse instead.
var sshLikeRegex = regexp.MustCompile(`^[^@/:]+@([^:/]+):(.+?)/?$`)

// DetectOwnerRepo runs `git -C cwd remote get-url origin` and parses the URL.
//
// Supported formats:
//   - https://host/owner/repo(.git)
//   - http://host/owner/repo(.git)
//   - ssh://git@host[:port]/owner/repo(.git)
//   - git@host:owner/repo(.git)
//
// owner may include subgroups (e.g. "group/subgroup") if the host supports it;
// repo is the last path segment without the .git suffix.
func DetectOwnerRepo(cwd string) (owner, repo string, err error) {
	cmd := exec.Command("git", "-C", cwd, "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("git remote get-url origin 失败 (cwd=%s): %w", cwd, err)
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return "", "", fmt.Errorf("origin remote 是空的 (cwd=%s)", cwd)
	}
	return parseRemoteURL(raw)
}

// parseRemoteURL is the pure-logic core of DetectOwnerRepo, extracted for testing.
func parseRemoteURL(raw string) (owner, repo string, err error) {
	// Try scp-like ssh: `git@host:owner/repo.git` (only if not URI-shaped).
	if !strings.Contains(raw, "://") {
		if m := sshLikeRegex.FindStringSubmatch(raw); m != nil {
			return splitOwnerRepo(m[2])
		}
	}
	// Try URL form (http/https/ssh://).
	u, perr := url.Parse(raw)
	if perr != nil {
		return "", "", fmt.Errorf("无法解析 origin URL %q: %w", raw, perr)
	}
	path := strings.TrimPrefix(u.Path, "/")
	if path == "" {
		return "", "", fmt.Errorf("origin URL %q 没有 path 部分", raw)
	}
	return splitOwnerRepo(path)
}

// splitOwnerRepo turns "owner/repo(.git)" into ("owner", "repo").
func splitOwnerRepo(path string) (owner, repo string, err error) {
	path = strings.TrimSuffix(path, "/")
	path = strings.TrimSuffix(path, ".git")
	idx := strings.LastIndex(path, "/")
	if idx <= 0 || idx == len(path)-1 {
		return "", "", fmt.Errorf("origin path %q 不是 owner/repo 形式", path)
	}
	return path[:idx], path[idx+1:], nil
}
