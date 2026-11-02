package main

import (
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// 员工端 store 读取的 localStorage 键，见 web-antd src/store/emp-auth.ts。
const (
	empTokenStorageKey     = "linapro:emp-auth-token"
	empLarkAppIDStorageKey = "linapro:emp-lark-app-id"
	// localLarkAppID 是本地扮演时写入的占位飞书应用 ID；token 有效期内不会被使用。
	localLarkAppID = "local"
	// dashboardRoute 是员工端仪表盘的路由路径（不含 workspace base）。
	dashboardRoute = "/eval-360/emp/dashboard"
)

// printResult 输出员工信息、过期时间与可直接粘贴到浏览器 Console 的会话注入脚本。
func printResult(w io.Writer, emp employee, token string, expiresAt time.Time, configPath string) error {
	name := emp.Name
	if name == "" {
		name = "（-emp-id 模式未查库）"
	}
	fmt.Fprintf(w, "配置文件 : %s\n", configPath)
	fmt.Fprintf(w, "员工姓名 : %s\n", name)
	if emp.EmployeeNo != "" {
		fmt.Fprintf(w, "工号     : %s\n", emp.EmployeeNo)
	}
	fmt.Fprintf(w, "empId    : %d\n", emp.ID)
	fmt.Fprintf(w, "tenantId : %d\n", emp.TenantID)
	fmt.Fprintf(w, "过期时间 : %s\n", expiresAt.Format("2006-01-02 15:04:05 -07:00"))
	fmt.Fprintf(w, "\ntoken:\n%s\n", token)
	fmt.Fprintf(w, "\n先打开员工端同源页面（vite dev: http://localhost:5666/admin/ ；后端内嵌: http://localhost:9120/admin/），在浏览器 Console 中粘贴\n（Chrome 首次粘贴会拦截，需先手动输入 allow pasting 回车再粘贴）：\n\n%s\n", consoleSnippet(token))
	fmt.Fprintf(w, "\n手动打开：vite dev → http://localhost:5666/admin%s ；后端内嵌 → http://localhost:9120/admin/#%s\n", dashboardRoute, dashboardRoute)
	return nil
}

// consoleSnippet 生成写入员工会话并跳转到仪表盘的浏览器脚本。
// 路由模式按当前页面判断：hash 模式（生产构建）沿用当前 pathname 作为 base，
// history 模式（vite dev）按 /admin 前缀推断 base。跳转后强制刷新，
// 确保员工端 store 重新从 localStorage 读取 token。
func consoleSnippet(token string) string {
	quote := func(s string) string {
		b, _ := json.Marshal(s)
		return string(b)
	}
	return fmt.Sprintf(`localStorage.setItem(%s, %s);
localStorage.setItem(%s, %s);
(() => {
  const route = %s;
  if (location.hash.startsWith('#/')) {
    location.hash = route;
    location.reload();
  } else {
    const base = /^\/admin(\/|$)/.test(location.pathname) ? '/admin' : '';
    location.assign(location.origin + base + route);
  }
})();`,
		quote(empTokenStorageKey), quote(token),
		quote(empLarkAppIDStorageKey), quote(localLarkAppID),
		quote(dashboardRoute),
	)
}
