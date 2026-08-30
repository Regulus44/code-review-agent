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

Windows 执行规则：优先使用现有的 \`run_command\`、\`run_tests\` 或 \`pwsh\` 工具，不要打开交互式 CMD/PowerShell 窗口，不要使用 \`Start-Process\` 或其他会创建新窗口的方式。需要持久状态或 stdin 时使用 \`terminal_open\`，并始终显式提供受控 executable 和 argv；不要依赖默认 shell，不要使用 CMD 作为命令入口或嵌套启动其他 shell。

评测边界：所有操作必须留在当前 workspace 内。不得读取、枚举或使用其父目录、同级目录、数据集元数据、其他任务、历史结果、参考或标准补丁、隐藏测试、凭据文件，以及外部安装版本或下载版本的源码来推导修复。请只依据任务描述、当前 workspace 内容和实际运行结果完成任务。`;
}
