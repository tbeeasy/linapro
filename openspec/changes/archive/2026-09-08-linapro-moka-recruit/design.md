## Context

`lina-plugin-linapro-moka-hcm` 已覆盖 Moka HCM 模块（路径前缀 `/api-platform/hcm/`），实现了 HCMAuth、OAuth2Auth、Client 和 GetReportData。招聘系统 API 路径前缀为 `/api-platform/v1/`、`/api-platform/v2/`、`/api-platform/v3/`，业务接口（简历获取、阶段推进、面试状态查询）将由后续业务插件调用，需要一个专属的客户端库作为依赖。

## Goals / Non-Goals

**Goals:**
- 新建独立 Go 模块 `lina-plugin-linapro-moka-recruit`，提供招聘系统 API 客户端
- 在模块内自包含实现 `BasicAuth` 和 `OAuth2Auth`（招聘系统 OpenAPI 支持的两种鉴权模式），不重复跨模块引用鉴权逻辑
- 初始只暴露 `GetReportData`，后续接口陆续扩充
- 模块加入根 `go.work`，可被同工作区的业务插件直接 `require`

**Non-Goals:**
- 不实现任何业务流水线（webhook 监听、简历分析、面试回写等）——这些属于后续业务插件
- 不修改 `linapro-moka-hcm` 现有代码
- 不实现飞书 Bitable 写入（属于业务层）

## Decisions

**1. 独立模块，而不是在 linapro-moka-hcm 内新增包**

HCM 和招聘是两套独立的 API 域，路径前缀和业务语义完全不同。拆为独立模块可以让后续业务插件只依赖需要的客户端，避免将 HCM 和招聘耦合在同一个库里，也与已有的 `linapro-moka-report-sync` 拆库思路一致。

**2. 鉴权在模块内自包含实现，而不是跨模块 import**

`lina-plugin-linapro-moka-recruit` 在 `backend/moka/` 内独立实现 `Author`、`BasicAuth`、`OAuth2Auth`，不引入跨模块依赖。这样模块可在工作区根和模块目录内单独 `go test`，且 recruit 的鉴权迭代不受 hcm 版本变动影响。

> 注：招聘系统 OpenAPI 官方仅支持 Basic Auth 和 OAuth2 两种鉴权模式。早期脚手架曾误从 `linapro-moka-hcm` 复制了 HCM 报表侧的 `HCMAuth`（Basic + MD5withRSA 签名），已移除——该签名方式不属于招聘系统。当前仅需 `BasicAuth`，但保留 `OAuth2Auth` 以备后续切换，两者均实现 `Auther`，切换时业务接口代码无需改动。

**3. Client 结构与 linapro-moka-hcm 保持镜像**

字段、构造函数签名与 JSON 传输方法与 `linapro-moka-hcm` 的 `Client` 对齐。唯一差异是 `DefaultBaseURL` 相同（`https://api.mokahr.com`），但调用的路径前缀不同。保持对齐降低后续维护者的认知负担，也方便两个客户端共享测试辅助代码。招聘侧业务方法（如 `GetReportData`、`EhrApplications`、`GetInterviewInformation`）均挂载为 `*Client` 方法，与 hcm 客户端 `GetReportData` 的方法式签名一致。

**4. GetReportData 路径使用招聘域路径**

HCM 的报表接口是 `/api-platform/hcm/oapi/v1/report/getReportData`，招聘系统的对应接口是 `/api-platform/v1/getReportData`。两者返回结构相同（`ReportHeader`、`ReportData`），可以直接复用 `linapro-moka-hcm` 的响应类型，或在本模块内重新声明（推荐重新声明，保持模块自包含，避免跨模块引用数据结构）。

**5. 目录布局**

```
apps/lina-plugins/linapro-moka-recruit/
├── go.mod                  # module lina-plugin-linapro-moka-recruit
├── go.sum
├── plugin.yaml
├── plugin_embed.go
├── backend/
│   ├── plugin.go
│   └── moka/
│       ├── client.go       # Client, NewClient, PostJSON, PutQuery, GetJSON, DefaultBaseURL
│       ├── report.go       # GetReportData, ReportData, ReportHeader
│       ├── resume.go       # GetResumeContent, ResumeContent
│       ├── application.go  # EhrApplications, MoveApplicationStage, GetInterviewInformation
│       └── stage.go        # GetStagesList, Stage
└── manifest/
    └── i18n/
        ├── en-US/plugin.json
        └── zh-CN/plugin.json
```

`frontend/` 目录本变更不需要，可省略或留 `.gitkeep`，与 `linapro-moka-hcm` 保持一致。

## Risks / Trade-offs

- **go.work replace 依赖**：测试时必须在工作区根执行 `go test`，在模块目录内单独 `go test` 会因找不到 replace 目标而失败。与 `linapro-moka-report-sync` 的现状相同，不引入新风险。

- **响应类型重复声明**：`ReportHeader`、`ReportData` 与 `linapro-moka-hcm` 的同名类型结构相同但不同包。如果 Moka 变更了报表响应结构，两处都需要更新。当前招聘报表接口仅在需求 3 中使用，并发维护的风险可接受；若将来两模块都频繁使用报表接口，可考虑提取公共类型包。

- **招聘 API 版本混用**：路径中同时出现 v1、v2、v3，但 `Client.PostJSON` 的 `path` 参数由调用方传入，客户端本身无需感知版本。这不是风险，但需在 README 中说明路径约定。
