// The app-wide opener plugin handles links on window and sends them to the system browser.
// Handle browser-tab links during document bubbling so that plugin sees defaultPrevented.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
  const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!link?.href || !(link.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey)) return;
  const url = new URL(link.href);
  if (!['http:', 'https:'].includes(url.protocol)) return;
  event.preventDefault();
  window.open(url.href, '_blank', 'noopener');
});
