export const PROVENANCE_FILE: string;
export const DEFAULT_DIR: string;
export function verifyPin(dir?: string): { ok: boolean; problems: string[]; checked: number };
export function main(
  argv: string[],
  out?: { log(message: string): void; error(message: string): void },
): number;
