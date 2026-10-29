import { beforeEach, expect, it, vi } from 'vitest';
import type { FlatList } from 'react-native';
import type { LoungeMessage } from '../../../../shared/lounge/types';
import type { MobileLounge } from '../../../../shared/lounge/useMobileLounge';
import { useLoungeListScroll } from './useLoungeListScroll';

const refs = vi.hoisted(() => ({ current: { key: '', offset: null as number | null } }));
vi.mock('react', () => ({ useRef: () => refs }));
const scrollToOffset = vi.fn();
const list = { current: { scrollToOffset } as unknown as FlatList<LoungeMessage> };
const updateScrollPosition = vi.fn();
const reveal = vi.fn();
let model: MobileLounge;
const render = () => useLoungeListScroll({ list, model, reveal });
const event = (offset: number) => ({ nativeEvent: { contentOffset: { y: offset },
  layoutMeasurement: { height: 600 } } } as Parameters<ReturnType<typeof render>['onScroll']>[0]);

beforeEach(() => {
  refs.current = { key: '', offset: null };
  vi.clearAllMocks();
  model = { chats: false, state: { conversation: 'bob' }, atBottom: false,
    offsets: { current: new Map([['bob', 900]]) }, navigation: {}, updateScrollPosition, latest: vi.fn(),
  } as unknown as MobileLounge;
});

it('ignores clamped mount events until the virtualized list restores the saved position', () => {
  const scroll = render();
  scroll.onScroll(event(0));
  scroll.onContentSizeChange();
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 900, animated: false });
  scroll.onScroll(event(350));
  expect(updateScrollPosition).not.toHaveBeenCalled();
  scroll.onContentSizeChange();
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 900, animated: false });
  scroll.onScroll(event(900));
  expect(updateScrollPosition).toHaveBeenLastCalledWith(900, 600);
  scrollToOffset.mockClear(); scroll.onContentSizeChange();
  expect(scrollToOffset).not.toHaveBeenCalled();
});

it('lets a reader cancel restoration and returns directly to the latest message on request', () => {
  const scroll = render();
  scroll.onScrollBeginDrag(); scroll.onScroll(event(300));
  expect(updateScrollPosition).toHaveBeenLastCalledWith(300, 600);
  scroll.latest();
  expect(model.latest).toHaveBeenCalledOnce();
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: true });
});

it('follows content growth only at the bottom and keeps history focus available', () => {
  model.atBottom = true;
  render().onContentSizeChange();
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  scrollToOffset.mockClear();
  model.atBottom = false; model.navigation.highlight = 'original';
  render().onContentSizeChange();
  expect(reveal).toHaveBeenCalledOnce();
  expect(scrollToOffset).not.toHaveBeenCalled();
});
