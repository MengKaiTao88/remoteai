import { guiText } from "../../i18n/guiText";
import { useEffect, useRef } from "react";
import { GitBranch, MessageSquare, Target } from "lucide-react";
import { ComposerSkillIcon } from "./ComposerSkillIcon";
import type { ComposerOption } from "./composerOptions";
import styles from "./SkillInput.module.less";

function menuLabels(kind: "coze" | "conversation" | "skill" | "command") {
  if (kind === "coze") return { heading: "选择 Coze 内容", label: "Coze", loading: "正在加载 Coze 内容…",
    empty: "没有匹配的已发布内容，请先在 Coze 中发布。" };
  if (kind === "conversation") return { heading: guiText("引用对话 · 发送时带上近期内容"), label: guiText("对话"),
    loading: guiText("正在加载对话…"), empty: guiText("没有找到其他对话，试试输入对话名称") };
  if (kind === "skill") return { heading: guiText("选择技能"), label: guiText("技能"),
    loading: guiText("正在加载技能…"), empty: guiText("没有找到匹配的技能") };
  return { heading: guiText("选择命令或技能"), label: guiText("命令和技能"),
    loading: guiText("正在加载技能…"), empty: guiText("没有找到匹配的命令或技能") };
}

function OptionIcon({ option }: { option: ComposerOption }) {
  if (option.kind === "skill") return <ComposerSkillIcon skill={option.skill} />;
  if (option.kind === "coze") return <GitBranch size={18} aria-hidden="true" />;
  if (option.kind === "conversation") return <MessageSquare size={18} aria-hidden="true" />;
  if (option.kind === "goal") return <Target size={18} aria-hidden="true" />;
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity=".25" />
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" pathLength="100"
      strokeDasharray={`${option.command.percent ?? 0} 100`} transform="rotate(-90 8 8)" />
  </svg>;
}

export function SkillMenu({ id, options, selected, loading, error, onChoose, below, skillsOnly, conversations, coze }: {
  id: string; options: ComposerOption[]; selected: number; loading: boolean; error: string;
  onChoose: (option: ComposerOption) => void;
  below?: boolean; skillsOnly?: boolean; conversations?: boolean; coze?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  let kind: Parameters<typeof menuLabels>[0] = skillsOnly ? "skill" : "command";
  if (conversations) kind = "conversation";
  if (coze) kind = "coze";
  const labels = menuLabels(kind);
  return <div className={`${styles.menu} ${below ? styles.menuBelow : ""}`}
    onMouseDown={(event) => event.preventDefault()}>
    <div className={styles.menuHeading}>{labels.heading}</div>
    <div ref={list} id={id} role="listbox" aria-label={labels.label}
      className={styles.options}>
      {options.map((option, index) => <button type="button" role="option" id={`${id}-${index}`}
        key={`${option.kind}-${option.key}`} tabIndex={-1}
        aria-selected={selected === index} aria-disabled={!option.enabled}
        onClick={() => option.enabled && onChoose(option)}>
        <OptionIcon option={option} />
        <span><strong>{option.label}{option.kind === "skill" && !option.enabled && guiText("（已停用）")}</strong>
          <small>{option.description}</small></span>
      </button>)}
    </div>
    {loading && <p role="status">{labels.loading}</p>}
    {error && <p role="status">{error}</p>}
    {!loading && !error && !options.length && <p role="status">{labels.empty}</p>}
  </div>;
}
