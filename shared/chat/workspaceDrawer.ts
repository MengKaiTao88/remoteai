import { createContext } from 'react';

/** Internal drawers stay within their owning conversation, including remote workspaces. */
export const WorkspaceDrawerContext = createContext<{
  host: HTMLDivElement | null;
  active: boolean;
  reserve: (width: number) => void;
} | null>(null);
