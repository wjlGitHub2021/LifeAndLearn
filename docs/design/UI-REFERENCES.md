# 工作台界面参考与设计取舍

## 事项作答与实时模型输出调研（2026-09-27）

本轮由子 Agent 分别复核学习交互、长成果阅读和模型流式协议的官方资料，主任务对照本地事项页及用户截图。以下取舍是本项目设计推断；未登录这些产品做实机对照，也不能据此证明个人操作效率。

| 官方依据 | 可确认的做法 | 本项目取舍 |
|---|---|---|
| [ChatGPT Study Mode](https://help.openai.com/en/articles/11780217-using-study-mode-in-chatgpt) | 通过逐步提问、作答与反馈帮助用户学习 | 当前题目与唯一作答入口放在主工作区，完成后就地显示反馈；历史题目按需查看 |
| [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)、[Notion 页面布局](https://www.notion.com/en-gb/help/layouts) | 长成果与主要对话或编辑空间分开阅读；页面属性可按布局分组 | 主区优先保留用户当前动作，成果用独立页签，排期、来源与运行快照放次级区域 |
| [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) | SSE 逐块返回正文；思考模式可返回独立的 `reasoning_content` | 正文只从传输 JSON 的目标字段提取为未校验草稿；思考仅在渠道真实返回时显示，完成校验后才保存成果 |
| [OpenAI Reasoning](https://developers.openai.com/api/docs/guides/reasoning) | 不同模型对可见推理内容的支持不同 | 不把本地状态、提示词或推测文本冒充模型思考；渠道不返回时明确说明 |

## 事项级模型选择调研（2026-09-27）

本轮核对官方公开文档和当前应用代码，未登录竞品做实机操作。产品取舍是对公开做法的推断，不是竞品可用性测试；正式行为见[事项级模型选择规格](../specs/mvp.md#事项级模型选择2026-09-27-已确认并实现)。

| 官方依据 | 可核实做法 | 本项目取舍 |
|---|---|---|
| [Open WebUI 快速开始](https://docs.openwebui.com/getting-started/quick-start/)、[模型选择](https://docs.openwebui.com/features/workspace/models/) | 在发起聊天的输入区域选择模型；模型选择器可搜索，模型能设为个人默认 | 本事项的模型选择贴近需求输入框；先复用现有渠道/模型清单，渠道多时再加搜索，不把设置页作为每件事项的必经步骤 |
| [ChatGPT Enterprise/Edu 模型说明](https://help.openai.com/en/articles/11165333-chatgpt-enterprise-and-edu-models-limits) | Web 模型选择位于消息输入区域；实际可见选项受工作区设置约束 | 输入处显示选择，但只提供当前已连接、已列出的模型；不显示不可执行的选项 |
| [LangSmith Assistants](https://docs.langchain.com/langsmith/configuration-cloud) | Assistant 可保存模型配置；运行时可用特定 Assistant 配置，也可走默认配置；配置更新影响后续运行 | 保留 Agent 长期默认，允许事项明确覆盖；运行固化当次模型，已有成果不随默认配置改写 |

当前代码的工作区默认和逐 Agent 覆盖见 `src/lib/model-connections.ts`，新建快捷事项和自选事项入口分别在 `src/components/WorkbenchV2.tsx` 与 `src/components/AgentWorkspace.tsx`；两条执行链在启动时调用 `beginGeneration(agentId)`。因此只加前端下拉框不会改变实际路由，需同时实现事项持久化、服务端校验、两条执行链及练习路由。

## 多渠道模型与 Agent 模型选择调研（2026-09-27）

本轮只阅读官方公开文档，未登录竞品做实机操作。右栏是本项目的产品推断，并非竞品实测结论。

| 官方依据 | 可确认的产品做法 | 本项目取舍 |
|---|---|---|
| [Open WebUI 连接渠道](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)、[OpenAI 兼容连接](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) | 提供多个模型渠道连接，配置 API 地址与 Key；尝试读取模型列表，也允许手动指定模型 ID | 设置中集中管理渠道、状态与默认模型；对列表失败的手动模型明确标注未验证 |
| [LibreChat 自定义端点](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints) | 自定义端点可设置基础地址、密钥方式及可选模型列表 | 本地单用户应用允许自定义公网 HTTPS 基础地址；不把任意 URL 当可信地址，也不提供未实现的协议适配 |
| [Dify 模型供应商](https://docs.dify.ai/zh-hans/guides/model-configuration/readme) | 供应商凭据与可使用模型分别配置，并可测试连接 | “连接成功”和“生成成功”分开描述，Agent 选模型放在自己的概览，避免把连接与任务职责混在一个长表单 |
| [n8n Agents](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/build-and-manage-agents.md) | Agent 构建中可选择其模型 | 保留工作区默认模型，每个 Agent 只在有需要时覆盖；运行记录固化当次模型 |
| [OpenAI API 与 ChatGPT 计费说明](https://help.openai.com/en/articles/9039756) | ChatGPT 订阅与 API 平台分开计费 | 不把产品账号登录伪装成 API 连接；此轮只用 API Key，厂商 OAuth 单独立项 |

本轮方案不保证任意兼容接口支持 `/models` 或 JSON 输出，也不代表完成供应商账号登录集成。正式行为与验收见[多渠道模型规格](../specs/mvp.md#多渠道模型连接与-agent-选择2026-09-27-已确认)。

## 工作区与设置二次调研（2026-09-27）

本轮由三个并行子 Agent 分别阅读工作台/事项、日程/数据、设置/导航的官方资料，并核对本地代码；主任务复核了本机 3000 页面与 [Linear My Issues](https://linear.app/docs/my-issues) 的公开说明。下表只记录相对[已有一体化调研](#一体化工作区竞品交互调研2026-09-27)新增的取舍；这些是设计推断，不是登录竞品后的可用性测试。

| 官方依据 | 可确认的做法 | 本项目本轮取舍 |
|---|---|---|
| [Linear My Issues](https://linear.app/docs/my-issues)、[Agent 委派](https://linear.app/docs/assigning-issues) | 个人事项以适用的优先分组呈现；委派给 Agent 后人仍能在个人事项看到并负责 | 工作台先给人一件动作，两类事项统一进入待我处理；右侧不重复主焦点。用户仍核对成果，Agent 不自动代替作决定 |
| [Notion My Tasks](https://www.notion.com/help/guides/give-your-to-dos-a-home-with-task-databases)、[Todoist Quick Add](https://www.todoist.com/help/todoist/features/use-task-quick-add-in-todoist-va4Lhpzz) | 跨来源聚合个人任务并提供过滤；快速输入先于细节配置 | 我的事项加本地检索、类型与日期筛选、桌面侧边预览；空库只保留一次轻量需求输入 |
| [Todoist 日历布局](https://www.todoist.com/help/todoist/features/use-the-calendar-layout-in-todoist-lPHRQTu0o)、[Sunsama 周规划](https://help.sunsama.com/docs/usage-guides/weekly-objectives/weekly-planning/) | 周/月安排与未定日期事项可以并置，规划从可处理的事项开始 | 七天日期与所选日清单同屏，未安排及逾期单独切换；数据图退到次级区。只用已有日期字段，不创造钟点、自动改期或完成趋势 |
| [Linear 个人偏好](https://linear.app/docs/account-preferences)、[Notion 工作区设置](https://www.notion.com/help/workspace-settings) | 个人显示/入口偏好与工作区设置有清晰分组 | 设置分为使用偏好、外观、模型连接、数据与隐私、使用说明；新增默认入口和日程视图必须实际生效，Agent 权限仍在团队页 |
| [ChatGPT 数据控制](https://help.openai.com/en/articles/7730893)、[记忆说明](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) | 数据控制与记忆管理有不同入口 | 本地数据页如实展示存储/发送范围和计数，偏好去资料与记忆页；当前没有站内导出或清除功能，不放假按钮 |

行为与验收由[工作区二次重构规格](../specs/integrated-workspace.md#工作区二次重构2026-09-27-已确认)统一定义。没有用户个人事项使用数据证明该布局已经减少操作时间。

## 资料与记忆管理调研（2026-09-27）

以下根据官方公开说明整理，未登录竞品进行实机对照；右栏是对本地单用户产品的设计推断，非竞品事实或用户测试结论。

| 官方来源 | 可确认的做法 | 本项目取舍 |
|---|---|---|
| [Notion 数据库视图](https://www.notion.com/help/views-filters-and-sorts) | 数据库支持列表、过滤、排序；side peek 在右侧打开记录并保留左侧列表 | 资料用列表选择与右侧详情，避免全文逐件纵向展开 |
| [Linear Documents](https://linear.app/docs/documents) | 文档与项目等工作对象关联 | 资料保留所属事项，不伪装成可任意共享的全局文件库 |
| [NotebookLM 来源说明](https://support.google.com/gemininotebook/answer/16179559?hl=en) | 来源可单独选用，回答引用可回到来源 | 先提供来源事项跳转；当前没有逐段引用，不展示虚假的引用命中 |
| [ChatGPT Memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[Claude Memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 可保存、查看和管理长期记忆，历史上下文与持久记忆有区别 | 明确区分事项资料/纠正与用户主动保存的 Agent 长期偏好；撤销作用于后续运行 |

本轮不照搬自动提取、跨项目共享、知识库上传、逐段引用或复杂权限开关。当前数据模型没有可核实的资料有效期和偏好来源时间，也不显示相关状态。行为与验收归[资料与记忆工作区规格](../specs/workbench-v2.md#资料与记忆工作区2026-09-27-已确认)。

### 资料与记忆二次调研（2026-09-27）

两位子 Agent 分别查资料查找与 Agent 记忆治理，主任务再对照本机空库页面和当前代码。以下只据官方公开说明推导界面，未登录竞品或验证本项目个人使用效率。

| 官方依据 | 可确认的做法 | 本项目的设计取舍 |
|---|---|---|
| [Notion 工作区搜索](https://www.notion.com/help/search)、[Readwise Reader 全文检索](https://docs.readwise.io/reader/docs/faqs/searching) | 可搜索内容并缩小结果范围；Notion 区分工作区全文搜索和仅查属性的数据库搜索 | 当前本地正文关键词搜索在结果行给出命中片段和来源，明说不是语义检索；不先加无数据支撑的标签体系 |
| [Readwise 的段落和文档分层](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)、[Notion Web Clipper](https://www.notion.com/help/web-clipper) | 原文与提取内容、保存目标有不同层级；保存时可确定归属 | 原始资料、明确纠正、已确认成果、Agent 偏好分开；本项目尚无独立上传实体或来源 URL，不提供假上传入口 |
| [ChatGPT Memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[Claude Memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 长期保存的记忆与历史内容分开管理；可查看和处理保存的记忆 | 偏好显示有效和撤销历史，并说明撤销只影响未来运行；不把事项原文自动提升为全局长期记忆 |
| [Claude Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)、[NotebookLM 来源](https://support.google.com/notebooklm/answer/16179559?hl=en) | 项目资料与项目指令分别管理；来源选择和引用能回到原文 | 显示事项与 Agent 作用域及成果版本；已确认成果才可按既有显式接续流程进入后续事项，当前无逐段引用则不展示假引用 |

本机检查发现：旧资料页只索引有文字资料或纠正的事项，空素材但已有已确认成果的事项不可见；搜索结果不显示命中正文，撤销偏好退出列表；快捷事项纠正没有单条有效状态，却被页面标为“有效”。这四项属于本产品实现缺口，而非竞品事实。二次[行为与验收](../specs/workbench-v2.md#资料与记忆二次重构2026-09-27-已确认)据此收敛；独立资料库、文件导入和自动记忆提取需另行设计来源、确认与权限规则。

## 聚焦式工作区调研（2026-09-27）

本轮阅读公开设计规范与研究说明，结合本地页面走查提出方案。下表是外部原则到本项目的推导，不代表已经完成真实用户测试。

| 来源 | 可确认的原则 | 本项目的取舍 |
|---|---|---|
| [GOV.UK Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/) | 多步骤任务应显示任务、顺序和完成状态；先简化任务数量 | 首页把当前需处理事项及下一动作放在首屏，其余变为队列 |
| [Nielsen Norman Group：Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | 首层只展示常用选项，次级配置按需展开，入口需清楚 | 新建先问需求，再展示角色、资料与排期；不隐藏运行前的权限确认 |
| [Material 3：Canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) | 主内容与支持面板按窗口宽度调整 | 桌面用右侧事项工作区承载状态、排期和来源；主体保留动作与成果 |
| [Nielsen Norman Group：Scrolling and Attention](https://www.nngroup.com/articles/scrolling-and-attention/) | 页面顶部得到更多注意，关键内容需要优先呈现 | 待答题目与提交入口前置；长成果仍可正常阅读滚动 |
| [WAI-ARIA Accordion Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/) | 折叠区的名称、状态与键盘操作需可感知 | 窄屏事项上下文及次级历史采用可辨认的折叠入口 |

具体用户可观察行为与验收见[聚焦式工作区规格](../specs/focus-workspace.md)。

## 一体化工作区竞品交互调研（2026-09-27）

以下仅依据五款产品的官方公开帮助文档，检索日期为 2026-09-27；未登录产品、观察其当前实际界面或进行本项目用户测试。表中的“产品事实”来自所列资料，“借鉴”和“不照搬”是结合本项目本地、日期级排期与显式 Agent 运行边界作出的设计推导。Todoist 日历文档标注最后更新于 2026-09-24；其余资料不推定发布日期。

| 产品与官方来源 | 产品事实 | 本项目借鉴（推导） | 不照搬（推导） |
|---|---|---|---|
| Todoist：[任务入门](https://www.todoist.com/help/todoist/features/introduction-to-tasks-080OAXric)、[日历布局](https://www.todoist.com/help/todoist/features/use-the-calendar-layout-in-todoist-lPHRQTu0o) | 从任务名称开始创建；未指定项目的任务进入 Inbox。日历可切周/月，未设置日期的任务可从 `No date` 侧栏安排；完成任务可在项目中重新显示。 | 一个明确的新建入口；日程与未安排列表并置；历史从活跃列表移出但可找回。 | 不引入自然语言日期解析、重复任务或时间块来改变本项目的日期级排期。 |
| Sunsama：[工作区导航](https://help.sunsama.com/docs/usage-guides/workspace-navigation/)、[周规划](https://help.sunsama.com/docs/usage-guides/weekly-objectives/weekly-planning/)、[Backlog](https://help.sunsama.com/docs/usage-guides/backlog/)、[Archive](https://help.sunsama.com/docs/usage-guides/archive/) | Home、Today 与 Focus 分层；主区选择的日期决定右侧任务或日历上下文。周规划先定目标，日规划再排具体任务；积压与归档有独立入口。 | 让主体的选中日期带动右侧上下文；把当前行动、待安排事项和历史分层。 | 不自动把未完成事项顺延或归档，也不把估计参与时间当作日历占用。 |
| Asana：[快速入门](https://help.asana.com/s/article/quick-start-guide-to-asana)、[My Tasks 视图](https://help.asana.com/s/article/views-in-my-tasks)、[Reporting](https://help.asana.com/s/article/universal-reporting?language=en_US) | My Tasks 聚合跨项目的个人任务，Inbox 放活动通知。My Tasks 有列表及 7 日周视图，可切月、打开未安排侧栏；报表可按日期字段筛选，图表分段可查看底层数据。 | 合并两类事项的行动列表，区分“要我做”与“供我了解”；图表筛选与事项明细使用同一口径。 | 不复制多团队、项目组合和可任意配置的首页仪表盘。 |
| Notion Calendar：[入门指南](https://www.notion.com/en-gb/help/guides/getting-started-with-notion-calendar)、[日历视图](https://www.notion.com/help/calendars) | 带日期属性的记录可进入日历；日历支持周/月视图，用户可打开关联的 Notion 内容。 | 日期卡片直接打开原事项和成果；明确当前视图按哪一个日期字段展示。 | 不复制按钟点创建事件、外部日历连接和提醒；本项目 `planned_date` 与 `due_date` 含义不同。 |
| Linear：[My Issues](https://linear.app/docs/my-issues)、[创建事项](https://linear.app/docs/creating-issues)、[Insights](https://linear.app/docs/insights) | 个人事项按紧急、受阻、活跃、积压、已完成等适用分组呈现；新建草稿可暂存。Insights 位于事项视图右侧，沿用当前视图筛选，图段与表格可临时过滤事项。 | 只显示有内容的状态分组；保留建单草稿；图表点选后展示对应事项并可清除筛选。 | 不引入研发专用状态、多团队视图或以快捷键为前提的高密度流程。 |

对本轮重构的启发是：先让用户看见一件当前要处理的事和一个新建入口；把完整事项、日期安排、Agent 运行与历史放在可预测的独立层级；日期视图先保证“计划处理日”和“截止日”不会混用；图表必须注明时间范围与分母，并可回到同口径原始事项或事件。空数据时给真实零值和可执行入口，不预置演示成果；所查官方资料不足以确认五款产品各自的实际空状态文案，此处不归为竞品事实。环图若表达排期占比，只能使用互斥且合计为总体的类别；启动、成功、失败和已确认成果是不同事件，不能合成一个“完成比例”。这些均是待验证的设计判断，正式行为与验收以[一体化工作区规格](../specs/integrated-workspace.md)为准。

## 本周与趋势增量参考（2026-09-27）

本轮只阅读官方公开说明，未登录外部产品，也不把其界面当作本项目验收依据。

| 官方来源 | 可确认的做法 | 本项目的设计取舍 |
|---|---|---|
| [Notion Calendar view](https://www.notion.com/help/calendars) | 日历视图依托记录的日期属性，可按周查看 | 先为两类事项建立用户明确设置的日期，再显示站内本周；不从创建时间猜计划日 |
| [Todoist Upcoming view](https://www.todoist.com/help/articles/plan-your-week-with-the-upcoming-view-OKOg1mR8) | 周视图查看未来安排，未安排或逾期事项有单独处理入口 | 本周与未安排并存；截止提示不替代用户安排 |
| [Microsoft Foundry Agent Monitoring](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/how-to-monitor-agents-dashboard?view=foundry) | 摘要卡与所选时间范围的图表分层呈现 | 既有指标卡保留，新增真实事件趋势及点位钻取；不加入未采集的 Token 或自动质量分 |

具体产品行为见[PI 规格](../specs/workspace-planning.md)，本表不另定图表口径或任务状态。

## Agent 管理产品调研（2026-09-27）

本轮阅读以下官方公开资料，未登录产品或验证真实界面行为。资料展示的是各产品文档中的能力，应用到本项目的建议是设计推断。

| 官方资料 | 可确认的产品做法 | 对本项目的取舍 |
|---|---|---|
| [CrewAI AMP](https://docs-platform.crewai.com/platform/en/introduction) | 创建和自定义 crew，部署并监控执行，查看轨迹与日志 | 借鉴“Agent 团队→执行记录”层级；本地个人工具不引入部署管理 |
| [LangSmith Dashboards](https://docs.langchain.com/langsmith/dashboards) | 预置仪表板汇总 trace、错误、耗时、Token、费用和反馈，支持钻取 | 借鉴“总览→明细”和指标定义；未采集 Token/费用时不展示估算 |
| [Microsoft Agent Builder Monitor](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder-monitor-agents) | 单 Agent 的时间窗口、使用趋势、知识来源及用户反馈 | 借鉴近 7 日窗口和用户反馈可见性；不照搬多人会话/DAU 指标 |
| [Microsoft Foundry Agent Monitoring](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/how-to-monitor-agents-dashboard?view=foundry) | 单 Agent 的运行成功率、延迟、Token 与评估结果分层呈现 | 保持运行成功和成果质量分开；首版不编造自动评估分数 |

本项目的页面和验收口径统一见[Agent 管理与跨事项接续规格](../specs/agent-management.md)。

### Agent 团队管理交互复核（2026-09-27）

前一轮侧重监控指标。本轮对本地 1089px 页面走查发现：创建表单、实例卡、空统计、趋势与偏好纵向堆叠；偏好远离其所属 Agent，内置预设的详情入口在零指标时不可用。以下参考用于重排管理动作，不代表已登录外部产品实测。

| 官方资料 | 可确认的做法 | 本项目的设计推导 |
|---|---|---|
| [Microsoft Copilot Studio 创建与编辑 Agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-first-bot) | Agents 页可从描述或空白创建，随后进入该 Agent 的 Overview；名称、描述与指令在概览中编辑，创建后可测试。 | 团队先给出可选 Agent，再在同一上下文看当前职责和编辑配置；不复制其企业部署与发布流程。 |
| [Zapier Agents 创建指南](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents) | 左侧 New agent 可选自定义或模板，创建后进入配置页并可测试。 | 明确“创建 Agent”入口，保留模板与空白配置选择；不引入外部 App 连接或自动触发。 |
| [OpenAI GPT 编辑指南](https://help.openai.com/en/articles/8554397-creating-and-editing-gpts) | 管理入口中选择已有 GPT 后进入编辑；名称/描述/对话开场与指令是不同配置内容。 | 将“这位 Agent 是谁、会交付什么”放在概览，较长指令和权限放到编辑层；本项目不提供 GPT 发布或商店。 |

本轮取舍：桌面使用 Agent 列表与选中实例工作区，窄屏横向选择列表；选中实例的职责、资料范围、长期偏好和创建事项入口放在同一处。运行记录和团队统计保留真实口径，但由显式入口按需打开。此方案是基于本地问题和官方文档的设计判断；实际个人使用是否更快找到操作仍需后续试用验证。

> 调研日期：2026-09-26
> 状态：保留历史视觉调研和事项工作台重设计依据；新版流程已获认可，正式行为见事项工作台规格。

## 事项工作台重设计调研

用户在首版运行后反馈产品体验仍奇怪。此次设计判断是：入口过于依赖目标表单、安排与作答，Agent 的准备工作、成果和跨角色交接不够直观。以下来源用于机制参考，核实方式为官方公开页面阅读，未登录试用，不评价其实际运行质量。

| 官方来源 | 可借鉴机制 | 本轮应用 |
|---|---|---|
| [Claude 对话与 Cowork 统一入口说明](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) | 从统一请求入口选择所需工作方式 | 先描述事情，按需要展示协作过程 |
| [Claude Cowork 入门](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) | 计划、进展与最终成果 | 事项中查看分工及可直接使用的产出 |
| [Manus Projects](https://manus.im/blog/manus-projects) | 项目保存可复用指令和知识上下文 | 资料与成果归属持续事项 |
| [Taskade AI Teams](https://help.taskade.com/en/articles/9586050-ai-teams) | 团队按职责处理任务并共享协作上下文 | 明确中文提纲到英文介绍的交接 |
| [Lindy 官方介绍](https://www.lindy.ai/) | 用户可检查的记忆与持续例行工作 | 明确偏好、事项事实及来源分离；例行后台工作不进入草图 |

这些产品各有范围，不能据此推导本项目需要社区、市场或完整自动化平台。此次仅借鉴统一入口、持续上下文、成果交接和用户可控记忆；主题与本地开发约束继续遵循用户要求。候选交互及模拟边界统一见 [v0.4 草图](WIREFRAME.md#v04-事项工作台候选设计)。

## 当前问题

用户反馈 v0.1 界面奇怪，并明确建议左侧导航。对原草图的设计判断如下：

- 顶部将“今天”和“任务详情”并列，混淆了全局模块和具体任务的层级。
- 大标语与多个同等强调的卡片占据注意力，平台的目标、角色和历史缺少稳定入口。
- 大面积近似灰绿色和重复边框使主要任务、背景信息与辅助说明缺乏视觉区别。

这些是对当前草图的分析，不是经过用户研究得出的通用结论。

## 参考来源

| 来源 | 核实方式 | 借鉴点 | 本项目应用 |
|---|---|---|---|
| [Linear 官方界面改版案例](https://linear.app/changelog/2024-03-20-new-linear-ui) | 阅读官方说明，并在浏览器打开 New sidebar 配图观察 | 分组侧栏；更清楚的层级、密度及标题与操作分区 | 左侧稳定导航，顶部当前位置；内容区减少重复卡片 |
| [Linear Projects 文档](https://linear.app/docs/projects) | 阅读项目及详情侧栏说明 | 对象总览与对象详情分层 | 目标页面展示关联任务，任务详情属于下一级上下文 |
| [Reclaim Planner 官方说明](https://help.reclaim.ai/en/articles/6206998-planner-overview-view-and-manage-your-schedule) | 阅读日程、任务、优先级与详情区说明 | 主任务区与上下文详情分离 | 中央用于任务执行，辅助区域说明参与角色与安排依据 |

Linear 参考来自 2024 年的官方改版案例；Reclaim 文档明确描述 1.0 界面，不能据此宣称它们是当前最新界面。借鉴的是可核实的结构与交互方式。

调研也查看了 Dify 官方产品介绍。当前项目以个人目标和日常行动为中心，本轮没有将工作流节点画布纳入设计范围。没有复制第三方图片、商标或源代码到草图。

## 本轮方案

- 四个一级导航：今天、目标、Agent 团队、执行记录。
- “任务详情”由今日任务、目标关联或执行记录进入，左侧导航保持稳定。
- 桌面使用左导航、中央工作区、按上下文显示的右侧说明区；空间不足时说明区移到下方，极窄屏把导航转为顶部网格。
- 主页面标题直接命名视图，删除大标语；主要操作只强调当前应执行的动作。
- v0.2 使用中性背景、细分隔线与少量紫色强调，颜色跟随宿主深浅主题。v0.3 已按用户要求改为固定明暗与独立彩色方案，具体规则见 [主题规则](WIREFRAME.md#已确认的主题规则)；不新增产品依赖。
- 新导航必须可以切换到有实际信息的视图。目标与团队页先做只读结构；执行记录来自当前草图会话的任务状态。
- 不增加没有对应能力的搜索框、设置按钮、通知数量或虚构成绩图表。

本次新增辅助视图只为验证信息架构，不扩大正式 MVP 的业务承诺。角色配置、权限编辑、目标创建与真实持久化仍待实现。
