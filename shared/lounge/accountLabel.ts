/** Legacy local records can contain an address; chat labels expose only its local part. */
export function accountLabel(value: string): string {
  const separator = value.indexOf('@');
  return separator < 0 ? value : value.slice(0, separator);
}
