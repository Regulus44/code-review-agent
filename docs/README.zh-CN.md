# 文档导航

这里是当前 Coding Agent 仓库的文档入口。面向日常开发时，优先阅读“当前状态”和“架构与契约”；阶段计划与旧开发日志只用于历史追溯。

## 从这里开始

- [当前状态](status.zh-CN.md)：已实现能力、已知限制、风险和近期优先级。
- [架构决策](architecture-decisions.md)：Runtime、EventStore、Web、工具和协议边界。
- [事件契约](event-contract.md)：事件 envelope、sequence、幂等和回放要求。
- [工具契约](tool-contract.md)：工具发现、校验、权限、执行和审计管线。
- [协议边界](protocol-boundaries.md)：MCP、ACP、A2A 与内部 Task/Subagent 的职责划分。
- [上游复用登记](source-reuse-register.md)：DSH、Claude Code 参考和许可证记录。

## 产品与运行

- [评测文档](evaluation/README.zh-CN.md)
- [运行与安全文档](operations/README.zh-CN.md)
- [Provider / model routing 实现说明](reference/provider-model-routing-mr6-implementation.zh-CN.md)

## 设计与参考

设计参考、调研和实现说明集中在 [reference](reference/README.zh-CN.md)。它们不定义当前产品状态；状态以 [当前状态](status.zh-CN.md) 为准。

## 决策记录

`docs/adr/` 保存已经接受的架构决策。ADR 是长期约束的补充，不替代公共契约和当前状态页。

## 历史归档

- [阶段资料归档](archive/phases/README.zh-CN.md)：Phase 0–8 计划、旧状态表和迁移总计划。
- [阶段开发日志归档](archive/development-log/README.zh-CN.md)：已完成阶段和 M01–M14 的过程记录。
- [其他历史参考](archive/references/phase-7-dsh-web-research.zh-CN.md)：阶段性 Web 调研记录。

归档资料保留原始结论、验证命令和 checkpoint，不作为当前开发顺序或当前能力声明。
