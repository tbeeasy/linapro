# LinaPro 员工身份与内部工具

本上下文覆盖「飞书内员工」这一认证主体，及其在考勤、问卷等内部工具中的复用。它区别于后台管理员（`sys_user`）与招聘候选人（Moka Candidate）。

## Language

**员工 (Employee)**:
身份来自飞书 OAuth 的在职人员，是「一个人在某个租户内」的身份——其部门、考勤、问卷作答都是租户内的事。同一自然人在两个租户下是两条独立员工记录。区别于用账号密码登录后台的管理员。
_Avoid_: 用户、user、账号、sys_user、人（Person，指自然人时另说）

**EmpID**:
员工的内部代理主键，与身份提供方（飞书/钉钉）无关。业务数据（考勤、问卷作答）一律引用 EmpID；飞书 open_id 等外部标识只作为员工表上的列，不进业务表。切换身份提供方时 EmpID 与业务数据不变。
_Avoid_: open_id（那是外部标识，非内部身份）、user_id（易与 sys_user 混）

**管理员 (sys_user)**:
用账号密码登录后台控制台的运营/管理人员，走宿主 `Auth()/Permission()` 认证链。与员工是两条平行认证链。
_Avoid_: 员工、用户

**候选人 (Candidate)**:
Moka 招聘流水线里的外部人（有简历、无系统登录、无 `employee` 行）。在身份层与员工毫无共享，永不进入 employee-core。录用入职后如何与员工衔接尚未定义。
_Avoid_: 员工、applicant（除非特指 Moka 的 applicationId）

**Lark OAuth (员工登录)**:
员工通过 Lark（飞书）免登获取身份的方式（code→open_id），employee-core 的登录来源，代码中作为 core 内 `lark` 包、藏在 provider 接口后。属简单、请求级的登录关注点，与「Lark 通讯录同步 + WS 员工事件」（重、填员工表、与考勤共用 WS，独立关注点）及「Lark 多维表格 OpenAPI（应用级 token，Moka 用）」是不同集成，不可混用。代码标识符统一用 `lark`。
_Avoid_: 飞书接入（太泛）、把同步/WS 归入 OAuth

**EmpAuth**:
员工端路由组的认证中间件：校验员工 JWT、每请求查 status（实时拦截离职）、注入 `EmpContext`。区别于宿主管理员认证链 `Auth()/Permission()`。
_Avoid_: 鉴权（太泛，且易与授权混）

**EmpContext**:
一次请求内携带的员工身份，仅含 `EmpID` 与 `TenantID`——纯身份，不含数据权限（能看什么由消费方各自判断）。
_Avoid_: 会话、session、principal
