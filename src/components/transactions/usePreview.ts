import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CommissionInput, FeeInput } from '@/lib/contract';

function useDebounced<T>(value: T, ms = 220): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Live calculation from the backend (txn_preview), never computed in the UI. */
export function usePreview(args: { id: number; fee?: FeeInput; commission?: CommissionInput; customerId?: number } | null) {
  const debounced = useDebounced(args);
  return useQuery({
    queryKey: ['txn_preview', debounced],
    queryFn: () => api.txnPreview(debounced!),
    enabled: !!debounced,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}
