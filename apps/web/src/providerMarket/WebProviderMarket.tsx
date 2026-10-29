import { useLanguage } from '../i18n';
import { MarketLauncher } from '../../../../shared/provider-market/MarketLauncher';
import { webProviderMarket } from './client';

export function WebProviderMarket({ initialId }: { initialId?: string }) {
  const language = useLanguage();
  return <MarketLauncher client={webProviderMarket} language={language} initialId={initialId} />;
}
