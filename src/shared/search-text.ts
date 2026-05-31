/**
 * Build normalized searchable text for code identifiers.
 */

export function normalizeIdentifierWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\]+/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildSearchText(parts: Array<string | null | undefined>): string {
  const expanded = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .flatMap((part) => [part, normalizeIdentifierWords(part)])
    .join(' ');
  return expanded.trim().replace(/\s+/g, ' ');
}
