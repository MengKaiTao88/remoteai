import { guiText } from "../../i18n/guiText";
import { useState } from "react";
import { Button, Grid, Modal, Tabs } from "antd";
import { ArrowLeftRight, Circle, Image, MessageSquareText, Palette, Settings2, Type } from "lucide-react";
import type { Account, Provider } from "../../types";
import { useGuiAutoSwitchSettings } from "./useGuiAutoSwitchSettings";
import { GuiAutoSwitchPanel } from "./GuiAutoSwitchPanel";
import { GuiAppearanceSettings } from "./GuiAppearanceSettings";
import { GuiThemeSettings } from "./GuiThemeSettings";
import { GuiSkinSettings } from "./GuiSkinSettings";
import { GuiSystemPromptSettings } from "./GuiSystemPromptSettings";
import styles from "./GuiAutoSwitchSettingsDialog.module.less";

const sections = [
  { key: "accounts", label: "自动切号", icon: ArrowLeftRight },
  { key: "appearance", label: "界面", icon: Type },
  { key: "theme", label: "主题", icon: Palette },
  { key: "skin", label: "皮肤", icon: Image },
  { key: "systemPrompts", label: "系统提示词", icon: MessageSquareText },
] as const;

type Props = { accounts: Account[]; providers: Pick<Provider, "id" | "name">[];
  privacyMode: boolean; onClose: () => void };

export function GuiAutoSwitchSettingsDialog({ accounts, providers, privacyMode, onClose }: Props) {
  const editor = useGuiAutoSwitchSettings();
  const screens = Grid.useBreakpoint();
  const [tab, setTab] = useState("accounts");
  const save = async () => {
    if (await editor.save(accounts.map((account) => account.id))) onClose();
    else setTab("accounts");
  };
  const panels = {
    accounts: <GuiAutoSwitchPanel editor={editor} accounts={accounts} providers={providers} privacyMode={privacyMode} />,
    appearance: <GuiAppearanceSettings />,
    theme: <GuiThemeSettings />,
    skin: tab === "skin" && <GuiSkinSettings />,
    systemPrompts: <GuiSystemPromptSettings />,
  };
  return <Modal open centered width="min(1240px, calc(100vw - 48px))" className={styles.dialog}
    title={<div className={styles.title}><span className={styles.titleIcon}><Settings2 size={21} /></span>
      <div><span>{guiText("Codex GUI 设置")}</span><p>{guiText("按你的习惯调整 Codex GUI。")}</p></div></div>}
    onCancel={onClose} closable={!editor.saving} maskClosable={!editor.saving} keyboard={!editor.saving}
    footer={<div className={styles.footer}>
      <span className={styles.saveHint} data-dirty={editor.dirty}>
        <Circle size={7} fill="currentColor" aria-hidden="true" />
        {guiText(editor.dirty ? "账号设置有未保存的更改" : tab === "accounts"
          ? "账号设置修改后，点击保存生效" : "此页修改会自动保存")}</span>
      <div>{tab !== "accounts" && !editor.dirty ? <Button onClick={onClose}>{guiText("完成")}</Button> : <>
        <Button disabled={editor.saving} onClick={onClose}>{guiText("取消")}</Button>
        <Button type="primary" loading={editor.saving} disabled={editor.loading || !editor.settings}
          onClick={() => void save()}>{guiText("保存")}</Button>
      </>}</div>
    </div>}>
    <Tabs activeKey={tab} onChange={setTab} tabPosition={screens.md ? "left" : "top"} className={styles.tabs}
      items={sections.map(({ key, label, icon: Icon }) => ({ key, disabled: editor.saving,
        label: <span className={styles.navLabel}><Icon size={17} strokeWidth={1.7} aria-hidden="true" />
          {guiText(label)}</span>,
        children: <div className={styles.section}>
          <div className={styles.sectionBody}>{panels[key]}</div>
        </div>,
      }))} />
  </Modal>;
}
