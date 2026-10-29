import type { LoungeAccount } from './types';

export interface LoungeComposerHandle { mention: (user: LoungeAccount) => void }

/** Mentions use the public identifier, never an owner's private contact remark. */
export function loungeMention(user: LoungeAccount) { return `@${user.account} `; }
