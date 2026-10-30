import { useState } from 'react';
import { Server } from 'lucide-react';
import { providerIconSources } from './providerWebsite';
import './providerWebsiteIcon.css';

function IconImage({ sources, size }: { sources: string[]; size: number }) {
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const source = sources[index];
  return <span className="provider-website-icon" style={{ width: size, height: size }} aria-hidden="true">
    {!loaded && <Server size={size} />}
    {source && <img key={source} src={source} alt="" loading="lazy" decoding="async"
      referrerPolicy="no-referrer" draggable={false} data-loaded={loaded}
      onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setIndex(index + 1); }} />}
  </span>;
}

/** Keep the fallback visible while loading and reset failures when the website changes. */
export function ProviderWebsiteIcon({ url, size = 20 }: { url?: string; size?: number }) {
  const sources = providerIconSources(url);
  return <IconImage key={sources.join('\n')} sources={sources} size={size} />;
}
