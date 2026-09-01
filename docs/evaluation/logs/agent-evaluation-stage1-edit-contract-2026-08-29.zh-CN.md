# Coding Agent 评测阶段一：编辑工具契约实施日志

## 阶段范围

本阶段对应评测方案文档中的“阶段一：编辑工具的匹配、错误结果和版本语义”。本阶段只调整编辑工具契约及其合同测试，不实现阶段二的 Agent 连续失败状态机、强制重新读取或调度熔断。

参考入口：

- DSH：`D:\Develop\deepseek-harness-fork\packages\fs\tool-str-replace-editor\src\index.ts` 的 `DEFAULT_DESCRIPTION`、`viewPath()`、`replaceInFile()` 和 `str_replace_editor` 注册；
- DSH：`D:\Develop\deepseek-harness-fork\packages\fs\fs-local\src\fsio.ts` 的 `applyLiteralEdit()`；
- DSH 合同测试：`D:\Develop\deepseek-harness-fork\packages\fs\tool-str-replace-editor\tests\tools.spec.ts`。

## 实施文件

### `packages/tools/src/builtin.ts`

- 更新 `edit_file` 的模型可见描述，明确编辑前读取当前文件；出现找不到或不唯一时重新读取并使用新的唯一上下文，不原样重复调用；
- 编辑匹配统一在规范化换行内容上进行，支持 LF 编辑文本匹配 CRLF 文件；写回时恢复目标文件检测到的换行风格；
- 为 `TEXT_NOT_FOUND` / `TEXT_NOT_UNIQUE` / `EDIT_STALE` / `EDIT_CONFLICT` 的 diff presentation 增加当前文件 hash、总行数、匹配行号和局部上下文；
- 保留现有 `edit_file` 工具名、`oldText/newText`、`edits[]` 和 `expectedHash` 输入兼容性；
- 保留条件写入和 hash 冲突保护，未引入 DSH 运行时或文件系统依赖。

### `packages/tools/src/index.test.ts`

新增合同测试：

- 找不到替换目标时返回 `TEXT_NOT_FOUND`、当前 hash、总行数、上下文和空匹配行号，且文件不变；
- 多处匹配时返回 `TEXT_NOT_UNIQUE` 和全部匹配行号，且文件不变；
- LF `oldText/newText` 可匹配 CRLF 文件，并保持 CRLF 写回；
- 保留原有多段编辑和 `EDIT_STALE` 冲突测试。

## 验证记录

执行目录：`D:\Develop\coding-agent`

```text
pnpm --filter @coding-agent/tools test
```

结果：9 个测试文件、71 个测试全部通过。

```text
pnpm typecheck
```

结果：TypeScript workspace 编译通过。

## 阶段边界

本阶段没有修改：

- `packages/runtime/src/index.ts` 的 Agent 主循环；
- 连续编辑失败计数、恢复状态或熔断；
- SWE-bench Django grader 的仓库适配逻辑；
- DSH 或 Claude Code 的第三方源码和依赖。

下一阶段如需继续，应单独实施 `packages/runtime/src/edit-recovery.ts` 及其 Agent loop 集成，并建立独立 checkpoint。
