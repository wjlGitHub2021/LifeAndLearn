# 项目协作入口

本项目是面向个人学习与生活的多 Agent 协作管理平台，当前阶段以文档索引为准。

## 开始工作

1. 阅读 [文档索引](docs/INDEX.md)，确认当前阶段、下一动作和已有文档。
2. 阅读 [项目定义](docs/PROJECT.md)，遵守本地单用户运行及公开源码发布的边界；提交和推送仍以用户当前授权为准。
3. 只读取、更新当前任务相关的规格、计划和代码；尚未创建的文档不视为已存在的要求。

## 项目工作约定

- 使用 `project-lifecycle-docs` 技能维护项目文档；以本项目已确认的渐进建档方式为准，不一次生成所有生命周期文件。
- 文档中的“已确认需求”“候选方案”和“已验证实现”必须区分。需求已确认不代表功能已实现。
- 不把雅思或求职的示例数据硬编码成平台规则；具体用户流程以项目定义及后续规格为依据。
- 新的产品或技术选择先归入对应真源；不得静默扩大 MVP 范围。
- 已实现的技术栈见[实际架构](docs/architecture/OVERVIEW.md)，经验证的安装、启动、测试及构建命令见[运行手册](docs/operations/RUNBOOK.md)；变更后更新各自真源。
- 场景测试只使用独立的一次性数据库，验证结束后停止测试服务并清理该库、WAL/SHM 与测试备份；默认业务库不接收测试事项。具体操作见[运行手册](docs/operations/RUNBOOK.md#一次性测试数据)。

## 完成工作

- 更新本次变化的唯一真源，并同步索引中的入口或阶段状态；不要复制整段规格到多个文件。
- 报告实际修改、验证结果、未验证项和下一步。原型数据与真实模型结果必须可区分。
- 文档改动后运行 [索引中的文档检查命令](docs/INDEX.md#文档验证)，并重读改动确认事实和状态准确。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
