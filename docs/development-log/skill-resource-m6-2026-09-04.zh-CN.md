# Skill 资源渐进式加载 M6 开发日志

日期：2026-09-04  
范围：Permission、workspace、symlink、大小和 tenant 隔离

## 目标

把 Skill 资源包读取固定在 provider 自己的资源根内，阻止路径穿越、symlink escape、special file、TOCTOU、超限窗口和跨 tenant 访问形成旁路。Skill 资源保持只读文本能力；M6 不执行 `scripts/`，不引入远程 provider。

## 实现切片

1. `@coding-agent/skills-filesystem` 对每次资源读取执行 Skill-relative lexical path、最大路径字节数、offset/limit、单文件 bytes 和返回行数检查。资源目标先经过 `lstat`、`realpath` 和 regular-file gate；默认拒绝 symlink，显式 `allowResourceSymlinks` 时只允许 canonical target 仍位于 Skill 目录内。POSIX 使用 `O_NOFOLLOW`，打开后复核 file identity、realpath 和 containment，避免最终路径替换导致越界读取。
2. `@coding-agent/contracts`、`@coding-agent/skills`、filesystem/MCP provider 和 `ToolContext` 增加可选 host-derived `tenantId`。registry 只向同 tenant 暴露 tenant-owned provider；未声明 tenant 的本地 provider 保持 legacy host-local 行为。`SkillTool` 与 `read_skill_resource` 均把 Session ownership 传入 lookup，调用方不能在工具参数中注入 tenant 或 host path。
3. `read_skill_resource` 保持 `read`/`auto`，Skill `allowedTools`、未知属性和 source trust 只允许收缩能力或触发已有交互，不升级为通用文件读取、shell 或脚本执行。`workspace-full-access` 与 `danger-full-access` 仍不能跳过 Skill root containment。

## 契约与安全边界

- provider 错误只跨越 registry/tool 边界为稳定 code；绝对路径、底层异常、Skill 目录和其它 tenant 内容不进入 ToolResult、EventStore、SSE 或公共 catalog。
- `scripts/`、`references/`、`assets/` 均按普通 UTF-8 文本处理；M6 没有执行入口、shell 拼接或隐式目录枚举。
- `skillResourceArtifactReplay` 的 receipt ACL 继续由 host-owned artifact store 负责；M6 的 tenant scope 在 provider lookup 和 ToolContext 两侧复核，不能依赖模型提供的参数。

## 提交与验证

- `ada42c9 feat(skills): scope resource providers by tenant`
- `ae83e20 fix(skills): harden filesystem resource reads`
- `2a5480d test(skills): cover resource permission and tenant scope`
- `d93d719 fix(skills): propagate tenant scope to SkillTool`

定向验证：`pnpm --filter @coding-agent/skills-filesystem test`（17 tests）、`pnpm --filter @coding-agent/tools test`（111 tests）通过；`pnpm --filter @coding-agent/tools test -- --run src/skill.test.ts`（4 tests）通过；`pnpm typecheck` 通过。全量 `pnpm test` 已启动并由主代理收尾，提交前使用 `git diff --check`。

## 剩余风险

- filesystem provider 仍是本地 best-effort adapter；生产 host 需要提供跨进程 immutable artifact store、真实 workspace allowlist 和资源级 ACL。
- Windows 的 `fs.open` 不提供 POSIX `O_NOFOLLOW`，实现依赖打开后 identity/realpath 复核；宿主仍应在受限 workspace 中运行并持续补充平台回归测试。
- remote/MCP resource 的 URI allowlist、租户认证和脚本执行策略属于后续阶段，不能通过本地 provider 开关隐式启用。
