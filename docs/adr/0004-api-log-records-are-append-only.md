# 接口请求日志只增不删，且不提供任何删除路径

`linapro-monitor-apilog` 的记录表**永久保存**：不设保留期、不注册清理任务、service 层不暴露 `Delete`、卸载 SQL 不写 `DROP TABLE`。

**为什么**：这张表记的是员工的**历史提交**（360 评估作答、将来的考勤），删除即永久失去证据链。管理员的操作日志（operlog）丢了可以重新操作一遍补回来，员工的历史提交不能。

**为什么不做数据库级保护**：应用用 `postgres` 超级用户连库（三份配置的 `link:` 均为 `pgsql:postgres:postgres@...`），`REVOKE DELETE` 无效；表级 `BEFORE DELETE` 触发器防不了 `DISABLE TRIGGER` / `DROP TABLE`，且 `TRUNCATE` 不触发行级触发器。因此「不可删」只能靠**让删除路径不存在**，真正的兜底是定期 `pg_dump`。这挡得住插件代码与审查，挡不住有人直接连库。

**本 ADR 不限制分区**。记录表按 `created_at` 做月度范围分区，用途是查询剪枝与控制单表体积，与「能否删除」是正交的两件事。要守的纪律只有一条：只用分区剪枝，**不得用 `DROP PARTITION` / detached 做批量删除**；分区任务只能创建新分区，不能删除或迁移已有分区。冷归档同理：允许复制到低速存储，不允许从原表移走。

**后果**：

- 表无界增长，只增不减，可用手段是「减少写入」（`exclude_route_owners` / `exclude_paths`）、加分区改善查询、以及扩容。
- 卸载后重装时 `CREATE TABLE IF NOT EXISTS` 会跳过建表；只要安装 SQL 对每列都写了 `ADD COLUMN IF NOT EXISTS`，**加列**就能收敛。需要注意的只有**改列**（类型、NOT NULL、默认值）与**改索引/约束**——这些必须显式写 `ALTER`，因为建表语句在旧表上不生效。
- 若将来要支持「按保留期清理」，那是一次需要产品决策的变更，不是补一个 cron 任务。
