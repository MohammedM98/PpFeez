import { createHashRouter, Navigate, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { I18nProvider } from 'react-aria-components';
import { api } from '@/lib/api';
import { ThemeProvider } from '@/lib/theme';
import { Shell } from '@/components/layout/Shell';
import { TransactionsPage } from '@/pages/Transactions';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, staleTime: 5_000 } },
});

function Placeholder({ title }: { title: string }) {
  return <div className="px-7 pt-6"><h1 className="font-display text-[26px] font-medium text-fg">{title}</h1><p className="mt-2 text-fg-3">تُبنى بعد اعتماد شاشة المعاملات</p></div>;
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/transactions" replace /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'dashboard', element: <Placeholder title="لوحة التحكم" /> },
      { path: 'customers', element: <Placeholder title="العملاء" /> },
      { path: 'emails', element: <Placeholder title="الرسائل" /> },
      { path: 'settings', element: <Placeholder title="الإعدادات" /> },
    ],
  },
]);

function Themed() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  if (!settings.data) return null;
  return (
    <ThemeProvider initial={settings.data.theme} onChange={(theme) => void api.updateSettings({ theme })}>
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}

export function App() {
  return (
    // Arabic with Latin digits and the Gregorian calendar (SPEC §2).
    <I18nProvider locale="ar-u-nu-latn-ca-gregory">
      <QueryClientProvider client={queryClient}>
        <Themed />
      </QueryClientProvider>
    </I18nProvider>
  );
}
