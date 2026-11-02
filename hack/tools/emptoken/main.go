// Package main 实现本地开发工具 emptoken：按工号（或直接按 EmpID）签发员工 JWT，
// 让开发者在本地扮演指定员工打开员工端页面，无需走飞书免登。
//
// 本工具是独立 module，只被 go run 调用，不会被任何服务端包 import，
// 也不改动 empcap 的签发/校验链路；签名算法与载荷结构与 empcap 保持一致。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

// defaultTTL 是默认有效期（30 天）。empcap 校验不限制 exp 上限，可放心签长期 token。
const defaultTTL = 30 * 24 * time.Hour

// options 是一次命令调用解析出的参数。
type options struct {
	empNo      string
	empID      int64
	tenantID   int
	configPath string
	ttl        time.Duration
	raw        bool
}

// main 执行一次 emptoken 调用，失败时以非零码退出。
func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "emptoken:", err)
		os.Exit(1)
	}
}

// run 解析参数、解析员工身份、签发 token 并输出结果。
func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	opts, err := parseFlags(args, stderr)
	if err != nil {
		return err
	}

	configPath, err := resolveConfigPath(opts.configPath)
	if err != nil {
		return err
	}
	cfg, err := loadLocalConfig(configPath)
	if err != nil {
		return err
	}

	var emp employee
	if opts.empID > 0 {
		// 跳过查库：身份完全由命令行给出，在职校验交给后端 EmpAuth。
		emp = employee{ID: opts.empID, TenantID: opts.tenantID}
	} else {
		emp, err = lookupEmployee(ctx, cfg.dbLink, opts.empNo, opts.tenantID)
		if err != nil {
			return err
		}
	}

	now := time.Now()
	token, err := signEmpToken(cfg.secret, emp.ID, emp.TenantID, now, opts.ttl)
	if err != nil {
		return fmt.Errorf("签发员工 JWT 失败: %w", err)
	}

	if opts.raw {
		_, err = fmt.Fprintln(stdout, token)
		return err
	}
	return printResult(stdout, emp, token, now.Add(opts.ttl), configPath)
}

// parseFlags 解析并校验命令行参数。
func parseFlags(args []string, stderr io.Writer) (options, error) {
	var opts options
	fs := flag.NewFlagSet("emptoken", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.empNo, "emp-no", "", "Moka 工号（如 GZ000071），查本地员工表得到 empId/tenantId 并校验在职")
	fs.Int64Var(&opts.empID, "emp-id", 0, "内部 EmpID；给出时跳过查库直接签发，须同时给 -tenant-id")
	fs.IntVar(&opts.tenantID, "tenant-id", -1, "租户 ID；-emp-id 模式必填，-emp-no 模式用于同一工号命中多个租户时消歧")
	fs.StringVar(&opts.configPath, "config", "", "宿主配置文件路径，默认自动向上查找 apps/lina-core/manifest/config/config.yaml")
	fs.DurationVar(&opts.ttl, "ttl", defaultTTL, "token 有效期，如 2h、720h")
	fs.BoolVar(&opts.raw, "raw", false, "只输出 token 本身（便于脚本/curl 使用）")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "用法: go run ./hack/tools/emptoken -emp-no <工号> [-ttl 720h] [-tenant-id N]")
		fmt.Fprintln(stderr, "      go run ./hack/tools/emptoken -emp-id <EmpID> -tenant-id <N> [-ttl 720h]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if fs.NArg() > 0 {
		return options{}, fmt.Errorf("存在无法识别的参数: %v", fs.Args())
	}

	switch {
	case opts.empNo == "" && opts.empID == 0:
		fs.Usage()
		return options{}, errors.New("必须给出 -emp-no 或 -emp-id 之一")
	case opts.empNo != "" && opts.empID != 0:
		return options{}, errors.New("-emp-no 与 -emp-id 只能二选一")
	case opts.empID < 0:
		return options{}, errors.New("-emp-id 必须为正数")
	case opts.empID > 0 && opts.tenantID < 0:
		return options{}, errors.New("-emp-id 模式必须同时给出 -tenant-id")
	case opts.ttl <= 0:
		return options{}, errors.New("-ttl 必须大于 0")
	}
	return opts, nil
}
