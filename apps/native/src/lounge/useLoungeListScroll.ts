import { useRef, type RefObject } from 'react';
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { MobileLounge } from '../../../../shared/lounge/useMobileLounge';
import type { LoungeMessage } from '../../../../shared/lounge/types';

const RESTORE_TOLERANCE = 1;

/** Keep the saved offset until virtualized rows can actually restore it. */
export function useLoungeListScroll({ list, model, reveal }: {
  list: RefObject<FlatList<LoungeMessage> | null>; model: MobileLounge; reveal: () => void;
}) {
  const restore = useRef<{ key: string; offset: number | null }>({ key: '', offset: null });
  const key = `${model.chats}:${model.state.conversation}`;
  if (restore.current.key !== key) {
    restore.current = { key, offset: model.atBottom || model.navigation.focus ? null
      : model.offsets.current.get(model.state.conversation) ?? null };
  }
  const restorePosition = () => {
    if (model.navigation.focus) restore.current.offset = null;
    const offset = restore.current.offset;
    if (offset === null) return false;
    list.current?.scrollToOffset({ offset, animated: false });
    return true;
  };
  const follow = () => {
    if (!restorePosition() && model.atBottom) list.current?.scrollToOffset({ offset: 0, animated: false });
  };
  const onContentSizeChange = () => {
    if (model.navigation.highlight) reveal();
    else follow();
  };
  const onLayout = ({ nativeEvent: event }: LayoutChangeEvent) => {
    const offset = restore.current.offset ?? model.offsets.current.get(model.state.conversation) ?? 0;
    if (!model.navigation.focus) list.current?.scrollToOffset({ offset, animated: false });
    model.updateScrollPosition(offset, event.layout.height);
  };
  const onScroll = ({ nativeEvent: event }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const pending = restore.current.offset;
    if (pending !== null && Math.abs(event.contentOffset.y - pending) > RESTORE_TOLERANCE) return;
    restore.current.offset = null;
    model.updateScrollPosition(event.contentOffset.y, event.layoutMeasurement.height);
  };
  const onScrollBeginDrag = () => { restore.current.offset = null; };
  const latest = () => {
    restore.current.offset = null;
    model.latest(); list.current?.scrollToOffset({ offset: 0, animated: true });
  };
  return { follow, onContentSizeChange, onLayout, onScroll, onScrollBeginDrag, latest };
}
