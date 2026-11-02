# 业务数据引用内部 EmpID，而非飞书 open_id

考勤、问卷等业务表引用 employee-core 分配的内部 `EmpID`（整数代理主键），而不是飞书 `open_id`。飞书 `open_id`（及将来钉钉的 user_id）只作为员工表上的列存在，仅用于登录/入库时解析出 EmpID。

**为什么**：`open_id` 是身份提供方专属且 per-app 的（双租户两个飞书 App，同一人 open_id 不同）。若业务表直接存 open_id，切换到钉钉时每张业务表的历史数据都要重写、身份会断裂。引用 EmpID 则把提供方切换的冲击收敛到员工表加一列（additive），业务表与历史一行不动。

**代价**：飞书推来的事件只带 open_id，入库需在边界翻译 `open_id→EmpID`（可缓存/批量）。未知 open_id 由 core 懒创建 shell 员工记录，同步端后续按 open_id 补全。此代价可接受，且因认证的 status 校验本就要求员工表存在，业务表引用其主键是顺理成章的。
