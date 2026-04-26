# 2026-04-26 修复日志：DeepSeek 401（API Key 尾部引号）

## 问题现象
- 运行直接失败，错误：
  - `deepseek API returned HTTP 401`
  - `Authentication Fails, Your api key: ****a05\" is invalid`

该报错中的 `\"` 明确指向 key 字符串尾部多了一个双引号。

---

## 步骤 1：定位根因

### 调试/测试记录
- 运行命令：
  - `Get-Content -Raw src/code_review_agent/settings.py`
  - 查看 `.env` 与配置加载逻辑映射关系（`_load_dotenv` + `get_settings`）
- 观察结果：
  - `_load_dotenv` 之前是 `value.strip()` 直接入环境变量；
  - 如果 `.env` 写成 `DEEPSEEK_API_KEY="xxx"`，双引号会被当作真实内容保留。
- 问题判断：
  - 401 的直接原因是 key 读取时保留了包裹引号，导致请求头 key 非法。
- 下一步：
  - 在 settings 里加通用 value 归一化逻辑，自动去掉成对包裹引号。

---

## 步骤 2：代码修复（settings 解析）

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/settings.py`
- 具体改动：
  - 新增 `_normalize_env_value(raw_value: str) -> str`
    - 去掉首尾空白
    - 如果首尾是同一种引号（`"` 或 `'`），去掉包裹引号
  - `_load_dotenv()` 中改为：
    - `os.environ[key] = _normalize_env_value(value)`
- 为什么要这样改：
  - 允许 `.env` 写法兼容常见的 `KEY="value"` / `KEY='value'` 格式；
  - 避免再次出现尾部引号污染 API key。
- 这次修改想解决的问题：
  - 从根上消除 “.env 包裹引号导致 401”。

---

## 步骤 3：补充测试

### 代码修改记录
- 新增文件：
  - `tests/test_settings.py`
- 具体改动：
  - 新增 `test_dotenv_strips_wrapping_quotes`
    - 构造临时 `.env`：
      - `DEEPSEEK_API_KEY="quoted-key"`
      - `DEFAULT_MODEL='deepseek-v4-pro'`
    - 断言读取后：
      - key 为 `quoted-key`
      - model 为 `deepseek-v4-pro`
- 为什么要这样改：
  - 防止以后重构配置模块时把这个行为回退掉。
- 这次修改想解决的问题：
  - 给 401 修复增加稳定回归保护。

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_settings.py tests/test_repo_analyst.py -q`
- 观察结果：
  - `11 passed`
- 判断：
  - 修复生效且未破坏 repo analyst 现有行为。

---

## 步骤 4：运行时验证与服务切换

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; ... | D:\Anaconda\envs\dl\python.exe -`（检查当前 settings 实际值）
  - `Start-Process ... --port 8002`
  - `Invoke-RestMethod http://127.0.0.1:8002/health`
- 观察结果：
  - `model=deepseek-v4-pro`
  - `starts_with_quote=False`
  - `ends_with_quote=False`
  - `key_len=35`
  - `health` 返回 `{"status":"ok"}`
- 判断：
  - 新进程已加载修复逻辑，key 不再带引号。

---

## 方案调整记录
- 原方案：
  - 仅建议手动改 `.env` 去掉引号。
- 调整原因：
  - 只改本地文件容易重复犯错，且不同同学会复用这种写法。
- 新方案：
  - 代码层容错 + 单测兜底。
- 差异：
  - 从“靠人为规范”变成“靠代码保证”。

---

## 阶段总结
- 最终完成了哪些改动：
  - settings 解析支持自动去除包裹引号。
  - 新增配置解析测试用例并通过。
  - 启动了新服务端口 `8002`，健康检查通过。
- 还有哪些遗留问题：
  - 若 key 本身已失效/吊销，仍会返回 401（与本次引号问题无关）。
- 后续建议先做什么：
  1. 先用 `http://127.0.0.1:8002/` 重新发起一次分析验证。
  2. 如果仍 401，直接在 DeepSeek 控制台轮换新 key。
