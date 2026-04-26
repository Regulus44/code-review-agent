# 2026-04-26 修复日志：DeepSeek thinking 模式 400（reasoning_content 必须回传）

## 问题现象
- 运行失败报错：
  - `The reasoning_content in the thinking mode must be passed back to the API.`
- 运行诊断显示仅 1 次模型调用后失败，说明在下一次请求拼接消息时缺字段。

---

## 步骤 1：根因定位

### 调试/测试记录
- 运行命令：
  - `Get-Content -Raw src/code_review_agent/messages/message.py`
  - `Get-Content -Raw src/code_review_agent/formatters/openai_tools.py`
  - `Get-Content -Raw tests/test_openai_formatter.py`
  - `Get-Content -Raw tests/test_openai_compat_model.py`
- 观察结果：
  - 内部 `Message` 模型没有 `reasoning_content` 字段。
  - formatter 解析 assistant 响应时也未提取该字段，下一轮自然无法带回。
- 问题判断：
  - 这是“消息模型与格式化器链路缺失”，不是 API key 或 prompt 问题。

---

## 步骤 2：代码修复（reasoning_content 全链路）

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/messages/message.py`
  - `src/code_review_agent/formatters/openai_tools.py`
  - `tests/test_openai_formatter.py`
  - `tests/test_openai_compat_model.py`
- 具体改动：
  - `Message` 增加 `reasoning_content: str | None`
  - `assistant_message()` 支持传入 `reasoning_content`
  - formatter：
    - 解析响应时读取 `payload["reasoning_content"]`
    - 格式化请求时回传 `message.reasoning_content`
  - 新增测试覆盖：
    - formatter 的 parse/format roundtrip
    - model adapter 在第二轮请求中确实带回 `reasoning_content`
- 为什么这样改：
  - DeepSeek thinking 模式要求前一轮 `reasoning_content` 原样回传。
- 这次修改想解决的问题：
  - 消除 `invalid_request_error`（reasoning_content 缺失）。

---

## 步骤 3：调试过程中的方案调整（循环导入）

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_openai_formatter.py tests/test_openai_compat_model.py tests/test_repo_analyst.py -q`
- 观察结果：
  - 出现循环导入错误：`formatters.openai_tools <-> models.__init__`
- 问题判断：
  - `models/__init__.py` 在包加载时 eager import provider 实现，导致与 formatter 互相拉起。

### 方案调整记录
- 原方案：
  - 只改 `reasoning_content` 字段，不动包初始化逻辑。
- 调整原因：
  - 现有导入图在测试收集阶段触发循环，必须先消除。
- 新方案：
  - 将 `models/__init__.py` 改为惰性导出（`__getattr__` lazy import）。
  - `openai_compat.py` 改为模块级直接导入 formatter 子模块，避免包级拉起。
- 差异与影响：
  - 保持对外导入 API 不变（`from code_review_agent.models import DeepSeekModel` 仍可用）。
  - 去掉循环导入隐患。

### 代码修改记录（循环导入修复）
- 修改文件：
  - `src/code_review_agent/models/openai_compat.py`
  - `src/code_review_agent/models/__init__.py`
- 具体改动：
  - `openai_compat.py` 使用：
    - `from code_review_agent.formatters.base import MessageFormatter`
    - `from code_review_agent.formatters.openai_tools import OpenAIChatFormatter`
  - `models/__init__.py` 改为 lazy `__getattr__` 方式导出 `DeepSeekModel/OpenAICompatibleModel`

---

## 步骤 4：验证

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_openai_formatter.py tests/test_openai_compat_model.py tests/test_repo_analyst.py -q`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest -q`
- 观察结果：
  - 子集：`21 passed`
  - 全量：`77 passed`
- 判断：
  - 修复生效且未破坏现有功能。

---

## 步骤 5：启动可验证实例

### 调试/测试记录
- 运行命令：
  - 启动 `--port 8005`
  - `Invoke-RestMethod http://127.0.0.1:8005/health`
  - `Invoke-RestMethod http://127.0.0.1:8005/debug/runtime-config`
- 观察结果：
  - `health` 正常
  - debug 返回：
    - `default_model=deepseek-v4-pro`
    - `cwd=D:\Develop\code-review-agent`
- 判断：
  - 当前 8005 是最新代码 + 正确配置实例，可用于直接回归验证。

---

## 阶段总结
- 最终完成了哪些改动：
  - reasoning_content 全链路支持（模型响应解析、会话保存、下一轮请求回传）
  - 循环导入修复（models lazy export）
  - 新增与更新测试，并全量通过
  - 启动新实例端口 8005 供验证
- 还有哪些遗留问题：
  - 8000 端口仍可能是旧实例，需单独进程治理
- 后续建议先做什么：
  1. 用 8005 重新跑一次 repo analyst，确认不再报 reasoning_content 缺失
  2. 跑通后再统一收敛服务进程，只保留一个固定端口实例
