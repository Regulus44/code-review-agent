# ADR：Coding Agent 名称与运行配置迁移

状态：`accepted`

日期：2026-09-01

实施切片：`product-identity-migration`

## 背景

仓库、私有 workspace package、Docker 资源、默认数据库文件和部分运行时标识仍使用
`code-review-agent`。当前产品已经支持完整 Coding Agent 工作流，代码审查是其中一个
重要场景，旧名称会误导使用者、部署配置和外部 MCP 连接。

该切片解决产品标识、运行配置和部署命名问题。它不改变 Event、Tool、Task、Permission、
Workspace contract、SQLite schema、工具权限或上游代码来源。

## 决策

1. 当前产品显示名统一为 `Coding Agent`，机器可读 slug 统一为 `coding-agent`。
2. 根 package 和所有私有 workspace package 从 `@code-review-agent/*` 迁移到
   `@coding-agent/*`；仓库内所有 import、pnpm filter 和 lockfile 同步更新。
3. API `/health` 的 `service` 值与 MCP 默认 client name 改为 `coding-agent`；Docker
   service/image 改为 `coding-agent`。
4. 新运行配置使用 `CODING_AGENT_*` 前缀。旧 `CODE_REVIEW_AGENT_DB_PATH`、
   `CODE_REVIEW_AGENT_PWSH`、`CODE_REVIEW_AGENT_PORT` 和
   `CODE_REVIEW_WORKSPACE_HOST_ROOT` 只作为迁移期 fallback；同名新旧变量同时存在时，
   新变量优先。
5. 默认数据库文件改为 `coding-agent.sqlite`。未显式配置路径时，如果同一 data directory
   中只有旧 `code-review-agent.sqlite`，运行时继续打开旧文件。迁移不自动复制、重命名或
   删除 SQLite 文件。Docker 本切片保留旧命名 volume，以免 `docker compose up` 断开已有
   数据。

## 影响与迁移

- workspace package 均为 `private`，没有已发布的 npm package 需要保留 alias；同一源码
  checkout 的消费者必须把 import 更新到 `@coding-agent/*`。
- 监控、探针或集成若断言 `/health.service`，需改为 `coding-agent`。
- 若部署显式配置 JWT audience，维护者需与 identity provider 一起将
  `code-review-agent` 改为 `coding-agent`；服务端没有隐式 audience 默认值，不接受未经
  配置的额外 audience。
- 远程 GitHub 仓库重命名需要具有仓库管理权限的维护者完成。GitHub 改名后，clone 使用者
  应把 `origin` 更新为 `https://github.com/Regulus44/coding-agent.git`。

## 验收

- 全 workspace `pnpm typecheck` 与 `pnpm test` 通过；
- Storage 覆盖新旧数据库路径选择，Tools 覆盖新旧 PowerShell 环境变量的优先级；
- Docker 配置审计继续验证受限 workspace bind 和容器安全选项；
- 文档引用与配置表只将 `Coding Agent` / `coding-agent` 作为当前名称。

## 回滚

回退本切片的独立 Git checkpoint 即可恢复旧 package scope、运行标识和配置前缀。该切片
不会移动 SQLite 文件或 Docker volume，因此回滚不会破坏已有事件数据。远程仓库若已在
GitHub 改名，应通过 GitHub 的 rename history/redirect 或人工改回旧 slug 处理。

## 来源与许可证

本决定不复制或改编上游代码，不需要新增上游复用登记。
