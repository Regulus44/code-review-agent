# 上下文窗口能力调整开发日志（2026-08-28）

## 变更范围

本次仅调整模型上下文能力声明，不改变压缩算法、事件协议或普通未知模型的回退策略。

## 实现

- 内置 DeepSeek 模型的 `maxInputTokens` 从 128K 调整为 1M。
- `packages/llm/src/catalog.ts` 增加 Yayi 自定义模型的 Host 推导：模型或 Provider 标识命中 DeepSeek/`ds` 时为 1M，其余 Yayi 模型为 200K。
- 推导能力标记为 `source: "estimate"`，因为窗口值来自 Host 配置规则而非网关精确探测。
- 推导同时用于模型目录展示和实际 `ChatModel` 创建，避免 API 显示值与 Runtime 预算不一致。
- 普通未识别的自定义 Provider 继续使用原有 16K fallback。

## 验证

- `pnpm typecheck` 通过。
- `pnpm --filter @coding-agent/llm test -- --run`：5 个测试文件、27 个测试通过。
- 3210 服务 `/v1/models` 已验证：内置 DeepSeek 与 Yayi DS 为 `1000000`，Yayi GL/QW 为 `200000`。

## 回滚

回滚本次代码和文档 checkpoint 即可恢复原有 128K 内置 DeepSeek声明及未推导的 Yayi 模型能力；普通未知 Provider 的 16K fallback 不受影响。
