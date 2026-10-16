export const REPOSITORY: string;
export function licenseFor(path: string): 'Apache-2.0' | 'CC-BY-4.0';
export function vendorAwp(
  source: string,
  target?: string,
  options?: { tag?: string | null; now?: Date },
): {
  files: { path: string; sha256: string; license: string }[];
  source: { repository: string; commit: string; commitDate: string; tag: string | null };
  retrievedAt: string;
};
