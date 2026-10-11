import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { readEditor, writeEditor } from './skillEditorDom';
import type { ComposerText } from './types';

/** Ghost text never enters the editable DOM or the draft until an unmodified Tab accepts it. */
export function useSuggestionInput(options: {
  editor: RefObject<HTMLDivElement>; text?: string; value: ComposerText; enabled: boolean;
  onChange: (value: ComposerText) => void; onUserInput?: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [dismissed, setDismissed] = useState<string | undefined>();
  useEffect(() => { setDismissed(undefined); }, [options.text]);
  const text = options.enabled && !options.value.text && !options.value.mentions.length
    && dismissed !== options.text ? options.text ?? '' : '';
  const dismiss = () => {
    setDismissed(latest.current.text);
    latest.current.onUserInput?.();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !text) return false;
    const node = options.editor.current;
    if (!node || readEditor(node).text || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    event.preventDefault();
    // Native insertion retains undo where available; DOM fallback supports embedded editors and tests.
    node.focus();
    if (!document.execCommand?.('insertText', false, text)) writeEditor(node, { text, mentions: [] });
    const range = document.createRange();
    range.selectNodeContents(node); range.collapse(false);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    options.onChange({ text, mentions: [] });
    dismiss();
    return true;
  };
  return { text, dismiss, keyDown };
}
