import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerFileImage } from '../src/pages/codexGui/ComposerFileImage';
import '../src/styles.css';

function Harness() {
  const [visible, setVisible] = useState(true);
  return <main style={{ padding: 32 }}>
    {visible && <ComposerFileImage item={{ kind: 'file', name: 'large.jpg', path: 'F:/Downloads/large.jpg' }}
      disabled={false} active onRemove={() => setVisible(false)} />}
    <textarea aria-label="消息" defaultValue="请看这张图片" style={{ marginTop: 16 }} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
