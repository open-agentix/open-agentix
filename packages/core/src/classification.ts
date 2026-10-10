/** Data classification levels, ordered from least to most sensitive. */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

/** True when data of level `data` may flow to a sink cleared for level `clearance`. */
export function mayFlow(data: Classification, clearance: Classification): boolean {
  const d = classificationRank(data);
  const c = classificationRank(clearance);
  // An unknown level on either side fails closed (indexOf gives -1, which would rank below `public`).
  return d >= 0 && c >= 0 && d <= c;
}
