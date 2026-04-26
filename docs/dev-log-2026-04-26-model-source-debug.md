# 2026-04-26 诊断日志：为什么一直显示 deepseek-v4-flash

## 结论概览
- 问题不是单点，而是两部分叠加：
  1. 旧的可观测事件字段把“返回模型”当成“请求模型”展示，容易误判；
  2. `8000` 端口当前仍是旧实例（不含新调试接口），你看到的是旧代码路径。

---

## 步骤 1：定位现象与根因

### 调试/测试记录
- 运行命令：
  - `Get-Content -Raw .env`
  - `Get-NetTCPConnection -LocalPort 8000 -State Listen`
  - `Get-CimInstance Win32_Process ...`
  - `Invoke-RestMethod http://127.0.0.1:8000/health`
  - `Invoke-RestMethod http://127.0.0.1:8000/debug/runtime-config`
- 观察结果：
  - `.env` 配置是 `DEFAULT_MODEL=deepseek-v4-pro`；
  - `8000/health` 可用；
  - `8000/debug/runtime-config` 返回 404（说明 8000 在跑旧版本）。
- 判断：
  - 你看到的 UI/事件来自旧实例，不是刚修改后的服务。

---

## 步骤 2：代码修复（事件字段可证伪）

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/harness/agent.py`
  - `src/code_review_agent/runtime/service.py`
  - `src/code_review_agent/api/routes.py`
  - `tests/test_api.py`
- 具体改动：
  - `model_response` step 的 metadata 新增：
    - `requested_model`（请求模型）
    - `returned_model`（返回模型）
  - 运行诊断最慢步骤标签优先使用 `returned_model`，避免误读。
  - 新增调试端点：
    - `GET /debug/runtime-config`
    - 返回非敏感信息：`default_model/deepseek_base_url/runtime_workspace_root/pid/cwd`
  - 增加 API 测试覆盖该端点。
- 为什么这样改：
  - 让“到底请求了什么模型”可直接观测，避免再靠推断。
- 解决问题：
  - 后续每次运行都能区分请求模型与返回模型。

---

## 步骤 3：验证结果

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_api.py tests/test_runtime.py tests/test_repo_analyst.py -q`
  - 启动新实例：`--port 8003`
  - `Invoke-RestMethod http://127.0.0.1:8003/debug/runtime-config`
- 观察结果：
  - 测试：`29 passed`
  - `8003/debug/runtime-config` 返回：
    - `default_model=deepseek-v4-pro`
    - `cwd=D:\Develop\code-review-agent`
- 判断：
  - 新版本服务确实按 `v4-pro` 配置加载。

---

## 阶段总结
- 已完成：
  - 增强模型可观测字段（requested/returned 分离）
  - 增加运行时配置调试接口
  - 测试通过并在新端口验证配置加载正确
- 遗留：
  - `8000` 端口仍被旧实例占用（需停止旧服务后再用新版本接管）
- 后续建议：
  - 停止旧 8000 实例后，重新启动本仓库服务到 8000，并先调 `/debug/runtime-config` 确认版本。
