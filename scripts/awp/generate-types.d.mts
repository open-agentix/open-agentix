export const REPO_ROOT: string;
export const SCHEMA_FILE: string;
export const EXTENSIONS_FILE: string;
export const OUT_DIR: string;
export function generate(
  root?: string,
  files?: { schema?: string; extensions?: string },
): Record<string, string>;
export function main(
  argv: string[],
  out?: { log(message: string): void; error(message: string): void },
  root?: string,
): number;
