# Coding Agent MVP Bench

本文件仅作为兼容旧链接的入口。当前评测方案以 [`coding-agent-simple-evaluation-plan.zh-CN.md`](coding-agent-simple-evaluation-plan.zh-CN.md) 为准。

核心流程：干净 workspace → 日常 provider/model → `workspace-full-access` → 发送任务原文和固定边界说明 → Agent 自主操作 → 保存日志、diff 和结果 → 使用仓库原生测试入口验证。

不再使用独立 Grader、hidden patch、评测专用 step/超时、命令白名单或统一 pytest 入口。
