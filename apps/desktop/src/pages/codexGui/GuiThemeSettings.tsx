import { guiText } from "../../i18n/guiText";
import { useState } from "react";
import { Button, ColorPicker, Segmented, Switch, theme } from "antd";
import { Monitor, Moon, Sun } from "lucide-react";
import { DEFAULT_GUI_THEME, saveGuiTheme, useGuiTheme, type GuiTheme } from "./guiTheme";
import styles from "./GuiThemeSettings.module.less";

const THEME_MODES = [{ value: "inherit", label: "跟随应用", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun }, { value: "dark", label: "深色", icon: Moon }] as const;

export function GuiThemeSettings() {
  const settings = useGuiTheme();
  const { token } = theme.useToken();
  const [error, setError] = useState("");
  const update = (patch: Partial<GuiTheme>) => {
    setError(saveGuiTheme(patch) ? "" : guiText("主题未保存，请重试。"));
  };
  return <section className={styles.panel} aria-label={guiText("主题设置")}>
    <div className={styles.card}>
    <h3>{guiText("外观")}</h3>
    <p className={styles.hint}>{guiText("为 Codex GUI 选择喜欢的外观，更改后自动保存。")}</p>
    <Segmented<GuiTheme["mode"]> className={styles.modes} block
      aria-label={guiText("Codex GUI 外观")} value={settings.mode}
      options={THEME_MODES.map(({ value, label, icon: Icon }) => ({ value,
        label: <div className={styles.mode} data-mode={value}>
          <div className={styles.miniWindow} aria-hidden="true"><i /><div><b /><b /><b /></div></div>
          <span><Icon size={15} aria-hidden="true" />{guiText(label)}</span>
        </div> }))} onChange={(mode) => update({ mode })} />
    </div>
    <div className={styles.card}>
    <h3>{guiText("主题色")}</h3>
    <div className={styles.controls}>
      <label htmlFor="gui-theme-color-inherit">{guiText("跟随应用主题色")}</label>
      <Switch id="gui-theme-color-inherit" size="small" checked={settings.color === null}
        onChange={(inherit) => update({ color: inherit ? null : token.colorPrimary })} />
      <ColorPicker value={settings.color ?? token.colorPrimary} disabled={settings.color === null}
        showText disabledAlpha format="hex" onChangeComplete={(color) => update({ color: color.toHexString() })} />
    </div>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.preview} aria-label={guiText("主题预览")}>
      <div className={styles.sidebar}><strong>Codex GUI</strong><span>{guiText("新的对话")}</span></div>
      <div className={styles.conversation}>
        <span className={styles.caption}><span className={styles.previewDot} />{guiText("预览")}</span>
        <p>{guiText("你好，今天想一起完成什么？")}</p>
        <div className={styles.reply}>{guiText("一起把想法变成现实。")}</div>
        <div className={styles.composer}><span>{guiText("输入你的想法…")}</span><span className={styles.send}>↑</span></div>
      </div>
    </div>
    <Button onClick={() => update(DEFAULT_GUI_THEME)}
      disabled={settings.mode === "inherit" && settings.color === null}>{guiText("恢复默认")}</Button>
  </section>;
}
