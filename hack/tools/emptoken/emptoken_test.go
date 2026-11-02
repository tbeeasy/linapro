package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lina-plugin-linapro-employee-core/backend/cap/empcap"
)

// testSecret 仅用于单测，与任何真实环境密钥无关。
const testSecret = "emptoken-unit-test-secret"

// TestSignedTokenPassesEmpcapVerify 用 empcap 自身的 VerifyToken 校验本工具签出的 token，
// 保证载荷结构、签名算法与后端完全一致。
func TestSignedTokenPassesEmpcapVerify(t *testing.T) {
	empcap.BindTokenSecretProvider(func(context.Context) (string, error) { return testSecret, nil })
	t.Cleanup(func() { empcap.BindTokenSecretProvider(nil) })

	token, err := signEmpToken(testSecret, 1001, 2, time.Now(), defaultTTL)
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	got, err := empcap.VerifyToken(context.Background(), token)
	if err != nil {
		t.Fatalf("empcap 验签失败: %v", err)
	}
	if got.EmpID != 1001 || got.TenantID != 2 {
		t.Fatalf("身份不一致: %+v", got)
	}
}

// TestEmpcapRejectsWrongSecretAndExpired 确认错误密钥与已过期 token 都会被 empcap 拒绝。
func TestEmpcapRejectsWrongSecretAndExpired(t *testing.T) {
	empcap.BindTokenSecretProvider(func(context.Context) (string, error) { return testSecret, nil })
	t.Cleanup(func() { empcap.BindTokenSecretProvider(nil) })

	wrong, _ := signEmpToken("other-secret", 1, 1, time.Now(), time.Hour)
	if _, err := empcap.VerifyToken(context.Background(), wrong); err == nil {
		t.Fatal("错误密钥签出的 token 不应通过")
	}
	expired, _ := signEmpToken(testSecret, 1, 1, time.Now().Add(-2*time.Hour), time.Hour)
	if _, err := empcap.VerifyToken(context.Background(), expired); err == nil {
		t.Fatal("已过期 token 不应通过")
	}
}

// TestPickEmployee 覆盖不存在、多租户歧义、离职与正常命中。
func TestPickEmployee(t *testing.T) {
	active := employee{ID: 7, TenantID: 1, Name: "张三", EmployeeNo: "GZ1", Status: statusActive}
	departed := employee{ID: 8, TenantID: 1, Name: "李四", EmployeeNo: "GZ2", Status: statusDeparted}

	if _, err := pickEmployee(nil, "GZ0", -1); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("不存在应报错, got %v", err)
	}
	if _, err := pickEmployee([]employee{active, {ID: 9, TenantID: 2, Status: statusActive}}, "GZ1", -1); err == nil || !strings.Contains(err.Error(), "-tenant-id") {
		t.Fatalf("多租户应提示 -tenant-id, got %v", err)
	}
	if _, err := pickEmployee([]employee{departed}, "GZ2", -1); err == nil || !strings.Contains(err.Error(), "离职") {
		t.Fatalf("离职应报错, got %v", err)
	}
	got, err := pickEmployee([]employee{active}, "GZ1", -1)
	if err != nil || got.ID != 7 {
		t.Fatalf("正常命中失败: %+v %v", got, err)
	}
}

// TestParseFlags 覆盖参数互斥与必填校验。
func TestParseFlags(t *testing.T) {
	cases := []struct {
		args []string
		ok   bool
	}{
		{[]string{"-emp-no", "GZ1"}, true},
		{[]string{"-emp-id", "5", "-tenant-id", "1", "-ttl", "2h"}, true},
		{[]string{}, false},
		{[]string{"-emp-no", "GZ1", "-emp-id", "5"}, false},
		{[]string{"-emp-id", "5"}, false},
		{[]string{"-emp-no", "GZ1", "-ttl", "0s"}, false},
	}
	for _, c := range cases {
		_, err := parseFlags(c.args, &strings.Builder{})
		if (err == nil) != c.ok {
			t.Errorf("args=%v ok=%v err=%v", c.args, c.ok, err)
		}
	}
	opts, _ := parseFlags([]string{"-emp-no", "GZ1"}, &strings.Builder{})
	if opts.ttl != defaultTTL {
		t.Errorf("默认有效期应为 30 天, got %v", opts.ttl)
	}
}

// TestLoadLocalConfig 校验读取嵌套键（含 YAML 合并键）与缺失密钥时报错。
func TestLoadLocalConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := `database:
  default:
    link: "pgsql:u:p@tcp(127.0.0.1:5432)/db"
shared: &shared
  foo: bar
plugin:
  linapro-employee-core:
    emp_jwt_secret: "s3cret"
    <<: [*shared]
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadLocalConfig(path)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if cfg.secret != "s3cret" || !strings.HasPrefix(cfg.dbLink, "pgsql:") {
		t.Fatalf("读取结果不符: dbLink=%q", cfg.dbLink)
	}

	if err := os.WriteFile(path, []byte("database: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadLocalConfig(path); err == nil {
		t.Fatal("缺少密钥时应报错")
	}
}

// TestConsoleSnippet 确认注入脚本写入两个 localStorage 键与占位 larkAppId。
func TestConsoleSnippet(t *testing.T) {
	s := consoleSnippet("a.b.c")
	for _, want := range []string{`"linapro:emp-auth-token", "a.b.c"`, `"linapro:emp-lark-app-id", "local"`, `"/eval-360/emp/dashboard"`} {
		if !strings.Contains(s, want) {
			t.Errorf("脚本缺少 %s:\n%s", want, s)
		}
	}
}
