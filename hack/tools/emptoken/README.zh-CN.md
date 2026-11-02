# emptoken

本地开发工具：按工号（或直接按 EmpID）签发员工 JWT，让开发者在本地扮演指定员工打开员工端页面（如 360 测评员工端），无需走飞书免登。

- 签名算法与载荷与 `linapro-employee-core` 的 `empcap` 一致：HS256、`{ empId, tenantId, exp, iat }`。
- 签名密钥只从本地宿主配置 `plugin.linapro-employee-core.emp_jwt_secret` 读取，不硬编码、不输出。
- 独立`Go module`，仅供`go run`使用，不被任何服务端包引用，不会编进服务端。

## 使用方式

```bash
# 仓库根目录执行
go run ./hack/tools/emptoken -emp-no GZ000071
go run ./hack/tools/emptoken -emp-no GZ000071 -ttl 720h -tenant-id 1
go run ./hack/tools/emptoken -emp-id 1907 -tenant-id 1
go run ./hack/tools/emptoken -emp-no GZ000071 -raw   # 只输出 token
```

| 参数 | 说明 |
| --- | --- |
| `-emp-no` | Moka 工号。查本地员工表 `plugin_linapro_employee_core_employee`（排除软删行），不存在或已离职直接报错退出。 |
| `-emp-id` | 内部 EmpID。跳过查库直接签发，须同时给 `-tenant-id`；在职校验交给后端 `EmpAuth`。与 `-emp-no` 二选一。 |
| `-tenant-id` | 租户 ID。`-emp-id` 模式必填；`-emp-no` 模式下同一工号命中多个租户时用于消歧。 |
| `-ttl` | 有效期，默认 `720h`（30 天）。`empcap` 校验不限制 `exp` 上限。 |
| `-config` | 宿主配置文件路径，默认从当前目录向上查找 `apps/lina-core/manifest/config/config.yaml`。 |
| `-raw` | 只输出 token，便于脚本或 `curl` 使用。 |

## 输出

员工姓名、工号、`empId`、`tenantId`、过期时间、token，以及一段可直接粘到员工端同源页面浏览器 Console 的脚本：写入 `linapro:emp-auth-token`、`linapro:emp-lark-app-id`（值为 `local`）后跳转到 `/eval-360/emp/dashboard`。脚本自动兼容 hash 路由（生产构建）与 history 路由（vite dev）。Chrome 首次往 Console 粘贴会拦截，需先手动输入 `allow pasting` 回车再粘贴。

## 前提

- 本地宿主已安装并启用 `linapro-employee-core`；
- 本地员工表中有目标员工（通常由员工目录同步写入）。

## 验证

```bash
cd hack/tools/emptoken
go build ./... && go vet ./... && go test ./...
```

单测直接调用 `empcap.VerifyToken` 验签，确保签出的 token 与后端解析逻辑一致；`empcap` 仅在测试中引用。接口联调：

```bash
TOKEN=$(go run ./hack/tools/emptoken -emp-no GZ000071 -raw)
curl -H "Authorization: Bearer $TOKEN" http://localhost:9120/x/linapro-eval-360/api/v1/eval/emp/whoami
```
