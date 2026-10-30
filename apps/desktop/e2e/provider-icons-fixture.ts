import { browserProviders } from './provider-browser-fixture';

export function iconProviders() {
  const common = { ...browserProviders()[0], marketSource: null };
  return [
    { ...common, id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { ...common, id: 'volcengine', name: 'Volcengine ModelArk', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    { ...common, id: 'market', name: 'Market Gateway', baseUrl: 'https://api.example.test/v1', marketSource: {
      id: '11111111-1111-4111-8111-111111111111', page: { url: 'https://www.deepseek.com/dashboard?token=private',
        query: 'session=private', headers: { 'X-Private': 'private' } },
    } },
    { ...common, id: 'offline', name: 'Offline Provider', baseUrl: 'https://offline.example.test/v1' },
  ];
}
