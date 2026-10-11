import { createContext, useCallback, useContext, useEffect, useId, useState } from "react";

export const DraftValidation = createContext<(id: string, invalid: boolean) => void>(() => {});

export function useDraftValidation() {
  const [fields, setFields] = useState<Set<string>>(new Set());
  const report = useCallback((id: string, invalid: boolean) => setFields((previous) => {
    if (previous.has(id) === invalid) return previous;
    const next = new Set(previous);
    if (invalid) next.add(id); else next.delete(id);
    return next;
  }), []);
  return { invalid: fields.size > 0, report };
}

export function useInvalidField(invalid: boolean) {
  const id = useId();
  const report = useContext(DraftValidation);
  useEffect(() => { report(id, invalid); return () => report(id, false); }, [id, invalid, report]);
}
