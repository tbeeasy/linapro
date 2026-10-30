## 1. 共享库改造

- [x] 1.1 `git mv backend/hcm hcm`（7 个文件，保留历史）
- [x] 1.2 删除`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`、`frontend/`、`manifest/`（含`manifest/i18n/{en-US,zh-CN}/plugin.json`）
- [x] 1.3 `go.mod`模块名改为`linapro-moka-hcm`
- [x] 1.4 新增中英双语`README.md`/`README.zh-CN.md`

## 2. 使用方迁移

- [x] 2.1 `linapro-employee-core`：`go.mod`的`require`+`replace`改名，`backend/plugin_sync.go`导入改为`linapro-moka-hcm/hcm`
- [x] 2.2 `linapro-moka-report-sync`：`go.mod`的`require`+`replace`改名，`backend/internal/config/config.go`、`backend/internal/service/sync.go`导入改为`linapro-moka-hcm/hcm`
- [x] 2.3 `hack/tools/emptoken/go.mod`的`replace`路径改为指向`apps/lina-plugins/linapro-moka-hcm`
- [ ] 2.4 （用户执行）从`apps/lina-core/manifest/config/`的`plugin.autoEnable`删除`linapro-moka-hcm`条目
- [ ] 2.5 （用户执行）清理`sys_plugin`表中`linapro-moka-hcm`的孤儿记录

## 3. 规格修复

- [x] 3.1 回滚先前对`openspec/specs/linapro-moka-hcm/spec.md`的直接手改，主规格恢复为归档前版本
- [x] 3.2 新建本变更目录：`proposal.md`、`design.md`、`tasks.md`、`specs/linapro-moka-hcm/spec.md`（`ADDED`/`MODIFIED`/`REMOVED`增量）
- [x] 3.3 增量规范`REMOVED`掉`插件注册与客户端工厂`要求，`ADDED``共享库模块边界`要求，`MODIFIED`四个与实现不符的要求

## 4. 验证

- [x] 4.1 三个模块`GOWORK=off go build ./... && go vet ./...`通过（`linapro-moka-report-sync`因既有 go.sum 缺项需`-mod=mod`，验证后 go.sum 已还原）
- [x] 4.2 `make lint dir=apps/lina-plugins/linapro-moka-hcm plugins=0`通过
- [x] 4.3 `make plugins.check`：指向`linapro-moka-hcm`旧路径的 finding 消失
- [x] 4.4 `openspec validate linapro-moka-hcm-shared-lib --strict`通过
- [x] 4.5 调用`lina-review`完成代码与规范审查（2026-10-29：0 严重 / 2 警告。警告一：`hcm/`下 6 个 Go 文件缺文件用途注释（`author.go`、`sign.go`、`report.go`、`employee.go`、`sign_test.go`、`employee_test.go`），违反`backend-go.md`「Go 源码文件必须文件用途注释」；警告二：本库 27 条`go-caller-error-han`runtime i18n 命中为迁移前后同一批`gerror`中文错误，非本变更引入，按`Non-Goals`不在本次清理）
- [x] 4.6 补齐警告一：6 个文件各加中文文件用途注释（职责、主要逻辑、约束），`client.go`保持既有包注释不动；`gofmt -l`无输出、`go build`/`go vet`/`go test`通过、`make lint`0 issues

**剩余警告**：4.5 的警告二（27 条`go-caller-error-han`）按`Non-Goals`保留，需另立变更处理。
