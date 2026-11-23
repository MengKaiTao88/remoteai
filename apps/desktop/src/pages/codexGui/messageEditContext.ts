import { createContext } from "react";
import type { SkillsResponse } from '../../../../../shared/conversation/types';

export const MessageEditContext = createContext<{
  cwd: string; active: boolean; loadSkills?: (cwd: string, threadId?: string) => Promise<SkillsResponse>;
}>({ cwd: "", active: true });
