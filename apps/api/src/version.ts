import { readFileSync } from 'node:fs';

/** Version of the running build (from apps/api/package.json, kept in sync with the root on release). */
export const VERSION: string = (() => {
  try {
    return (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    return '0.0.0-unknown';
  }
})();
