import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../i18n/i18n';
import { Icon } from './Icon';

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({
  children,
  timeoutMs = 5000,
}: {
  children: ReactNode;
  timeoutMs?: number;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const t = useT();
  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((x) => x.id !== id)),
    [],
  );
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = nextId++;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), timeoutMs);
    },
    [dismiss, timeoutMs],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <Icon
              name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'info'}
            />
            <span>{toast.message}</span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => dismiss(toast.id)}
              aria-label={t('common.dismiss')}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
