import { useRef } from 'react';
import type { LoungeNameEditorHandle } from './useLoungeNameEditor';

/** Keep the profile and its draft visible if saving fails while the user tries to leave. */
export function useLoungeNameNavigation() {
  const saveRef = useRef<LoungeNameEditorHandle>(null);
  const leaving = useRef(false);
  const leave = async (action: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    try { if (!saveRef.current || await saveRef.current.save()) action(); }
    finally { leaving.current = false; }
  };
  return { saveRef, leave };
}
