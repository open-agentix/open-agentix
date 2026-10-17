import { ApiError } from '../../api/client';
import { errorMessage } from '../../components/ui';
import type { TFunction, TKey } from '../../i18n/i18n';

/** Why a publish was refused: the API's stable codes (ADR 0017 section 4.3) to message keys. */
const REFUSAL: Record<string, TKey> = {
  approval_required: 'agents.publish.errors.approval_required',
  approval_insufficient: 'agents.publish.errors.approval_insufficient',
  draft_changed: 'agents.publish.errors.draft_changed',
  review_closed: 'agents.publish.errors.review_closed',
  publisher_not_approver: 'agents.publish.errors.publisher_not_approver',
  role_bindings_read_required: 'agents.publish.errors.role_bindings_read_required',
  version_deprecated: 'agents.publish.errors.version_deprecated',
  rollback_target_unapproved: 'agents.versions.deprecate.errors.rollback_target_unapproved',
  no_rollback_target: 'agents.versions.deprecate.errors.no_rollback_target',
  already_deprecated: 'agents.versions.deprecate.errors.already_deprecated',
};

const STALE: Record<string, TKey> = {
  expansion_changed: 'agents.publish.errors.stale_expansion_changed',
  secret_resolution_changed: 'agents.publish.errors.stale_secret_resolution_changed',
};

/** The message for a failed publish: our text for the codes we know, else the API's own. */
export function publishFailureText(e: unknown, t: TFunction): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  if (e.code === 'approval_stale') {
    const reason = (e.details as { reason?: string } | undefined)?.reason ?? '';
    return t(STALE[reason] ?? 'agents.publish.errors.approval_stale');
  }
  const key = REFUSAL[e.code];
  return key ? t(key) : errorMessage(e);
}
