/** Data classification levels, ordered from least to most sensitive. */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

/** True when data of level `data` may flow to a sink cleared for level `clearance`. */
export function mayFlow(data: Classification, clearance: Classification): boolean {
  return classificationRank(data) <= classificationRank(clearance);
}
