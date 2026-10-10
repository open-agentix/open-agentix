import { ERROR_CODE_PATTERN } from './attribute-specs.js';

/** The catch-all for an error without a usable code or class name (OpenTelemetry convention). */
export const OTHER_ERROR = '_OTHER';

export interface ErrorInfo {
  /** Stable code (`OaxError.code`, a system error code such as `ECONNREFUSED`) or `_OTHER`. */
  code: string;
  /** Class name only, never the message or the stack. */
  type: string;
}

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function read(e: unknown, key: string): unknown {
  try {
    return (e as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Reduces any thrown value to what telemetry may record: a stable code and the class name. The
 * message, the stack and the `cause` are never read, so provider bodies, tool output and secrets
 * in them cannot leak through this path (ADR 0015 3.5). Values that do not have the shape of a
 * code or identifier collapse to `_OTHER`; callers still pass both through the attribute guard.
 */
export function describeError(e: unknown): ErrorInfo {
  if (e === null || typeof e !== 'object') return { code: OTHER_ERROR, type: OTHER_ERROR };
  const code = read(e, 'code');
  let type: unknown;
  try {
    type = (Object.getPrototypeOf(e) as { constructor?: { name?: unknown } } | null)?.constructor
      ?.name;
  } catch {
    type = undefined;
  }
  return {
    code: typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : OTHER_ERROR,
    type: typeof type === 'string' && CLASS_NAME.test(type) ? type : OTHER_ERROR,
  };
}
