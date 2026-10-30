import type { Provider } from '../src/types';

export function browserProviders(): Provider[] {
  const common: Provider = {
    id: 'market-personal', kind: 'custom', name: 'Market Gateway', group: '', baseUrl: 'https://api.example.test/v1',
    model: 'model-z', models: ['model-z'], modelReasoningEfforts: {}, modelContextWindows: {}, modelApiFormats: {},
    imageInputModels: [], imageInputModelsConfigured: true, modelSelectionControlledByCodex: true,
    fastModeEnabled: true, apiFormat: 'openaiResponses', active: false, autoSwitchEnabled: false,
    hasApiKey: true, supportsDirectSwitch: false, balanceQueryUsesApiKey: true, hasBalanceQueryToken: false,
    hasWalletQueryToken: false, hasWalletLoginCredentials: false,
    marketSource: { id: '11111111-1111-4111-8111-111111111111', page: {
      url: 'http://127.0.0.1:1500/dashboard?view=usage#balance', query: 'source=remoteai&tag=a&tag=b',
      headers: { 'X-Provider-Test': 'market-value' },
    } },
  };
  return [common, { ...common, id: 'market-other', name: 'Second Gateway', marketSource: {
    id: '22222222-2222-4222-8222-222222222222', page: { url: 'http://127.0.0.1:1500/second', query: '', headers: {} },
  } }, { ...common, id: 'manual', name: 'Personal Gateway', marketSource: null }];
}
