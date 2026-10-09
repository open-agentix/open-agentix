/**
 * Error with a stable machine code. The message never contains absolute host paths: only the
 * workspace-relative path the model itself sent.
 */
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
