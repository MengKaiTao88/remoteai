import { publicDraft, type MarketItem } from './types';
import { validDraft } from './validation';
import { copyPageLink } from './pageLink';

/** One-way, explicit creation; market prices never change proxy routing or accounting. */
export function personalProviderFields(item: MarketItem, apiKey: string) {
  if (!validDraft(item) || !apiKey.trim()) throw new Error('market.invalid');
  return {
    kind: 'custom' as const, name: item.name, baseUrl: item.baseUrl.replace(/\/+$/, ''),
    apiKey: apiKey.trim(), model: item.models[0].id, models: item.models.map((model) => model.id),
    apiFormat: item.models[0].protocol,
    modelApiFormats: Object.fromEntries(item.models.map((model) => [model.id, model.protocol])),
    modelReasoningEfforts: {}, modelContextWindows: {}, imageInputModels: [], imageInputModelsConfigured: true,
    modelSelectionControlledByCodex: true, fastModeEnabled: true,
    balanceScript: item.balanceQuery ? { ...item.balanceQuery } : null,
    marketSource: item.id && item.pageLink ? { id: item.id, page: copyPageLink(item.pageLink) } : null,
  };
}
export function downloadPublicProvider(item: MarketItem) {
  const data = JSON.stringify({ schema: 'remoteai.provider-market.v1', provider: publicDraft(item) }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'provider-market.json'; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
