import { useEffect, useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n/i18n';
import { Button, Dialog, errorMessage } from './ui';

/**
 * Confirmation for consequential actions. With `acknowledge` the confirm button stays disabled
 * until the user ticks the checkbox (e.g. "I reviewed the changes").
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  acknowledge,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  acknowledge?: string;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const t = useT();
  const checkId = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setChecked(false);
      setError(null);
    }
  }, [open]);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={confirm}
            loading={busy}
            disabled={!!acknowledge && !checked}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {acknowledge ? (
        <label className="check" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>{acknowledge}</span>
        </label>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
