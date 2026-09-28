# 文档索引

> 更新日期：2026-09-28
> 当前阶段：新版事项与自定义 Agent、CD1 接续、MD1 Markdown、AT1 团队、MT1/MT2 资料记忆、WS1—WS4 工作区及 MC1/MC2 模型选择均已完成隔离验收；面试选择题与词汇开放题的真实 DeepSeek 新交互已在虚构场景复验，个人真实使用效果待评估。
> 当前焦点：事项主区作答、Markdown、真实流式正文及供应商思考字段已完成两条真实模型闭环；多渠道及事项级路由的第三方模型仍只用合成凭据和 mock 验证。此前空素材面试与词汇七日真实 DeepSeek 链路不代表新增渠道的生成质量。
> 公开展示：源码已发布到 [GitHub 公开仓库](https://github.com/wjlGitHub2021/LifeAndLearn)，个人网站 [LifeAndLearn 单页](https://orizuru.top/LifeAndLearn) 已上线；应用继续本地单用户运行。排除项、验证和恢复见[公开展示发布](release/PUBLIC-SHARING.md)。
> 本地数据：2026-09-28 按用户确认的 mock 数据清理授权，默认库 3 件业务事项及练习、运行、成果已清空；保留 3 个内置角色、2 个预设 Agent，原 `3000` 进程中的 DeepSeek 连接仍在。`3211`、`3212` 的一次性服务和库均已清理；不同数据库的日程互不共享。见[真实复验](quality/MVP-VERIFICATION.md#真实-deepseek-面试与词汇全链路复验2026-09-28)及[一次性测试数据约定](operations/RUNBOOK.md#一次性测试数据)。

## 立即入口

- [公开展示发布](release/PUBLIC-SHARING.md)：GitHub 公开仓库与个人站单页的范围、忽略提交、核验与恢复；正式发布状态以该记录为准。
- [真实 DeepSeek 面试与词汇全链路复验](quality/MVP-VERIFICATION.md#真实-deepseek-面试与词汇全链路复验2026-09-28)：两件空素材事项的真实流式成果、选择题/开放题、作答反馈、排期与完成，及失败重试和测试数据清理；行为见[规格](specs/workbench-v2.md#快捷事项作答与模型流式输出2026-09-27-已确认)，依据见[官方调研](design/UI-REFERENCES.md#事项作答与实时模型输出调研2026-09-27)。
- [快捷事项作答与流式输出隔离验收](quality/MVP-VERIFICATION.md#快捷事项作答与流式输出隔离验收2026-09-27)：当前题/回答唯一入口、Markdown 选择题与开放题、模拟 SSE 正文及思考字段、390px 页面。
- [事项级模型选择与隔离验收](quality/MVP-VERIFICATION.md#事项级模型选择隔离验收2026-09-27)：两类新建事项与详情、事项/Agent/工作区优先级、多 Agent、练习、断连及并发；行为见[MC2 规格](specs/mvp.md#事项级模型选择2026-09-27-已确认并实现)，依据见[公开产品调研](design/UI-REFERENCES.md#事项级模型选择调研2026-09-27)，状态见[MC2 计划](plans/mvp.md#mc2-事项级模型选择实现并隔离验收)。
- [多渠道模型与 Agent 选择验收](quality/MVP-VERIFICATION.md#多渠道模型与-agent-选择隔离验收2026-09-27)：旧 DeepSeek 兼容、多个 API Key 渠道、模型列表、默认与逐 Agent 选择；行为见[MC1 规格](specs/mvp.md#多渠道模型连接与-agent-选择2026-09-27-已确认)，依据见[官方调研](design/UI-REFERENCES.md#多渠道模型与-agent-模型选择调研2026-09-27)。
- [工作区与设置二次重构验收](quality/MVP-VERIFICATION.md#工作区与设置二次重构隔离验收2026-09-27)：首页焦点、事项检索与预览、七天安排和真实设置偏好；行为见[WS 规格](specs/integrated-workspace.md#工作区二次重构2026-09-27-已确认)，依据见[官方调研](design/UI-REFERENCES.md#工作区与设置二次调研2026-09-27)。
- [资料与记忆二次重构验收](quality/MVP-VERIFICATION.md#资料与记忆二次重构隔离验收2026-09-27)：四类记录、命中片段、来源与作用域、撤销历史；行为见[MT2 规格](specs/workbench-v2.md#资料与记忆二次重构2026-09-27-已确认)，依据见[二次调研](design/UI-REFERENCES.md#资料与记忆二次调研2026-09-27)。
- [资料与记忆首次工作区改版](quality/MVP-VERIFICATION.md#资料与记忆工作区改版2026-09-27)：此前两类事项资料与纠正统一检索、长期偏好按 Agent 管理的历史基线。
- [Agent 团队工作区改版](quality/MVP-VERIFICATION.md#agent-团队工作区改版2026-09-27)：基于[官方交互调研](design/UI-REFERENCES.md#agent-团队管理交互复核2026-09-27)调整实例选择、配置、偏好、历史和统计的层级；行为见[AM7](specs/agent-management.md#验收)。
- [新建事项时间控件错位修正](quality/MVP-VERIFICATION.md#新建事项时间控件错位修正2026-09-27)：1089px 与 390px 页面复核和类型检查通过。
- [模拟数据清理与日程核对](quality/MVP-VERIFICATION.md#模拟数据清理与日程核对2026-09-27)：确认 3203 和默认库的隔离原因，清理全部已识别测试库并保留 Agent 配置。
- [一次性测试数据](operations/RUNBOOK.md#一次性测试数据)：场景测试使用隔离库并在结束后清理；自动化测试使用独立临时目录并自动清理。
- [Markdown 正文与流程图规格](specs/workbench-v2.md#markdown-正文与流程图2026-09-27-已确认)及[隔离验收](quality/MVP-VERIFICATION.md#markdown-正文与流程图隔离验收2026-09-27)：成果、练习及资料的统一阅读和预览，Mermaid 源码回退、安全边界与窄屏检查。
- [空素材七日复测](quality/MVP-VERIFICATION.md#空素材七日复测2026-09-27)：14 件真实生成、无实际作答、时间与词表来源修正，以及仍存在的题目质量边界。
- [快捷事项跨日接续修复与七日复验](quality/MVP-VERIFICATION.md#快捷事项跨日接续修复与七日复验2026-09-27)：显式固定来源、练习反馈接续、两条真实模型链到第 7 天，以及失败和模拟作答的边界。
- [面试与雅思词汇七日隔离演练](quality/MVP-VERIFICATION.md#面试与雅思词汇七日隔离演练2026-09-27)：14 件跨月排期、8 次真实调用、面试交接与模拟练习，以及未通过的跨天接续。
- [一体化工作区规格](specs/integrated-workspace.md)：导航、开始路径、事项列表、周/月日程与图表的目标及 IW1—IW6 验收；已隔离验证。
- [一体化工作区隔离验收](quality/MVP-VERIFICATION.md#一体化工作区隔离验收2026-09-27)：17 条混合事项、空库、周/月、桌面与 390px、键盘、107 项回归和未验证边界。
- [一体化工作区竞品调研](design/UI-REFERENCES.md#一体化工作区竞品交互调研2026-09-27)：五款产品官方交互资料与本项目取舍；设计推断不代表用户测试。
- [桌面右侧滚动边界修正](quality/MVP-VERIFICATION.md#桌面右侧滚动边界修正2026-09-27)：正文滚动容器取消顶部和底部回弹，Chrome 页面边界检查与类型检查通过。
- [聚焦式工作区规格](specs/focus-workspace.md)：本轮首页焦点、创建路径、两类事项详情和右侧上下文的目标与 UX1—UX6 验收；已隔离验证。
- [聚焦式工作区隔离验收](quality/MVP-VERIFICATION.md#聚焦式工作区隔离验收2026-09-27)：桌面与 390px 页面、mock 待答题目、自定义事项保存、107 项回归及未验证边界。
- [聚焦式工作区调研](design/UI-REFERENCES.md#聚焦式工作区调研2026-09-27)：公开设计依据及对本项目的取舍，不代表用户测试。
- [工作区日程与趋势规格](specs/workspace-planning.md)：已确认并实现的页面、排期元数据、趋势口径与 PI1—PI6 验收。
- [工作区日程与趋势隔离验收](quality/MVP-VERIFICATION.md#工作区日程与趋势增量验收2026-09-27)：逐块独立 QA、隔离页面与 107 项回归、未实测边界。
- [本轮设计草图说明](design/WIREFRAME.md#v05-日程与洞察增量)：吸顶顶部、设置、本周及趋势的已复核可点击演示；不代表真实数据接入。
- [Agent 管理与接续隔离验收](quality/MVP-VERIFICATION.md#agent-管理与跨事项接续隔离验收2026-09-27)：分块实现、独立 QA 发现与修复、主任务页面/容量回归和未覆盖边界。

- [真实 API 复验与测试数据清理](quality/MVP-VERIFICATION.md#测试数据清理与一次真实-api-复验2026-09-27)：一次真实 DeepSeek 生成及启停核对通过，随后清空测试数据；当前业务列表为空。

- [七日审计 P1 修复与复验](quality/MULTIDAY-AUDIT.md#p1-后续修复与复验2026-09-27)：自建实例暂停/恢复保留既有有效成果；隔离七日重放、旧库迁移、页面及 85 项回归通过。

- [当前自建 Agent 七日产品审计](quality/MULTIDAY-AUDIT.md#当前自定义-agent-的七个逻辑日产品审计2026-09-27)：修复前隔离 3 实例、6 事项和 12 次模拟请求；保留当时发现及跨日学习/生活连续性缺口。

- [格式偏好提示修正](quality/MVP-VERIFICATION.md#格式偏好提示修正2026-09-27)：消除正文格式与 JSON 协议的提示歧义；83 项自动化通过，三条/两条偏好各一次真实调用均符合且事实完整。

- [PT 修复与真实复验](quality/MVP-VERIFICATION.md#pt-修复与原场景真实复验2026-09-26)：两块全新 QA，原失败场景和第二次纠正新增 4 次真实调用均成功；记忆、暂停、权限冲突及固定侧栏复验通过。

- [原主任务真实页面亲测](quality/MVP-VERIFICATION.md#原主任务真实页面亲测2026-09-26)：新增两位自定义助手，4 次真实调用中初版两步成功、纠正后连续两次失败；记录分工重复、记忆入口遗漏和暂停受阻提示问题。

- [NR 修复后的独立复验](quality/MVP-VERIFICATION.md#nr-修复交付后的原主任务独立复验2026-09-26)：原问题 NR1—NR4 定点复验通过，80 项回归与类型检查通过；只读核对既有真实测试版本来源，无新增真实调用。

- [NR1—NR4 修复与定点验收](quality/MVP-VERIFICATION.md#nr1nr4-修复与定点验收2026-09-26)：权限回流、统一事项入口、纠正草稿和完整历史已修复，含逐块与最终集成 QA、虚构资料真实调用证据。

- [创建 Agent 与平台调度](specs/agent-creation.md)：已实现自建实例、显式步骤与规则调度；隔离验证和虚构资料真实调用完成。
- [Agent 管理与跨事项接续规格](specs/agent-management.md)：已确认并实现的看板口径、详情、明确来源和 AM1—AM6 验收。

- [项目定义](PROJECT.md)：目标、术语、首版范围、非目标、约束、验收场景和待决策项。
- [事项工作台规格](specs/workbench-v2.md)：新版流程、成果交接、纠正、记忆、兼容、W1—W8 与 CD1 快捷事项跨日接续；实现证据与未验证项分别见架构和验收记录。
- [首版 MVP 规格](specs/mvp.md)：旧版兼容行为、DeepSeek 连接与未变更的安全规则。
- [实际架构](architecture/OVERVIEW.md)：已实现组件、DeepSeek 官方接口依据、凭据与运行边界。
- [实施计划](plans/mvp.md)：开发顺序、依赖、验证方式及唯一任务状态。
- [运行手册](operations/RUNBOOK.md)：本地安装、启动、停止、数据与恢复。
- [验收记录](quality/MVP-VERIFICATION.md)：模拟、本机运行和真实模型证据的边界，以及独立 QA 结果。
- [多日模拟审计](quality/MULTIDAY-AUDIT.md)：历史五日 M1—M6 / RT1—RT3 与当前自定义 Agent 七个逻辑日审计；不代表真实耐久或模型内容质量验证。
- [项目协作入口](../AGENTS.md)：AI 开始与结束工作的阅读、更新和验证要求。
- [交互草图说明](design/WIREFRAME.md)：全局导航、核心流程及辅助视图的设计选择、体验路径、边界和验证记录；这是设计材料，不是正式应用实现。
- [UI 参考记录](design/UI-REFERENCES.md)：网络参考来源及本轮界面取舍。
- 当前以实施计划维护新旧任务状态，不另建重复路线图；可点击草图保留作设计材料，正式应用已建立。

## 当前下一步

下一动作与任务状态统一见[实施计划](plans/mvp.md)：用个人真实事项试用重点感、查找效率、跨日来源、日期安排与三级模型选择。应用启动方式见[运行手册](operations/RUNBOOK.md)。

草图展示范围与 A1 至 A5 的差距见 [验收映射](design/WIREFRAME.md#与项目级验收的关系)。不将浏览器走查通过视为真实 Agent、长期记忆或持久化能力通过验收。

用户已在本地应用连接 DeepSeek；旧版反馈和新版事项均完成虚构数据真实调用。新版测试使用现有本地连接，未读取或记录凭据。发送范围与存储规则见[模型连接规格](specs/mvp.md#deepseek-模型连接)，证据边界见[验收记录](quality/MVP-VERIFICATION.md)。

## 生命周期状态与创建条件

| 阶段 | 当前状态 | 当前真源或未来落点 | 下一阶段的触发条件或退出证据 |
|---|---|---|---|
| 发现 | 已有初始证据，未做真实使用验证 | [项目定义](PROJECT.md) | 通过场景走查验证所选问题与首批用户需求 |
| 定义 | AM、PI、UX、IW、CD1、WS 与 MT2 增量行为已确认并落地 | [项目定义](PROJECT.md)、[IW/WS 规格](specs/integrated-workspace.md)、[MT2/快捷接续规格](specs/workbench-v2.md)、[UX 规格](specs/focus-workspace.md)、[PI 规格](specs/workspace-planning.md)、[AM 规格](specs/agent-management.md) | 个人实际效果待试用 |
| 设计 | v0.4 已认可；v0.5 为历史草图，当前工作区以正式页面与 IW 规格为准 | [IW 规格](specs/integrated-workspace.md)、[UI 参考](design/UI-REFERENCES.md)、[实际架构](architecture/OVERVIEW.md) | 个人真实使用反馈 |
| 计划 | 历史任务及 WS1—WS4、MT2、MC2 均已隔离验收 | [实施计划](plans/mvp.md) | 个人真实事项试用 |
| 构建 | 新旧本地应用、自定义 Agent、持续使用闭环与一体化工作区均已实现 | 应用代码及[实施计划](plans/mvp.md) | 真实结果中的必要修正 |
| 验证 | 132 项自动化、类型检查与隔离生产构建通过；面试选择题和词汇开放题的真实 DeepSeek 流式、作答反馈、完成及清理已复验。MC2 的第三方合成渠道路由、双 Agent、练习及页面检查通过；此前空素材两条七日真实模型链通过，新增第三方渠道真实生成未测 | [多日模拟审计](quality/MULTIDAY-AUDIT.md)、[验收记录](quality/MVP-VERIFICATION.md) | 个人场景持续效果评估 |
| 发布 | 未开始，无公网发布计划 | 后续按需记录 | 用户明确提出发布需求 |
| 运行 | 本地启动与恢复说明已建立 | [运行手册](operations/RUNBOOK.md) | 真实使用中核查长期运行行为 |
| 迭代 | AM、PI、UX、IW、CD1、WS、MT2 与 MC2 增量均已隔离验收，个人使用效果待验证 | [WS 规格](specs/integrated-workspace.md)、[MT2 规格](specs/workbench-v2.md)、[MC2 规格](specs/mvp.md#事项级模型选择2026-09-27-已确认并实现)、[实施计划](plans/mvp.md) | 试用后按实际阻碍调整 |

## 唯一真源登记

| 职责 | 当前权威位置 | 后续维护方式 |
|---|---|---|
| 项目目标、范围、约束 | [PROJECT.md](PROJECT.md) | 发生产品范围变化时更新 |
| 稳定术语 | [PROJECT.md](PROJECT.md#术语与边界) | 暂不创建独立领域文档；复杂后迁移并保留指针 |
| 文档导航与阶段摘要 | 本文件 | 新增文档时登记真实链接；阶段详情未来指向路线图 |
| 项目协作入口 | [AGENTS.md](../AGENTS.md) | 只维护阅读顺序、特殊约定和指针 |
| 交互草图 | [设计说明](design/WIREFRAME.md) 与 [已认可草图源](design/workbench-v2.html) | 旧源保留历史基线；正式行为归入新版规格 |
| UI 调研与取舍 | [UI 参考记录](design/UI-REFERENCES.md) | 记录可核实来源及对应设计判断，不复制产品规格 |
| 项目级成功标准 | [PROJECT.md](PROJECT.md#成功标准) | 新版详细验收由 [事项工作台规格](specs/workbench-v2.md) 承担 |
| 当前下一动作与任务状态 | [实施计划](plans/mvp.md) | 本索引只提供阶段摘要与入口 |
| 非目标与后续候选 | [PROJECT.md](PROJECT.md#非目标与后续候选) | 创建待办池后迁移候选事项；非目标仍归项目定义 |
| 功能行为与验收 | [新版规格](specs/workbench-v2.md)；[首版兼容规格](specs/mvp.md) | 新版对应行为优先，首版保留兼容及被引用规则；不记录任务进度 |
| 聚焦式工作区行为与验收 | [UX 增量规格](specs/focus-workspace.md) | 首页与详情交互的唯一行为真源；实现证据进质量记录 |
| 一体化工作区行为与验收 | [IW 增量规格](specs/integrated-workspace.md) | 当前导航、事项列表与周/月图表的唯一行为真源；实现证据进质量记录 |
| 本周日程、趋势与设置行为 | [PI 规格](specs/workspace-planning.md) | 本轮唯一行为真源；实现证据进质量记录 |
| 自定义实例增量行为与验收 | [创建 Agent 规格](specs/agent-creation.md) | 动态实例和调度对应行为优先，其他新版规则继续适用；不复制任务状态 |
| 实施计划 | [plans/mvp.md](plans/mvp.md) | 维护执行步骤、依赖和任务状态 |
| 架构与接口依据 | [architecture/OVERVIEW.md](architecture/OVERVIEW.md) | 按实际代码与验证证据维护；必要时另建 ADR |
| 质量与运行记录 | [验收记录](quality/MVP-VERIFICATION.md)、[五日模拟审计](quality/MULTIDAY-AUDIT.md)、[运行手册](operations/RUNBOOK.md) | 只记录实际结果，不预填真实模型通过结论；五日审计承担本轮问题与复现真源 |
| 完整协作流程 | 尚未创建 | 现有入口足够；流程复杂度增加时再建立 `docs/WORKFLOW.md`，避免重复 |

上表中尚未创建的代码格式路径是未来约定，不是已存在文件的链接。不创建空目录或占位文档。

## 技能与外部系统

- 当前文档工作流：`project-lifecycle-docs`，本地技能位置为 `/Users/wangjinlong/.codex/skills/project-lifecycle-docs/SKILL.md`。
- 本次使用其项目定义与索引模板，按用户已确认的最小建档节奏裁剪 `bootstrap`：先创建三份有内容的文档，其余职责按触发条件补充。
- 技能产物归入本索引登记的位置；未来使用其他设计或开发技能时，先明确产物归属，不创建重复的项目定义或任务清单。
- 使用 `visualize` 技能制作可交互草图；已认可源为 `docs/design/workbench-v2.html`，旧源 `workbench-wireframe.html` 仅作历史基线。设计记录归入 `docs/design/WIREFRAME.md`；正式新行为归入 `docs/specs/workbench-v2.md`，首版规格保留兼容，不将认可状态写成已实现。
- 当前无外部 tracker、Wiki 或远程文档真源。版本控制与外部操作限制以 [项目约束](PROJECT.md#项目约束) 为准。
- 不复制招聘截图和完整聊天记录到项目中；项目定义只保留与产品判断有关的来源摘要。

## 文档维护

- 修改目标、约束或范围，更新项目定义；变更文档入口或阶段，更新本索引。
- 草图中的交互结论进入规格，技术权衡进入必要的决策记录；草图中的示例数据不升级为用户事实。
- 路线图维护里程碑，计划维护任务状态，待办池维护未承诺事项；同一状态不多处维护。
- 不为了文档齐全而阻塞可逆探索；会改变产品范围或权限边界的决定在对应实现前明确。

## 文档验证

2026-09-27 MC2 事项级模型选择同步：验证器通过 `OK: checked 19 Markdown file(s)`。117/117 自动化、类型检查和隔离 webpack 生产构建通过；AI 产品经理面试与雅思词汇合成事项在隔离页面完成快捷创建、自选草稿及 390px 布局检查。测试服务、数据库和构建目录已清理，默认业务库两类事项均为 0。真实第三方渠道的生成能力与个人使用效果未测。[本轮证据](quality/MVP-VERIFICATION.md#事项级模型选择隔离验收2026-09-27)。

2026-09-27 工作区与资料记忆二次重构同步：验证器通过 `OK: checked 19 Markdown file(s)`；本轮 [WS](quality/MVP-VERIFICATION.md#工作区与设置二次重构隔离验收2026-09-27) 与 [MT2](quality/MVP-VERIFICATION.md#资料与记忆二次重构隔离验收2026-09-27) 的混合/空隔离库、桌面/390px、键盘、改期及偏好操作、独立 QA 均完成。114/114 自动化、类型检查和隔离 webpack 生产构建通过；默认库仍保留 3 个内置角色、2 个预设 Agent、0 业务事项，`3205`/`3206` 服务和本轮三个隔离目录已清理。本轮合成成果与个人使用效率、真实模型质量不可混同。

2026-09-27 Agent 团队工作区同步：验证器通过 `OK: checked 19 Markdown file(s)`。已核对官方交互调研、AM7 行为、AT1 状态与本轮验收；114/114 自动化、类型检查、隔离 webpack 生产构建、默认与隔离页面通过。默认业务库未写入测试事项，隔离测试服务与目录已清理；个人操作效率待试用。[本轮证据](quality/MVP-VERIFICATION.md#agent-团队工作区改版2026-09-27)。

2026-09-27 空素材七日复测同步：验证器通过 `OK: checked 19 Markdown file(s)`。14 件隔离事项的资料栏全空，两条真实模型链到第 7 天；全隔离库 23 次调用（20 成功、3 失败），两道练习题待用户作答。生成时间预算与未核验词表提示已修正，后续定点调用通过；自测题仍出现内部矛盾，不能视为内容质量已验证。113/113 自动化、类型检查、隔离 webpack 构建通过，原业务库未用于本轮请求。[验收详情](quality/MVP-VERIFICATION.md#空素材七日复测2026-09-27)。

2026-09-27 快捷事项跨日接续同步：验证器通过 `OK: checked 19 Markdown file(s)`。已核对规格、计划、架构、运行手册、七日复验和索引的状态与边界：隔离库两条七日真实模型链到第 7 天，全库累计 27 次调用（24 成功、3 失败），练习作答为明确标记的模拟 QA；111/111 自动化、类型检查及隔离 webpack 构建通过。原业务库未用于此轮请求；个人实际效果仍待试用。[复验证据](quality/MVP-VERIFICATION.md#快捷事项跨日接续修复与七日复验2026-09-27)。

2026-09-27 七日隔离演练同步：验证器通过 `OK: checked 19 Markdown file(s)`；已核对场景的 14 件排期、8 次真实调用（6 成功、2 失败）、隔离数据与模拟作答的边界。顶部练习入口、首页排期焦点及 Agent 失败提示已在隔离页面复验；107 项回归、类型检查与独立 webpack 构建通过。跨天资料与练习来源仍是待定义缺口，详情见[七日演练](quality/MVP-VERIFICATION.md#面试与雅思词汇七日隔离演练2026-09-27)。

2026-09-27 聚焦式工作区同步：文档验证器通过 `OK: checked 18 Markdown file(s)`；已重读 UX 规格、架构、运行手册、计划、验收记录与索引，区分公开设计推断、隔离 mock 页面和个人真实效果。主任务 107/107、类型检查、隔离 webpack 构建及桌面/390px 页面走查通过；未触碰原业务库、原 `3000` 服务或 Git。证据见[UX 隔离验收](quality/MVP-VERIFICATION.md#聚焦式工作区隔离验收2026-09-27)。

2026-09-27 工作区日程与趋势最终同步：文档验证器通过 `OK: checked 17 Markdown file(s)`。已重读 PI 规格、实施计划、实际架构、运行手册、草图说明、验收记录和索引，核对“已确认 / 已实现 / 隔离验证 / 个人效果未验证”的界线。主任务回归 107/107、类型检查、隔离 webpack 构建与页面重启复验通过；逐块及最终独立 QA 无剩余可复现 P1/P2，细节见[本轮验收](quality/MVP-VERIFICATION.md#工作区日程与趋势增量验收2026-09-27)。原业务库四类主要记录只读核对为 0，没有 Git 或本轮真实模型调用。

2026-09-27 Agent 管理最终同步：文档验证器通过 `OK: checked 16 Markdown file(s)`。已重读规格、计划、架构、运行手册、验收记录和索引，核对同秒快照修复、独立 QA 与未覆盖边界。主任务回归 100/100、类型检查及隔离 webpack 构建通过；详细证据见[本轮验收](quality/MVP-VERIFICATION.md#agent-管理与跨事项接续隔离验收2026-09-27)。

以下较早记录保留当轮事实；其中“尚未实现”等旧状态不代表当前阶段，当前状态以页首和实施计划为准。

2026-09-27 Agent 管理增量前次同步：文档验证器通过 `OK: checked 16 Markdown file(s)`。当时仍待最终独立 QA/窄屏/重启证据，应用回归 97/97、类型检查和隔离 webpack 构建通过；当前状态见本节首条与[本轮验收](quality/MVP-VERIFICATION.md#agent-管理与跨事项接续隔离验收2026-09-27)。

2026-09-27 测试数据清理与真实 API 复验：一条虚构生活事项使用现有连接真实调用一次并完成启停、核对流程；随后按用户确认清空测试业务记录及已识别备份/临时模拟库。当前业务列表为空，预设 Agent 和连接保留；清理范围与检查见[本轮验收](quality/MVP-VERIFICATION.md#测试数据清理与一次真实-api-复验2026-09-27)。文档验证器通过 `OK: checked 15 Markdown file(s)`；已重读索引和本轮验收记录。

2026-09-27 七日审计 P1 修复：旧库补列前一致备份、隔离迁移和重复访问、七个逻辑日重放、暂停中结果保护、原 3000 本地开发服务迁移查验均通过；85/85 自动化、类型检查、隔离 webpack 构建及页面复验通过。修复前观察仍见[审计原记录与后续复验](quality/MULTIDAY-AUDIT.md)；跨日接续和真实内容效果未因此验证。文档验证器通过 `OK: checked 15 Markdown file(s)`，已重读本次规格、架构、计划、索引和质量记录。

2026-09-26 NR1—NR4 修复与集成收口：文档验证器通过 `OK: checked 13 Markdown file(s)`；当前 80/80 自动化、类型检查和隔离 webpack 生产构建通过。已重读索引、增量规格、计划与验收记录，核对修复状态与证据边界；逐块及最终只读 QA、主任务隔离页面和本机虚构资料真实调用证据见[验收记录](quality/MVP-VERIFICATION.md)。个人内容效果与长期运行仍待评估。

2026-09-26 自定义 Agent N1—N5 交付同步：文档验证器通过 `OK: checked 13 Markdown file(s)`；已重读索引、项目定义、增量规格、计划、架构、运行手册和验收记录，核对隔离实现与真实新链路待验边界。原源码 73/73、类型检查、独立 webpack 生产构建及主任务隔离页面走查通过；N1—N5 全新只读 QA 无剩余可复现 P1/P2，详情见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 新版滚动修正：桌面左侧导航与右侧内容分离滚动，窄屏保留整页滚动；切页回到顶部。原项目类型检查及隔离页面检查通过，见[验收记录](quality/MVP-VERIFICATION.md#新版桌面滚动修正2026-09-26)。外部 Agent 接入和自定义创建仍处于讨论阶段，未在本轮实现。

2026-09-26 RT 交付后独立复验同步：原审计主代理重放上轮合成场景，RT1—RT3 和陈旧完成提交保护通过；本轮 63/63、类型检查及文档检查通过。只补充验证证据，方法与未覆盖项见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 RT1—RT4 有界修复同步：验证器通过 `OK: checked 12 Markdown file(s)`；已重读规格、计划、架构、独立复测与验收记录，确认修复前观察仍作为历史保留、当前状态与隔离证据相符。原源码 63/63、类型检查、隔离生产构建及主代理页面复验通过；真实模型与长期运行边界仍按[验收记录](quality/MVP-VERIFICATION.md#rt1rt4-有界修复验收2026-09-26)区分。

2026-09-26 持续使用 C1—C5 交付同步：验证器通过 `OK: checked 12 Markdown file(s)`；已重读规格、计划、架构、运行手册、五日审计和验收记录，核对修复前发现、当前隔离 mock 结果与仍待个人真实效果评估的边界。代码检查 62/62、类型检查和隔离生产构建通过，详情见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 五日模拟审计同步：验证器通过 `OK: checked 12 Markdown file(s)`；已重读本轮审计报告并核对索引、计划入口，区分逻辑日 mock、既有真实调用和未修复的产品问题。本轮未改原应用代码或业务数据。

2026-09-26 新版真实模型验收同步：验证器通过 `OK: checked 11 Markdown file(s)`；已核对真实调用与旧隔离阶段的时间边界、架构中的 `max_tokens=2800`、计划状态和本轮未覆盖项。提示调整后 53/53 与类型检查通过，实测详情见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 新版 R1—R6 实现同步：验证器通过 `OK: checked 11 Markdown file(s)`；已重读索引、规格状态、计划、架构、运行手册和验收记录，核对“新版已实现”和“新版真实生成待验证”的区分。代码、逐块独立 QA 与模拟/页面证据见[验收记录](quality/MVP-VERIFICATION.md)。

### 历史检查记录

2026-09-26 新版认可与实现交接：验证器通过 `OK: checked 11 Markdown file(s)`；已重读新版规格和 R1—R6 计划，核对新旧规则优先关系、旧数据保护及逐块新 QA 要求。本轮只更新本地文档，没有 Git 操作，也未执行应用测试或模型调用；新版功能仍待实现验证。

2026-09-26 事项工作台重设计同步：检查通过 `OK: checked 10 Markdown file(s)`；本轮修改候选草图及设计、项目状态和计划，未修改应用代码或业务数据。草图交互、独立 QA 和未验证项见 [v0.4 验证记录](design/WIREFRAME.md#v04-验证记录)。

以下命令使用当前机器已安装的技能验证器，检查 Markdown 本地链接目标和模板占位符；不会验证产品功能，也不全面验证标题锚点或事实正确性，后者需要人工重读。

```sh
rtk proxy python3 /Users/wangjinlong/.codex/skills/project-lifecycle-docs/scripts/validate_docs.py /Users/wangjinlong/self_mutiAgent
```

迁移机器后需更新本机工具路径。应用命令见[运行手册](operations/RUNBOOK.md)；文档检查不能替代应用验收。

2026-09-26 首次建档验证：上述命令退出码为 0，输出 `OK: checked 3 Markdown file(s)`；已重读三份文档，确认当前实现状态、相对链接及标题锚点。项目根目录仍无 `.git`，没有应用功能测试可执行。

2026-09-26 草图阶段文档检查：退出码为 0，输出 `OK: checked 4 Markdown file(s)`。浏览器交互与布局的验证范围记录在 [草图说明](design/WIREFRAME.md#验证记录)。

2026-09-26 v0.3 主题更新检查：退出码为 0，输出 `OK: checked 5 Markdown file(s)`。主题行为与浏览器验证记录见 [草图说明](design/WIREFRAME.md#v03-主题检查)。

2026-09-26 界面基线确认与规格建档检查：退出码为 0，输出 `OK: checked 6 Markdown file(s)`；已重读规格及相关入口，区分界面认可、未决运行细节和未实现能力。本轮仅修改文档，未更改草图代码或重复运行浏览器检查。

2026-09-26 DeepSeek 接入规划检查：退出码为 0，输出 `OK: checked 8 Markdown file(s)`；已核对官方接口依据、规格与计划状态。本轮仅完善文档，没有安装依赖、保存密钥或调用模型；真实连接验收尚未执行。

2026-09-26 首版实现同步检查：退出码为 0，输出 `OK: checked 10 Markdown file(s)`；已重读阶段、规格、架构、计划、运行与验收入口。该检查只验证本地链接和占位符，产品检查见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 真实模型验收同步检查：退出码为 0，输出 `OK: checked 10 Markdown file(s)`；已核对实际调用记录、模型展示名与请求标识、阶段和计划状态，真实调用证据见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 今日控制入口检查：退出码为 0，输出 `OK: checked 10 Markdown file(s)`；已核对新建目标、暂停参与、预算与已完成任务的操作说明，代码验证见[验收记录](quality/MVP-VERIFICATION.md)。

2026-09-26 后续任务与运行边界检查：退出码为 0，输出 `OK: checked 10 Markdown file(s)`；已重读规格、计划、架构、运行和验收记录。代码与独立 QA 证据见[验收记录](quality/MVP-VERIFICATION.md)；个人目标效果尚未验证。

2026-09-26 适应性缺陷修复文档检查：退出码为 0，输出 `OK: checked 10 Markdown file(s)`；已核对方向与记忆排序规则的规格、架构、计划和验收记录。代码、独立 QA 与隔离生产检查边界见[验收记录](quality/MVP-VERIFICATION.md)。
