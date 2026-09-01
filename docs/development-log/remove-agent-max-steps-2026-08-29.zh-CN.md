# 取消 AgentHost 的 max_steps 终止限制

日期：2026-08-29

## 背景

本地 Web API 服务曾在 `AgentHost` 中使用 `maxSteps` 控制 model → tool → model 循环。默认值为 32，历史实现还保留了 512 的校验上限。旧服务实例曾以 12 步配置运行，导致尚未完成的 Coding Agent turn 被提前终止。

当前简化评测要求与 Web 端真实交互一致，不应由评测或 AgentHost 预先规定一个 Agent 可感知的步骤预算。因此需要取消基于 `maxSteps` 的 turn 终止逻辑。

## 修改范围

- `packages/runtime/src/index.ts`
  - 移除 `AgentHost` 内部保存和校验 `maxSteps` 的逻辑；
  - 将 `runSteps()` 的有限 `for` 循环改为持续循环；
  - 保留取消信号、权限等待、provider 错误、上下文恢复失败等原有终止路径；
  - 保留 `AgentHostOptions.maxSteps` 作为兼容字段，但标记为 deprecated 且不再参与执行控制。
- `packages/runtime/src/index.test.ts`
  - 更新 legacy `maxSteps` 配置测试；
  - 增加 `maxSteps=1` 仍可完成两步 tool loop 的回归测试。
- `apps/api/src/server.test.ts`
  - 验证 API 继续接受历史调用方传入的 `maxSteps`，但不再拒绝旧范围外数值。

## 验证记录

```text
pnpm build
通过

pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts
1 file passed, 66 tests passed

pnpm --filter @coding-agent/api test -- --run src/server.test.ts
1 file passed, 40 tests passed
```

## 运行注意

已经启动的 `3210` API 进程仍使用启动时加载的旧构建代码。要让修改对 Web 使用和评测生效，需要停止并重新启动该服务；不需要重新引入旧 Runner 或 Grader。

## 结果边界

取消 `maxSteps` 只表示不再按步骤计数强制结束 turn。Agent 仍会在以下情况结束：模型产生最终文本、用户/系统取消、权限或交互流程终止、provider/工具/上下文发生不可恢复错误，或宿主进程被外部停止。
