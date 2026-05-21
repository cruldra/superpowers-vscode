// Package tea reads the tea CLI config to extract Gitea host + token.
//
// tea config typically lives at $HOME/.config/tea/config.yml. Older versions
// of tea (<v0.10) stored the token inline in the YAML; newer versions move
// tokens into a system keyring and only keep metadata in the file.
//
// We support the inline form here (matches the spx task contract). If the
// token field is missing, callers should consider falling back to a
// GITEA_TOKEN environment variable and emit a clear error otherwise.
package tea

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// TeaLogin represents a single login entry in tea config.yml.
type TeaLogin struct {
	Name    string `yaml:"name"`
	URL     string `yaml:"url"`
	Token   string `yaml:"token"`
	Default bool   `yaml:"default"`
}

// TeaConfig is the top-level structure of tea config.yml.
type TeaConfig struct {
	Logins []TeaLogin `yaml:"logins"`
}

// DefaultConfigPath returns the conventional path to tea's config.yml.
func DefaultConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("解析 home 目录失败: %w", err)
	}
	return filepath.Join(home, ".config", "tea", "config.yml"), nil
}

// load reads and parses the tea config file at the given path.
func load(path string) (*TeaConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 tea config %s 失败: %w", path, err)
	}
	var cfg TeaConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("解析 tea config %s 失败: %w", path, err)
	}
	return &cfg, nil
}

// LoadDefault returns host and token from the default login entry.
//
// If multiple logins have default=true, the first wins. If no entry is marked
// default, the first entry is used.
func LoadDefault() (host, token string, err error) {
	path, err := DefaultConfigPath()
	if err != nil {
		return "", "", err
	}
	cfg, err := load(path)
	if err != nil {
		return "", "", err
	}
	if len(cfg.Logins) == 0 {
		return "", "", fmt.Errorf("tea config %s 里没有 logins 条目，请先运行 `tea login add`", path)
	}
	var chosen *TeaLogin
	for i := range cfg.Logins {
		if cfg.Logins[i].Default {
			chosen = &cfg.Logins[i]
			break
		}
	}
	if chosen == nil {
		chosen = &cfg.Logins[0]
	}
	return chosen.URL, chosen.Token, nil
}

// LoadByHost returns the token for the login whose URL matches host.
//
// Host matching is case-insensitive and ignores trailing slashes.
func LoadByHost(host string) (token string, err error) {
	path, err := DefaultConfigPath()
	if err != nil {
		return "", err
	}
	cfg, err := load(path)
	if err != nil {
		return "", err
	}
	want := strings.TrimRight(strings.ToLower(host), "/")
	for _, l := range cfg.Logins {
		if strings.TrimRight(strings.ToLower(l.URL), "/") == want {
			return l.Token, nil
		}
	}
	return "", fmt.Errorf("tea config 里没找到 host=%s 的 login", host)
}
