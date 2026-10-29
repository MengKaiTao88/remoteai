export function messageMenuActions({ direct, block, blocked }: {
  direct?: () => void; block?: () => void; blocked?: boolean;
}) {
  return [
    { key: 'copy', label: 'client.lounge.copyMessage' },
    { key: 'reply', label: 'client.lounge.quoteReply' },
    ...(direct ? [{ key: 'direct', label: 'client.lounge.directChat' } as const] : []),
    ...(block ? [{ key: 'block', label: blocked ? 'client.lounge.unblockUser' : 'client.lounge.blockUser' } as const] : []),
  ] as const;
}
