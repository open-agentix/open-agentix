// Scans built files for anything that would make the browser contact a third party.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Absolute URLs that are plain strings, never requested (XML namespaces, docs, placeholders). */
const ALLOWED_HOSTS = [/^www\.w3\.org$/, /^react\.dev$/, /\.internal$/, /\.vpce\.amazonaws\.com$/];

const URL_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Returns a list of violations (empty = offline-clean). */
export function scanDist(dir) {
  const violations = [];
  for (const file of files(dir)) {
    const ext = extname(file);
    if (!['.html', '.css', '.js', '.svg', '.json'].includes(ext)) continue;
    const text = readFileSync(file, 'utf8');
    if (ext === '.html') {
      for (const m of text.matchAll(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)/gi)) {
        violations.push(`${file}: external reference ${m[1]}`);
      }
    }
    if (ext === '.css') {
      for (const m of text.matchAll(/(?:url\(|@import\s+)["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
        violations.push(`${file}: external CSS reference ${m[1]}`);
      }
    }
    for (const m of text.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      if (!ALLOWED_HOSTS.some((re) => re.test(host)))
        violations.push(`${file}: absolute URL ${m[0]}`);
    }
  }
  return violations;
}
