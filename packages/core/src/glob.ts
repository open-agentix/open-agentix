/**
 * Glob matching for tool names, model names and package names: `*` matches any run of characters
 * (also none), every other character is literal. Iterative two-pointer matching: no regular
 * expression is built, so a hostile glob such as `*a*a*a*a*!` cannot take exponential time (the
 * previous implementation built `^.*a.*a.*a.*a.*!$`, 25 s on a 200-character name).
 *
 * Worst case is O(globLength x valueLength); globs and names that reach the policy gate are bounded
 * ({@link MAX_GLOB_LENGTH}, {@link MAX_GLOB_STARS}, {@link MAX_GLOB_SUBJECT}).
 */
export const MAX_GLOB_LENGTH = 128;
export const MAX_GLOB_STARS = 8;
/** Longest tool name (`server/tool`) the policy gate evaluates. */
export const MAX_GLOB_SUBJECT = 256;

export function globMatch(glob: string, value: string): boolean {
  let g = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = v;
    } else if (g < glob.length && glob[g] === value[v]) {
      g++;
      v++;
    } else if (star >= 0) {
      g = star + 1;
      v = ++mark;
    } else return false;
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** Why a glob may not be stored or evaluated, or `null`. */
export function globIssue(glob: string): string | null {
  if (glob.length > MAX_GLOB_LENGTH) return `a glob is limited to ${MAX_GLOB_LENGTH} characters`;
  let stars = 0;
  for (const c of glob) if (c === '*') stars++;
  if (stars > MAX_GLOB_STARS) return `a glob may contain at most ${MAX_GLOB_STARS} "*"`;
  return null;
}
