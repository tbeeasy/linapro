## 1. 共享库改造

- [x] 1.1 `git mv backend/moka moka`（10 个文件，保留历史）
- [x] 1.2 删除`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`、`frontend/`、`manifest/`（含`manifest/i18n/{en-US,zh-CN}/plugin.json`）
- [x] 1.3 `go.mod`模块名改为`linapro-moka-recruit`
- [x] 1.4 新增中英双语`README.md`/`README.zh-CN.md`

## 2. 使用方迁移

- [x] 2.1 `linapro-moka-report-sync`：`go.mod`的`require`+`replace`改名，`backend/internal/service/sync.go`导入改为`linapro-moka-recruit/moka`
- [x] 2.2 `linapro-recruit-pipeline`：`go.mod`的`require`+`replace`改名，`backend/plugin.go`、`backend/job/{candidate_poll,interview_sync,report_sync}{,_test}.go`导入改为`linapro-moka-recruit/moka`；`plugin.yaml`描述改为"依赖共享库 linapro-moka-recruit"
- [x] 2.3 （用户执行）从`apps/lina-core/manifest/config/`的`plugin.autoEnable`删除`linapro-moka-recruit`条目

## 3. 验证

- [x] 3.1 三个模块`GOWORK=off go build ./... && go vet ./...`通过（report-sync 因既有 go.sum 缺项需`-mod=mod`，验证后 go.sum 已还原）
- [x] 3.2 `GOWORK=off go test ./... -count=1`：moka-recruit、recruit-pipeline、report-sync 全部通过
- [x] 3.3 `make lint dir=... plugins=0`：moka-recruit、recruit-pipeline、report-sync 均 0 issues
- [x] 3.4 `make plugins.check`findings 8→3，剩余 3 条为 empcap 依赖未声明（不在本变更范围）
- [x] 3.5 `make i18n.check`：总命中 955 不变，本库 54 条与迁移前逐条一致（仅路径变化），无新增
- [x] 3.6 `openspec validate linapro-moka-recruit-shared-lib --strict`通过
- [x] 3.7 调用`lina-review`完成代码与规范审查（2026-10-29：0 严重 / 1 警告；警告为`moka/`下 9 个 Go 文件缺文件用途注释，迁移前既有、非本变更引入；审查中修正了 7 处裸写`go.mod`的 Markdown 格式；`make lint dir=apps/lina-plugins/linapro-moka-recruit plugins=1`重新生成`temp/official-plugins/plugins.go`，其中`moka-recruit`引用为 0，佐证「不进入插件聚合构建」场景）
