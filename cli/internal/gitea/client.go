// Package gitea is a minimal Gitea REST client for the three calls spx needs:
// create issue, get/update issue body, create issue comment.
package gitea

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to a Gitea instance using a personal access token.
type Client struct {
	BaseURL    string // host without trailing slash, e.g. "https://gitea.example.com"
	Token      string
	HTTPClient *http.Client
}

// New builds a Client with sane defaults.
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Token:      token,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// Issue is the subset of Gitea's Issue object spx cares about.
type Issue struct {
	Number  int    `json:"number"`
	Body    string `json:"body"`
	HTMLURL string `json:"html_url"`
}

// Comment is the subset of Gitea's Comment object spx cares about.
type Comment struct {
	ID      int64  `json:"id"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
}

// do executes an HTTP request with auth + JSON content type and decodes the
// response into out (if non-nil and the body is non-empty).
func (c *Client) do(method, path string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		buf, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("编码请求体失败: %w", err)
		}
		body = bytes.NewReader(buf)
	}
	url := c.BaseURL + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("Authorization", "token "+c.Token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s 请求失败: %w", method, url, err)
	}
	defer resp.Body.Close()
	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s 返回 %d: %s", method, url, resp.StatusCode, strings.TrimSpace(string(respBytes)))
	}
	if out == nil || len(respBytes) == 0 {
		return nil
	}
	if err := json.Unmarshal(respBytes, out); err != nil {
		return fmt.Errorf("解析响应失败 (%s %s): %w; body=%s", method, url, err, string(respBytes))
	}
	return nil
}

// CreateIssue creates a new issue and returns the created object.
func (c *Client) CreateIssue(owner, repo, title, body string) (*Issue, error) {
	path := fmt.Sprintf("/api/v1/repos/%s/%s/issues", owner, repo)
	payload := map[string]any{"title": title, "body": body}
	var out Issue
	if err := c.do(http.MethodPost, path, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetIssue fetches an existing issue (or PR — Gitea treats PRs as issues for
// metadata purposes).
func (c *Client) GetIssue(owner, repo string, number int) (*Issue, error) {
	path := fmt.Sprintf("/api/v1/repos/%s/%s/issues/%d", owner, repo, number)
	var out Issue
	if err := c.do(http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateIssueBody patches an issue's body field.
func (c *Client) UpdateIssueBody(owner, repo string, number int, body string) error {
	path := fmt.Sprintf("/api/v1/repos/%s/%s/issues/%d", owner, repo, number)
	payload := map[string]any{"body": body}
	return c.do(http.MethodPatch, path, payload, nil)
}

// CreateIssueComment posts a comment on an issue or PR.
//
// In Gitea, PR comments (not review threads) live under the same endpoint as
// issue comments — pass the PR number as the issue number.
func (c *Client) CreateIssueComment(owner, repo string, number int, body string) (*Comment, error) {
	path := fmt.Sprintf("/api/v1/repos/%s/%s/issues/%d/comments", owner, repo, number)
	payload := map[string]any{"body": body}
	var out Comment
	if err := c.do(http.MethodPost, path, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
