# Phase 7：DSH Web 前端收敛

## 目标

在后端事件、工具、权限和 Subagent 能力稳定后，把 `apps/web` 收敛到接近 DSH 的完整 Coding Agent 工作台。重点是复用成熟信息架构，不重新设计交互范式。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/apps/web`
- `D:/Develop/deepseek-harness-fork/packages/client/web`
- `D:/Develop/deepseek-harness-fork/packages/client/web-react`
- `D:/Develop/deepseek-harness-fork/packages/client/connection`
- `D:/Develop/deepseek-harness-fork/packages/client/runtime`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-conversation`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-tool`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-sidebar`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-workspace`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-settings`

Claude Code：

- `D:/Develop/claude-code/packages/remote-control-server`
- `D:/Develop/claude-code/src/components`
- `D:/Develop/claude-code/src/state`

## 交付物

- AppRoot/boot status；
- Session sidebar、workspace picker、model/provider settings；
- Conversation、reasoning、assistant、tool call 和 trajectory row；
- Diff card、permission request、terminal/output panel；
- Plan/Todo、Subagent activity、MCP status；
- 本项目品牌、图标、颜色、文案和 API client；
- 浏览器 e2e 和视觉回归 fixture。

## 工作流任务

### 组件移植

1. 先建立 DSH Shell 的布局和 slot 区域；
2. 按本项目事件 projection 接入 Conversation、Tool、Diff 和 Permission；
3. 将 DSH 内部 API 替换为 `packages/contracts` 和本项目 API client；
4. 保留 DSH 的交互顺序、快捷操作和状态分区。

### 依赖收敛

1. 不把整个 DSH client workspace 作为运行时依赖；
2. 逐个记录复制/改编的文件和 MIT notice；
3. 移除 Cordis、DSH 专有 provider 和无关桌面/CLI 代码；
4. 避免 UI 直接构造事件或绕过 API。

### 品牌与可访问性

1. 更换名称、icon、logo、颜色和文案；
2. 保证键盘操作、焦点、窄屏和错误状态可用；
3. 不复制 DSH 的品牌标识或产品文案；
4. 统一 loading、empty、permission、failed 和 reconnect 状态。

## 不包含

- 重做产品交互范式；
- 桌面端；
- 未经后端支持的前端假功能；
- 将 Web 状态作为 Session 事实来源。

## 测试与验收

- 浏览器完成 Read-only、Edit、Test、Delegation 四个核心场景；
- SSE 断线/重连不丢消息、工具结果或权限请求；
- Diff、Terminal、Permission、Subagent 和 MCP 状态正确回放；
- 主要页面在 Chromium 和窄屏 viewport 下通过 smoke；
- 视觉快照只锁定本项目品牌和关键交互，不锁定无关像素细节。

退出条件：Web UI 能完整呈现后端所有稳定能力，并且页面结构、交互顺序和信息分区基本保持 DSH 风格。

## 回滚点

前端以独立构建产物发布；保留最小 Shell 作为 fallback，组件移植失败不会影响 API 和 Runtime。
