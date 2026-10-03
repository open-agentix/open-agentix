/** Base class for all openagentix errors; `code` is stable and safe to expose to clients. */
export class OaxError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends OaxError {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super('validation_failed', message, issues);
    this.issues = issues;
  }
}

/** Thrown by features that are designed and typed but not implemented yet (see ROADMAP.md). */
export class NotImplementedError extends OaxError {
  constructor(feature: string, hint: string) {
    super('not_implemented', `${feature} is not implemented yet. ${hint}`);
  }
}

export class PolicyDeniedError extends OaxError {
  constructor(message: string, details?: unknown) {
    super('policy_denied', message, details);
  }
}
