import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/Toast';
import { toAppError, type ApiError } from './api';

/**
 * Runs a backend command, shows a toast with the result and refreshes every query
 * (one local user, small data: simpler and safer than hand-picking keys).
 */
export function useAction() {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  async function run<T>(fn: () => Promise<T>, okMessage?: string | ((r: T) => string), opts?: { quiet?: (e: ApiError) => boolean }): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
    setPending(true);
    try {
      const value = await fn();
      if (okMessage) toast.ok(typeof okMessage === 'function' ? okMessage(value) : okMessage);
      await qc.invalidateQueries();
      return { ok: true, value };
    } catch (e) {
      const error = toAppError(e);
      if (!opts?.quiet?.(error)) toast.error(error.messageAr);
      return { ok: false, error };
    } finally {
      setPending(false);
    }
  }
  return { run, pending };
}
