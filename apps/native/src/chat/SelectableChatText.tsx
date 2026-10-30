import { useContext, useEffect, useRef } from 'react';
import { DeviceEventEmitter, findNodeHandle, Text,
  type GestureResponderHandlers, type TextProps } from 'react-native';
import { QuoteSourceContext, useChatQuotes } from './ChatQuotes';
import { CopyTextButton, type CopyAction } from './CopyTextButton';
import { nativeTextSelection as bridge } from './nativeTextSelection';
import { useChatTextLayout } from './useChatTextLayout';

export function SelectableChatText({ onLayout, children, copy, layoutKey, ...props }: TextProps & {
  copy?: CopyAction | CopyAction[];
  /** Stable source identity for rich text whose JSX is recreated during an unrelated render. */
  layoutKey?: unknown;
}) {
  const actions = copy ? Array.isArray(copy) ? copy : [copy] : [];
  const ref = useRef<Text>(null);
  const layout = useChatTextLayout(ref, layoutKey ?? children);
  const source = useContext(QuoteSourceContext);
  const quotes = useChatQuotes();
  const enabled = Boolean(source && quotes?.enabled);
  const quote = useRef({ source, add: quotes?.add });
  quote.current = { source, add: quotes?.add };
  useEffect(() => {
    const tag = findNodeHandle(ref.current);
    if (tag) bridge?.configure(tag, enabled, actions.length);
  }, [enabled, actions.length]);
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('chatTextQuote', (event: { tag: number; text: string }) => {
      if (event.tag !== findNodeHandle(ref.current) || typeof event.text !== 'string') return;
      const { source: current, add } = quote.current;
      if (current && add?.({ messageId: current.messageId, role: current.role, text: event.text })) current.onQuote?.();
    });
    const tag = findNodeHandle(ref.current);
    return () => { subscription.remove(); if (tag) bridge?.detach(tag); };
  }, []);
  const configure = () => {
    const tag = findNodeHandle(ref.current);
    if (tag) bridge?.configure(tag, enabled, actions.length);
  };
  // RN 0.79 Text forwards this responder callback, although its TextProps declaration omits it.
  const responder: Pick<GestureResponderHandlers, 'onStartShouldSetResponder'> = { onStartShouldSetResponder: () => {
    // Fabric can emit layout before a clipped/streaming TextView exists. A touched view is already mounted.
    configure();
    return false;
  } };
  return <Text {...props} {...responder} ref={ref} selectable
    // A fixed height also constrains Fabric's intrinsic width measurement and can start a resize loop.
    style={[props.style, layout.height === undefined ? undefined : { height: 'auto', minHeight: layout.height }]}
    onLayout={(event) => {
      layout.onLayout(event);
      configure();
      onLayout?.(event);
    }}>{children}{actions.map((action) => <CopyTextButton key={action.label} {...action} />)}</Text>;
}
