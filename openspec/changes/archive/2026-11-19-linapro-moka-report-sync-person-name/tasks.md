## 1. 配置扩展

- [x] 1.1 `internal/config/config.go`：`ReportMapping`新增`PersonFieldNameSources map[string]string`（json `personFieldNameSources`），新增导出常量`AlertConfigKey = "plugin.linapro-moka-report-sync.alert"`
- [x] 1.2 `internal/config/config_test.go`：`personFieldNameSources`反序列化用例
- [x] 1.3 `ReportMapping.PersonFieldSources`改名为`PersonFieldEmpNoSources`（json `personFieldEmpNoSources`），代码、测试、`CONFIGURATION.md`与增量规范同步；不保留旧键、不做旧键检测

## 2. 姓名解析

- [x] 2.1 新增`internal/service/sync_person.go`：收集姓名来源列中的姓名（去重、去首尾空白），判定每个姓名（在职 + 按工号/EmpID 去重 + 0/1/多），产出「姓名 → 工号」、重名姓名、未命中姓名
- [x] 2.2 `Runner`按映射调用一次`empcap.EmployeesByNamesAnyTenant`；能力未绑定或查询失败时记 warn、姓名来源列本轮跳过
- [x] 2.3 `preparePersonFields`迁入`sync_person.go`并扩展：工号来源优先，姓名来源经「姓名 → 工号」填回；两个来源都声明了同一字段时记 warn
- [x] 2.4 `syncMappingPivot`：`personFieldNameSources`非空时忽略并记 warn

## 3. 重名告警

- [x] 3.1 `MappingResult`新增`DuplicateNames`；`RunOnce`在周期末把所有映射的重名汇总为一条`larkalert`告警（种类`person_name_duplicate`），`larkalert.Env`由`Runner`持有的`capability.Services`派生

## 4. 测试

- [x] 4.1 新增`sync_person_test.go`：唯一在职匹配、跨租户同工号算一人、只命中离职员工、重名、无工号、姓名去首尾空白；`preparePersonFields`的姓名来源填回、来源冲突工号优先、未声明来源清空；告警正文按映射分组
- [x] 4.2 既有`TestPreparePersonFields`随函数从`sync_test.go`迁入`sync_person_test.go`并适配新签名

## 5. 文档与配置

- [x] 5.1 `CONFIGURATION.md`新增「人员字段」一节：两种来源、匹配口径、重名告警、告警配置键；pivot 约束补`personFieldNameSources`
- [x] 5.2 宿主配置模板登记`plugin.linapro-moka-report-sync.alert: *ops_alert`（位于`apps/lina-core/`，需用户授权后修改）

## 6. 验证

- [x] 6.1 `go test ./... -count=1`（linapro-moka-report-sync module）
- [x] 6.2 `make lint dir=apps/lina-plugins/linapro-moka-report-sync plugins=1`
- [x] 6.3 `openspec validate linapro-moka-report-sync-person-name --strict`
- [x] 6.4 影响记录：`i18n`无影响（插件未启用 i18n，只新增日志与告警正文）；缓存无新增（防抖复用 larkalert 既有 cachecap）；数据权限沿用平台级后台任务边界（见 design 风险一节）；无开发工具改动；DI 新增`larkalert.Env`，来源为 registrar 注入的同一`capability.Services`；E2E 不适用（后台定时任务，无用户界面变化），以单元测试覆盖
