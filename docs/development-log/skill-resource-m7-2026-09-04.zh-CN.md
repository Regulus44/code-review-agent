# Skill 资源渐进式加载 M7 开发日志

日期：2026-09-04  
范围：真实多 step、资源窗口、回放投影与产品验收 fixture

## 目标

证明模型在看到 `SKILL.md` 后会按需继续调用 `read_skill_resource`，并验证资源变化、事件回放和 API/SSE 投影遵守 M0–M6 的契约与安全边界。

## 实现切片

1. `apps/api/src/skill-resource.e2e.test.ts` 使用临时 `.claude/skills/review` 目录，执行真实 `SkillTool` → `read_skill_resource` 链路；覆盖 `references/checklist.md`、`scripts/check.ts` 的 bounded offset/limit、未引用资源不预加载，以及 API JSON/SSE 只读投影不包含正文和绝对 provider 路径。
2. `packages/runtime/src/skill-resource.e2e.test.ts` 使用四步模型 fixture，断言 Skill renderer 的资源提示在下一模型步骤可见，reference 正文和 script window 只在显式 tool call 后注入，最终 assistant message 完成且 durable events 不含正文。
3. `packages/skills-filesystem/src/index.test.ts` 增加资源文件变更验收：下一次读取获得最新字节，旧的 `SkillResourceReadOutcome` 保持不可变；既有 watcher、路径 containment、symlink、tenant 与预算测试继续作为 M7 安全矩阵。

## 契约与验收

- 资源读取仍通过 registry winner、provider root、realpath/symlink、UTF-8、bytes/offset/line、permission、workspace/tenant 和取消检查。
- `tool/result`、SSE 和 API event JSON 只展示 Skill 名称、相对路径、size/digest、窗口和 artifact receipt；正文仅作为当前模型步骤的 transient view 或 host-owned artifact replay。
- watcher 只负责 `SKILL.md`/Skill 目录 catalog invalidation；`references/`、`scripts/`、`assets/` 变化由下一次资源读取观察，不重写旧 catalog/result。

## 提交与验证

- `27340fc test(skills): add M7 resource loading acceptance`
- `bcee075 test(api): verify Skill resource projection redaction`
- `4be2944 test(runtime): cover multi-step Skill resource loop`

定向验证：

- `pnpm --filter @coding-agent/api test -- --run src/skill-resource.e2e.test.ts`
- `pnpm --filter @coding-agent/skills-filesystem test -- --run src/index.test.ts`
- `pnpm --filter @coding-agent/runtime test -- --run src/skill-resource.e2e.test.ts`

以上 fixture 与既有测试通过。M7 完成后由主代理继续执行全量 `pnpm typecheck`、`pnpm test` 和 `git diff --check`。

## 剩余风险

- 本阶段使用 deterministic model/provider fixture，真实第三方模型浏览器 e2e 仍受 provider 凭据、网络和 UI runner 环境影响；fixture 仅验证本仓库事件与 tool-call 顺序。
- API Tool POST 的即时响应允许当前调用者看到 bounded 正文；持久化事件与 SSE 仍严格脱敏。若产品要求 API 即时响应也不含正文，应另设受 ACL 保护的 resource artifact endpoint。
- watcher、artifact store 和 tenant ACL 的生产级跨进程部署约束沿用 M5/M6 剩余风险。
