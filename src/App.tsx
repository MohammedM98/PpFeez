import { createHashRouter, Navigate, RouterProvider } from 'react-router';
import { QueryCache, QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toAppError } from '@/lib/api';
import { LockPage } from '@/pages/Lock';
import { OnboardingPage } from '@/pages/Onboarding';
import { I18nProvider } from 'react-aria-components';
import { api } from '@/lib/api';
import { ThemeProvider, rememberedAppearance, type Appearance } from '@/lib/theme';
import { Shell } from '@/components/layout/Shell';
import { TransactionsPage } from '@/pages/Transactions';
import { CustomersPage } from '@/pages/Customers';
import { CustomerLedgerPage } from '@/pages/CustomerLedger';
import { StatementPage } from '@/pages/Statement';
import { DashboardPage } from '@/pages/Dashboard';
import { EmailsPage } from '@/pages/Emails';
import { SettingsPage } from '@/pages/Settings';
import { PullProvider } from '@/lib/pull';
import { FullscreenProvider } from '@/lib/fullscreen';
import { Toasts } from '@/components/ui/Toast';
import { TxnActionsHost } from '@/components/transactions/TxnActions';
import { UpdatesProvider } from '@/components/update/Updates';

const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, staleTime: 5_000 } },
  // Any command refused with `locked` means the backend locked itself: show the lock screen.
  queryCache: new QueryCache({
    onError: (e) => { if (toAppError(e).code === 'locked') void queryClient.invalidateQueries({ queryKey: ['app_status'] }); },
  }),
});

// Per-viewer convenience so the lock screen keeps the last theme (settings may be refused while locked).

/** Locks the app after N idle minutes when the lock is enabled (Settings.autoLockMinutes). */
function useAutoLock(minutes: number | null | undefined, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !minutes) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void api.lock().then(() => qc.invalidateQueries({ queryKey: ['app_status'] })); }, minutes * 60_000);
    };
    const evs = ['pointermove', 'keydown', 'pointerdown', 'wheel'] as const;
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [minutes, enabled, qc]);
}


const router = createHashRouter([
  { path: '/statement/:id', element: <StatementPage /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/transactions" replace /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'customers/:id', element: <CustomerLedgerPage /> },
      { path: 'emails', element: <EmailsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

function Gate() {
  const status = useQuery({ queryKey: ['app_status'], queryFn: api.appStatus });
  const open = !!status.data && !status.data.locked;
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, enabled: open });
  useAutoLock(settings.data?.autoLockMinutes, open && !!status.data?.lockEnabled && !!status.data?.onboardingDone);
  if (!status.data) return null;
  const sd = settings.data;
  const appearance: Appearance = sd ? { theme: sd.theme, accent: sd.accent ?? 'blue', density: sd.density ?? 'regular', uiScale: sd.uiScale ?? 100 } : rememberedAppearance();
  let body;
  if (status.data.locked) body = <LockPage status={status.data} />;
  else if (!status.data.onboardingDone) body = <OnboardingPage />;
  else if (!settings.data) return null;
  else body = (
    <PullProvider>
      <UpdatesProvider>
      <TxnActionsHost>
        <FullscreenProvider><RouterProvider router={router} /></FullscreenProvider>
      </TxnActionsHost>
      </UpdatesProvider>
    </PullProvider>
  );
  return (
    <ThemeProvider initial={appearance} onChange={(patch) => void api.updateSettings(patch)}>
      {body}
      <Toasts />
    </ThemeProvider>
  );
}

export function App() {
  return (
    // Arabic with Latin digits and the Gregorian calendar (SPEC §2).
    <I18nProvider locale="ar-u-nu-latn-ca-gregory">
      <QueryClientProvider client={queryClient}>
        <Gate />
      </QueryClientProvider>
    </I18nProvider>
  );
}
