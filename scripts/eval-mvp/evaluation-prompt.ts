export interface EvaluationPromptInput {
  readonly problemStatement: string;
  readonly workspaceRoot: string;
}

/**
 * Stable prompt contract for simple benchmark runs.
 * Only the task statement and active workspace path are variable.
 */
export function buildEvaluationPrompt(input: EvaluationPromptInput): string {
  return `请修复当前 workspace 中的问题：

${input.problemStatement}

当前 workspace：${input.workspaceRoot}

你在当前 workspace 内拥有完整权限，可以读取、修改、运行命令、安装依赖和执行测试。请直接完成修复，必要时自行诊断并验证，完成后说明修改内容和验证结果。

Windows 执行规则：优先使用现有的 \`run_command\`、\`run_tests\` 或 \`pwsh\` 工具，不要打开交互式 CMD/PowerShell 窗口，不要使用 \`Start-Process\` 或其他会创建新窗口的方式。如果确实需要 CMD 语法，只能通过 \`run_command\` 以非交互参数调用：\`cmd.exe /d /s /c "<command>"\`，并将工作目录保持在当前 workspace；不得省略 \`/d /s /c\`，不得再嵌套启动其他 shell。

评测边界：所有操作必须留在当前 workspace 内。不得读取、枚举或使用其父目录、同级目录、数据集元数据、其他任务、历史结果、参考或标准补丁、隐藏测试、凭据文件，以及外部安装版本或下载版本的源码来推导修复。请只依据任务描述、当前 workspace 内容和实际运行结果完成任务。`;
}
