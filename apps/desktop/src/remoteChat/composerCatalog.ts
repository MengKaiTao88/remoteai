import { guiApi } from '../../../../shared/conversation/api';
import type { PluginsResponse } from '../../../../shared/conversation/attachmentTypes';
import type { SkillsResponse } from '../../../../shared/conversation/types';
import { remoteSkills } from '../../../../shared/remote-chat/skills';
import { remotePlugins } from '../../../../shared/remote-chat/composerCatalog';
import { uiText } from '../../../../shared/localization/uiText';

const PLUGINS_UNAVAILABLE = '部分插件暂未加载，可继续选择已有内容。';

export async function composerCatalog(body: Record<string, unknown>) {
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  const threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
  const skills = guiApi.request<SkillsResponse>({ operation: 'skills', cwd, threadId }).then(remoteSkills);
  if (!body.includePlugins) return skills;
  const plugins = guiApi.request<PluginsResponse>({ operation: 'plugins', cwd, ...(threadId ? { threadId } : {}) })
    .then(result => ({ plugins: remotePlugins(result),
      pluginsError: result.marketplaceLoadErrors.length ? PLUGINS_UNAVAILABLE : '' }))
    .catch(() => ({ plugins: [], pluginsError: PLUGINS_UNAVAILABLE }));
  const [skillResult, pluginResult] = await Promise.all([skills.catch(() => ({
    data: [{ skills: [], errors: [{ message: uiText('client.workspaceActions.someSkillsCouldNotLoadReopenTheMenuToRetry') }] }],
  })), plugins]);
  return { ...skillResult, ...pluginResult };
}
