import { guiText } from "../../i18n/guiText";
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type KeyboardEvent } from "react";
import type { ComposerText, GuiState, Skill } from "./types";
import type { AttachmentReference } from "./attachmentTypes";
import { conversationCandidates, conversationReference } from "./conversationReferences";
import { useConversationCandidates } from "./useConversationCandidates";
import { insertSkill, readEditor, skillTrigger, writeEditor } from "./skillEditorDom";
import { composerOptions, type CompactCommand, type ComposerOption, type GoalCommand } from "./composerOptions";
import type { SkillTrigger } from "./skillEditorDom";
import { useComposerSkills } from "./useComposerSkills";
import { useComposerCoze } from "./useComposerCoze";
import { SkillMenu } from "./SkillMenu";
import { useSuggestionInput } from './useSuggestionInput';
import styles from "./SkillInput.module.less";
import { readPastedContent } from "../../../../../shared/chat/clipboard";

export interface SkillInputHandle { addSkill: (skill: Skill) => void; focus: () => void }

function focusEditor(node: HTMLDivElement, saved: Range | null): Range {
  const range = saved && node.contains(saved.startContainer) && node.contains(saved.endContainer)
    ? saved.cloneRange() : document.createRange();
  if (!node.contains(range.startContainer)) { range.selectNodeContents(node); range.collapse(false); }
  node.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

export const SkillInput = forwardRef<SkillInputHandle, {
  value: ComposerText; draftKey: string; cwd: string; active: boolean; connected: boolean; disabled: boolean;
  placeholder: string; onChange: (value: ComposerText) => void;
  suggestion?: string; onUserInput?: () => void;
  compact?: CompactCommand;
  goal?: GoalCommand;
  conversations?: Pick<GuiState, "selected" | "threads" | "conversations">;
  onConversation?: (reference: AttachmentReference) => void;
  onCoze?: (reference: AttachmentReference) => void;
  editing?: { onCancel: () => void; className: string };
  onPaste: (event: ClipboardEvent<HTMLElement>) => void; onSend: () => void;
  onPasteKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}>(function SkillInput({ value, draftKey, cwd, active, connected, disabled, placeholder,
  compact, goal, conversations, onConversation, onCoze, editing, onChange, onPaste, onPasteKeyDown, onSend,
  suggestion, onUserInput }, ref) {
  const editor = useRef<HTMLDivElement>(null);
  const savedCaret = useRef<Range | null>(null);
  const composing = useRef(false);
  const [trigger, setTrigger] = useState<SkillTrigger | null>(null);
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const isConversation = trigger?.kind === "conversation";
  const isCoze = trigger?.kind === "coze";
  const open = Boolean(trigger) && active && !disabled && (!isConversation || Boolean(onConversation))
    && (!isCoze || Boolean(onCoze));
  const ghost = useSuggestionInput({ editor, value, text: suggestion,
    enabled: active && connected && !disabled && !open && !editing, onChange, onUserInput });
  const catalog = useComposerSkills({ cwd, active: open && !isConversation && !isCoze, connected });
  const coze = useComposerCoze(open && isCoze && connected);
  const query = trigger?.query.toLocaleLowerCase() ?? "";
  const candidates = useConversationCandidates({ active: open && isConversation, connected, query });
  const cozeOptions: ComposerOption[] = coze.items
    .filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ kind: "coze", key: item.id, label: item.name,
      description: item.description || "已发布的 Coze 内容", enabled: true,
      command: { enabled: true, run: () => onCoze?.({ kind: "coze", name: item.name, path: `coze://${item.id}` }) } }));
  let options: ComposerOption[] = composerOptions(catalog.skills, query, compact, goal);
  if (isConversation) options = conversationCandidates({ remote: candidates.threads,
    known: conversations?.threads ?? [], conversations: conversations?.conversations ?? {},
    currentId: conversations?.selected ?? null, query }).map((thread) => ({ kind: "conversation", key: thread.id,
      label: conversationReference(thread).name, enabled: true,
      description: guiText("{value1} · {value2}", { value1: thread.status?.type === "active" ? "运行中" : "空闲", value2: thread.cwd || "未选择项目" }),
      command: { enabled: true, run: () => onConversation?.(conversationReference(thread)) },
    }));
  if (isCoze) options = cozeOptions;
  let menuState: { loading: boolean; error: string } = catalog;
  if (isConversation) menuState = candidates;
  if (isCoze) menuState = coze;
  const selectedIndex = Math.min(selected, Math.max(0, options.length - 1));

  useLayoutEffect(() => {
    const node = editor.current;
    if (node && JSON.stringify(readEditor(node)) !== JSON.stringify({ text: value.text, mentions: value.mentions })) {
      writeEditor(node, value);
      savedCaret.current = null;
    }
  }, [value]);
  useLayoutEffect(() => { setTrigger(null); savedCaret.current = null; }, [draftKey, cwd, disabled, active]);

  useImperativeHandle(ref, () => ({ focus: () => {
    if (editor.current && active && !disabled) focusEditor(editor.current, savedCaret.current);
    setTrigger(null);
  }, addSkill: (skill) => {
    const node = editor.current;
    if (!node || disabled || !active || !connected || !skill.enabled) return;
    const range = focusEditor(node, savedCaret.current);
    insertSkill({ query: "", range }, skill);
    ghost.dismiss();
    onChange(readEditor(node));
    setTrigger(null);
  } }));

  const inspect = () => {
    if (!editor.current || composing.current) return;
    const next = skillTrigger(editor.current);
    setTrigger(next);
    if (next?.query !== trigger?.query || next?.kind !== trigger?.kind) setSelected(0);
  };
  const change = () => {
    if (!editor.current) return;
    ghost.dismiss();
    onChange(readEditor(editor.current));
    inspect();
  };
  const choose = (option: ComposerOption) => {
    if (!trigger || !editor.current || !option.enabled) return;
    editor.current.focus();
    if (option.kind === "skill") insertSkill(trigger, option.skill);
    else trigger.range.deleteContents();
    change();
    setTrigger(null);
    if (option.kind !== "skill") option.command.run();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !active) return;
    onPasteKeyDown?.(event);
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!open && ghost.keyDown(event)) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey
      || ['Backspace', 'Delete', 'Escape'].includes(event.key)) ghost.dismiss();
    const menuKey = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key);
    if (open && menuKey && !(event.key === "Enter" && event.shiftKey)) {
      event.preventDefault();
      if (event.key === "Escape") setTrigger(null);
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((selectedIndex + step + options.length) % (options.length || 1));
      } else if (options[selectedIndex]?.enabled) choose(options[selectedIndex]);
      return;
    }
    if (event.key === "Escape" && editing) { event.preventDefault(); editing.onCancel(); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey || (editing && !event.ctrlKey && !event.metaKey)) {
      document.execCommand("insertLineBreak"); change();
    }
    else onSend();
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled || !active) { event.preventDefault(); return; }
    ghost.dismiss();
    onPaste(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    // Plain-text insertion preserves the browser's editing history and strips pasted HTML.
    document.execCommand("insertText", false, readPastedContent(event.clipboardData).text);
    change();
  };
  return <div className={styles.inputWrap}>
    {open && <SkillMenu id={listId} options={options} selected={selectedIndex}
      loading={menuState.loading} error={menuState.error}
      conversations={isConversation} coze={isCoze}
      onChoose={choose} below={Boolean(editing)}
      skillsOnly={!compact && !goal} />}
    {ghost.text && <div className={styles.suggestion} data-testid="next-prompt-suggestion">
      <span>{ghost.text}</span><kbd aria-hidden="true">Tab</kbd>
      <button type="button" aria-label={guiText('填入建议')}
        onPointerDown={event => event.preventDefault()} onClick={ghost.accept}>{guiText('填入')}</button>
    </div>}
    <div ref={editor} role="textbox" aria-label={editing ? guiText("编辑消息内容") : guiText("消息")}
      aria-multiline="true" aria-disabled={disabled}
      aria-autocomplete="list" aria-controls={open ? listId : undefined}
      aria-activedescendant={open && options.length ? `${listId}-${selectedIndex}` : undefined}
      className={`${styles.editor} ${editing?.className ?? ""}`} contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={ghost.text ? '' : placeholder} data-empty={!value.text}
      onBeforeInput={ghost.dismiss} onInput={change} onKeyDown={keyDown}
      onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) inspect(); }}
      onClick={inspect} onBlur={() => {
        const selection = window.getSelection();
        savedCaret.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        setTrigger(null);
      }} onPaste={paste} onDrop={(event) => event.preventDefault()}
      onCompositionStart={() => { ghost.dismiss(); composing.current = true; setTrigger(null); }}
      onCompositionEnd={() => { composing.current = false; change(); }} />
  </div>;
});
