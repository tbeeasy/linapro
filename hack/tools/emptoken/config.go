package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gogf/gf/v2/encoding/gjson"
)

// hostConfigRelPath 是宿主本地配置文件相对仓库根的位置。
const hostConfigRelPath = "apps/lina-core/manifest/config/config.yaml"

// 本工具从宿主配置中读取的两个键。
const (
	secretConfigKey = "plugin.linapro-employee-core.emp_jwt_secret"
	dbLinkConfigKey = "database.default.link"
)

// localConfig 是从本地配置读出的签发所需信息。secret 只在进程内使用，绝不输出。
type localConfig struct {
	secret string
	dbLink string
}

// resolveConfigPath 返回要读取的配置文件绝对路径：显式给出时直接使用，
// 否则从当前目录逐级向上查找仓库内的宿主配置文件。
func resolveConfigPath(explicit string) (string, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(abs); err != nil {
			return "", fmt.Errorf("配置文件不可读: %w", err)
		}
		return abs, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, filepath.FromSlash(hostConfigRelPath))
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("未找到 %s，请在仓库内运行或用 -config 指定", hostConfigRelPath)
		}
		dir = parent
	}
}

// loadLocalConfig 读取签名密钥与数据库连接串。
func loadLocalConfig(path string) (localConfig, error) {
	j, err := gjson.Load(path, true)
	if err != nil {
		return localConfig{}, fmt.Errorf("解析配置文件 %s 失败: %w", path, err)
	}
	cfg := localConfig{
		secret: strings.TrimSpace(j.Get(secretConfigKey).String()),
		dbLink: strings.TrimSpace(j.Get(dbLinkConfigKey).String()),
	}
	if cfg.secret == "" {
		return localConfig{}, errors.New("本地配置缺少 " + secretConfigKey)
	}
	return cfg, nil
}
