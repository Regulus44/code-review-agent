# 2026-04-25 修复日志：Repo Analyst JSON 失效（invalid_json）

## 背景
- 现象：运行完成后出现 `invalid_repo_analyst_report_json`。
- 诊断：原始模型输出包含 JSON，但某些字符串内出现未转义双引号，导致整体 JSON 非法。

---

## 步骤 1：确认环境与模型配置是否生效

### 调试/测试记录
- 执行命令：
  - `Get-Content -Raw .env`
  - `Get-Content -Raw src/code_review_agent/settings.py`
  - `Get-Content -Raw src/code_review_agent/models/deepseek.py`
  - `$env:PYTHONPATH='src'; conda run -n dl python -c "from code_review_agent.settings import get_settings; print(get_settings().default_model)"`
- 观察结果：
  - `.env` 当前为 `DEFAULT_MODEL=deepseek-v4-pro`。
  - settings 的读取键是 `DEFAULT_MODEL`。
  - Python 进程读取结果也是 `deepseek-v4-pro`。
- 判断问题原因：
  - 配置键本身没问题。
  - 你提到的“5.4pro”并未写入当前 `.env`；当前值是 `v4-pro`。

---

## 步骤 2：修改 Prompt，强化 JSON 语法约束

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/apps/repo_analyst/prompt.py`
- 具体改动：
  - 在 system prompt 新增约束：
    - 只输出一个 JSON 对象（`exactly one JSON object`）
    - 字符串值必须是合法 JSON 字符串
    - 字符串内部双引号必须转义为 `\\\"`
- 为什么这样改：
  - 当前失败属于“模型输出内容正确但语法不合法”。
  - 通过显式转义规则，可降低字符串中嵌套引号导致的 JSON 解析失败概率。
- 这次修改想解决的问题：
  - 降低 `invalid_repo_analyst_report_json` 的触发率。

### 调试/测试记录
- 执行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_repo_analyst.py -q`
- 观察结果：
  - `10 passed`。
- 判断问题原因：
  - prompt 变更未破坏 repo_analyst 现有解析和服务逻辑。
- 接下来准备怎么改：
  - 重启服务，确保新 prompt 与当前模型配置被后端进程加载。

---

## 步骤 3：重启后端服务（使新配置生效）

### 调试/测试记录
- 执行命令：
  - `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'uvicorn code_review_agent.api.app:create_app' } ...`
  - `Stop-Process` 终止旧 uvicorn 相关进程
  - `Start-Process -FilePath "D:\Anaconda\Scripts\conda.exe" -ArgumentList "run -n dl python -m uvicorn code_review_agent.api.app:create_app --factory --host 127.0.0.1 --port 8000" ...`
  - `Invoke-RestMethod http://127.0.0.1:8000/health`
- 观察结果：
  - 新服务启动后 `/health` 返回 `{"status":"ok"}`。
- 判断问题原因：
  - 旧进程缓存配置/代码的可能性已排除，新进程已加载当前仓库版本。
- 接下来准备怎么改：
  - 建议重新发起一轮 Repo Analyst 运行，优先观察是否仍出现 `invalid_json`。

---

## 方案调整记录
- 原方案：
  - 仅靠“后处理解析器容错”来吸收模型输出波动。
- 为什么调整：
  - 该问题是 JSON 语法层面错误，后处理不应无限修复非法输出。
- 新方案：
  - 在 prompt 端加语法硬约束 + 重启服务确保生效。
- 与原方案区别：
  - 把稳定性控制前移到生成阶段，而不是仅依赖解析阶段兜底。

---

## 阶段总结
- 最终完成了哪些改动：
  - 已修改 repo analyst prompt 的 JSON 严格输出约束。
  - 已重启 `dl` 环境下 uvicorn 服务并验证健康检查通过。
  - 已完成对应测试（repo_analyst 测试全通过）。
- 还有哪些遗留问题：
  - 模型输出仍可能偶发不稳定（LLM 天生概率性）；该改动是降风险，不是绝对消除。
- 后续建议先做什么：
  - 若仍偶发 `invalid_json`，下一步加一次“解析失败后自动纠错重试（单次）”。
