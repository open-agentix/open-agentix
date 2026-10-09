import { OaxError } from '@openagentix/core';

/**
 * Stable, client-safe codes of the Git delivery path (ADR 0010 Amendment 1 A1.3). Messages are
 * fixed texts: server-provided text, URLs with credentials and `git` stderr never end up here.
 */
export type GitErrorCode =
  | 'git_version_unsupported'
  | 'url_invalid'
  | 'ref_invalid'
  | 'branch_invalid'
  | 'sha_invalid'
  | 'identity_invalid'
  | 'message_invalid'
  | 'auth_failed'
  | 'not_found'
  | 'redirect_refused'
  | 'tls_failed'
  | 'egress_denied'
  | 'protocol_error'
  | 'transfer_limit'
  | 'sync_limit'
  | 'timeout'
  | 'busy'
  | 'branch_exists'
  | 'push_rejected'
  | 'git_failed'
  | 'patch_invalid'
  | 'patch_digest_mismatch'
  | 'patch_path_refused'
  | 'patch_too_large'
  | 'patch_apply_failed'
  | 'secret_detected'
  | 'target_invalid'
  | 'repository_not_allowed'
  | 'branch_prefix_refused'
  | 'pr_limit_reached'
  | 'pr_body_too_large'
  | 'host_response_invalid'
  | 'host_request_failed'
  | 'credential_unavailable'
  | 'tests_not_green'
  | 'patch_missing'
  | 'issue_invalid';

export class GitError extends OaxError {
  declare readonly code: GitErrorCode;
  constructor(code: GitErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}
