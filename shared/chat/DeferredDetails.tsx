import { useState, type ReactNode } from 'react';

/** Construct contents only while expanded; closing also releases images and preview loaders. */
export function DeferredDetails({ summary, children, defaultOpen = false, className, status }: {
  summary: ReactNode; children: () => ReactNode; defaultOpen?: boolean; className?: string; status?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className={className} data-status={status} open={open} onToggle={event => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    {summary}
    {open && children()}
  </details>;
}
