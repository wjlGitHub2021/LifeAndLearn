"use client";

import styles from "./WorkspaceSettings.module.css";
import ModelConnectionsPanel, { type ModelConnectionStatus } from "./ModelConnectionsPanel";

export type SettingsSection = "usage" | "appearance" | "connection" | "data" | "help";
export type SettingsDefaultView = "home" | "items" | "week";
export type SettingsCalendarMode = "week" | "month";
export type SettingsThemeMode = "neutral" | "color";
export type SettingsNeutral = "light" | "dark";
export type SettingsColor = "blue" | "green" | "sand";
export type SettingsDestination = "team" | "memory" | "items" | "week";

export type SettingsConnection = ModelConnectionStatus;

export type WorkspaceSettingsProps = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  defaultView: SettingsDefaultView;
  onDefaultViewChange: (view: SettingsDefaultView) => void;
  defaultCalendarMode: SettingsCalendarMode;
  onDefaultCalendarModeChange: (mode: SettingsCalendarMode) => void;
  themeMode: SettingsThemeMode;
  onThemeModeChange: (mode: SettingsThemeMode) => void;
  neutral: SettingsNeutral;
  onNeutralChange: (value: SettingsNeutral) => void;
  color: SettingsColor;
  onColorChange: (value: SettingsColor) => void;
  connection: SettingsConnection | null;
  keyInput: string;
  onKeyInputChange: (value: string) => void;
  onConnectionAction: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  notice: string;
  counts: { items: number; agents: number; preferences: number };
  onNavigate: (destination: SettingsDestination) => void;
  onClose: () => void;
};

const sections: { id: SettingsSection; title: string; detail: string }[] = [
  { id: "usage", title: "使用偏好", detail: "打开方式与日程" },
  { id: "appearance", title: "外观", detail: "明暗与主题色" },
  { id: "connection", title: "模型连接", detail: "渠道与默认模型" },
  { id: "data", title: "数据与隐私", detail: "本地记录与发送范围" },
  { id: "help", title: "使用说明", detail: "协作流程与入口" },
];

export default function WorkspaceSettings({
  section,
  onSectionChange,
  defaultView,
  onDefaultViewChange,
  defaultCalendarMode,
  onDefaultCalendarModeChange,
  themeMode,
  onThemeModeChange,
  neutral,
  onNeutralChange,
  color,
  onColorChange,
  connection,
  keyInput,
  onKeyInputChange,
  onConnectionAction,
  busy,
  notice,
  counts,
  onNavigate,
  onClose,
}: WorkspaceSettingsProps) {
  return <div className={styles.shell}>
    <div className={styles.heading}>
      <div>
        <span className={styles.eyebrow}>WORKSPACE SETTINGS</span>
        <h2 id="settings-title">设置</h2>
        <p>安排你使用工作区的方式，并查看模型和本地数据的边界。</p>
      </div>
      <button type="button" className={styles.close} onClick={onClose} aria-label="关闭设置">关闭</button>
    </div>

    <div className={styles.layout}>
      <nav className={styles.navigation} aria-label="设置分类">
        {sections.map(entry => <button
          key={entry.id}
          type="button"
          className={styles.navItem}
          aria-pressed={section === entry.id}
          onClick={() => onSectionChange(entry.id)}
        >
          <strong>{entry.title}</strong>
          <span>{entry.detail}</span>
        </button>)}
      </nav>

      <div className={styles.content}>
        {section === "usage" && <section aria-labelledby="settings-usage-title">
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>PERSONAL WORKFLOW</span>
            <h3 id="settings-usage-title">使用偏好</h3>
            <p>这些选择只改变页面打开方式，不会自动运行 Agent 或修改事项。</p>
          </div>
          <div className={styles.settingBlock}>
            <h4>默认打开页面</h4>
            <p>下次打开工作区时先看到这里。</p>
            <div className={styles.choiceGrid} role="group" aria-label="默认打开页面">
              {([
                ["home", "工作台", "先处理眼前一步"],
                ["items", "我的事项", "查看待办与历史"],
                ["week", "日程与数据", "从日期查看安排"],
              ] as const).map(([value, title, detail]) => <button key={value} type="button" className={styles.choice} aria-pressed={defaultView === value} onClick={() => onDefaultViewChange(value)}><strong>{title}</strong><span>{detail}</span></button>)}
            </div>
          </div>
          <div className={styles.settingBlock}>
            <h4>日程默认视图</h4>
            <p>进入「日程与数据」时显示周或月；日期和事项本身不变。</p>
            <div className={styles.choiceRow} role="group" aria-label="日程默认视图">
              <button type="button" aria-pressed={defaultCalendarMode === "week"} onClick={() => onDefaultCalendarModeChange("week")}>周视图</button>
              <button type="button" aria-pressed={defaultCalendarMode === "month"} onClick={() => onDefaultCalendarModeChange("month")}>月视图</button>
            </div>
          </div>
        </section>}

        {section === "appearance" && <section aria-labelledby="settings-appearance-title">
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>APPEARANCE</span>
            <h3 id="settings-appearance-title">外观</h3>
            <p>明暗与主题色两种模式互斥，各自会记住上次选择。</p>
          </div>
          <div className={styles.settingBlock}>
            <h4>显示模式</h4>
            <div className={styles.choiceRow} role="group" aria-label="显示模式">
              <button type="button" aria-pressed={themeMode === "neutral"} onClick={() => onThemeModeChange("neutral")}>明暗主题</button>
              <button type="button" aria-pressed={themeMode === "color"} onClick={() => onThemeModeChange("color")}>主题色</button>
            </div>
          </div>
          {themeMode === "neutral" ? <div className={styles.settingBlock}>
            <h4>明暗选择</h4>
            <div className={styles.choiceRow} role="group" aria-label="明暗选择">
              <button type="button" aria-pressed={neutral === "light"} onClick={() => onNeutralChange("light")}>浅色</button>
              <button type="button" aria-pressed={neutral === "dark"} onClick={() => onNeutralChange("dark")}>深色</button>
            </div>
          </div> : <div className={styles.settingBlock}>
            <h4>配色选择</h4>
            <div className={styles.choiceRow} role="group" aria-label="配色选择">
              {([ ["blue", "雾蓝"], ["green", "松绿"], ["sand", "暖棕"] ] as const).map(([value, title]) => <button key={value} type="button" aria-pressed={color === value} onClick={() => onColorChange(value)}>{title}</button>)}
            </div>
          </div>}
        </section>}

        {section === "connection" && <ModelConnectionsPanel connection={connection} keyInput={keyInput} onKeyInputChange={onKeyInputChange} onAction={onConnectionAction} busy={busy} notice={notice} />}

        {section === "data" && <section aria-labelledby="settings-data-title">
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>LOCAL DATA & PRIVACY</span>
            <h3 id="settings-data-title">数据与隐私</h3>
            <p>以下数量来自当前本地工作区，用于查看数据范围。</p>
          </div>
          <div className={styles.countGrid}>
            <div><strong>{counts.items}</strong><span>事项</span></div>
            <div><strong>{counts.agents}</strong><span>Agent 实例</span></div>
            <div><strong>{counts.preferences}</strong><span>长期偏好</span></div>
          </div>
          <div className={styles.settingBlock}>
            <h4>保存在本机</h4>
            <p>事项、成果、运行记录、Agent 配置及明确保存的偏好留在本机应用数据中，刷新或重启后仍可读取。显示偏好保存在当前浏览器。</p>
          </div>
          <div className={styles.settingBlock}>
            <h4>何时发送给模型渠道</h4>
            <p>连接验证只向所选渠道请求模型列表，不发送事项资料。只有你启动模型运行时，当前事项获准的输入和你明确关联的来源快照才会发送给该 Agent 选定的渠道；不会扫描本机文件或上传整个数据库。</p>
          </div>
          <div className={styles.settingBlock}>
            <h4>到原位置管理</h4>
            <p>Agent 的职责与资料权限在团队页调整；长期偏好和明确纠正在「资料与记忆」中查看，资料修改回到所属事项。</p>
            <div className={styles.actions}>
              <button type="button" onClick={() => onNavigate("team")}>前往 Agent 团队</button>
              <button type="button" onClick={() => onNavigate("memory")}>前往资料与记忆</button>
            </div>
          </div>
          <p className={styles.boundary}>当前没有站内导入、导出、备份或清除数据功能。</p>
        </section>}

        {section === "help" && <section aria-labelledby="settings-help-title">
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>HOW IT WORKS</span>
            <h3 id="settings-help-title">使用说明</h3>
            <p>从具体的学习或生活事项开始，Agent 只在你明确启动时运行。</p>
          </div>
          <ol className={styles.steps}>
            <li><strong>写下要推进的事</strong><span>可以先保存事项，再补资料、选择参与 Agent 和安排日期。</span></li>
            <li><strong>确认协作范围后启动</strong><span>预设或自选 Agent 按所选步骤工作；未连接模型时仍能查看本地记录。</span></li>
            <li><strong>核对成果并纠正</strong><span>确认事实、提交真实练习或明确纠正；来源和历史保留在所属事项中。</span></li>
          </ol>
          <div className={styles.settingBlock}>
            <h4>直接前往</h4>
            <div className={styles.actions}>
              <button type="button" onClick={() => onNavigate("items")}>我的事项</button>
              <button type="button" onClick={() => onNavigate("week")}>日程与数据</button>
              <button type="button" onClick={() => onNavigate("team")}>Agent 团队</button>
              <button type="button" onClick={() => onNavigate("memory")}>资料与记忆</button>
            </div>
          </div>
        </section>}
      </div>
    </div>
  </div>;
}
