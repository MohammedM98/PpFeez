import { NavLink, Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Inbox, LayoutGrid, Lock, Moon, Settings, Sun, Users, Monitor } from 'lucide-react';
import { api } from '@/lib/api';
import { nav } from '@/lib/strings';
import { useTheme } from '@/lib/theme';
import { cx } from '@/components/ui/cx';
import type { ReactNode } from 'react';
import { SearchDialog } from '@/components/transactions/SearchDialog';

function NavItem({ to, icon, label, count, tone = 'muted' }: { to: string; icon: ReactNode; label: string; count?: number; tone?: 'muted' | 'warn' }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'group flex h-9 items-center gap-2.5 rounded-ctl px-2.5 text-[14.5px] outline-none transition-colors duration-150',
          'focus-visible:outline-2 focus-visible:outline-focus',
          isActive ? 'bg-raised text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]' : 'text-fg-2 hover:bg-raised/60 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cx('grid size-5 place-items-center [&_svg]:size-[18px] [&_svg]:stroke-[1.6]', isActive ? 'text-accent-ink' : 'text-fg-3')}>{icon}</span>
          <span className="flex-1">{label}</span>
          {!!count && (
            <span className={cx('num text-[12.5px]', tone === 'warn' ? 'text-warn' : 'text-fg-3')}>{count}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const opts = [
    { id: 'light' as const, icon: <Sun />, label: 'فاتح' },
    { id: 'dark' as const, icon: <Moon />, label: 'داكن' },
    { id: 'system' as const, icon: <Monitor />, label: 'حسب النظام' },
  ];
  return (
    <div role="radiogroup" aria-label={nav.theme} className="grid grid-cols-3 gap-0.5 rounded-ctl bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={theme === o.id}
          title={o.label}
          onClick={() => setTheme(o.id)}
          className={cx(
            'grid h-7 place-items-center rounded-[calc(var(--r-ctl)-2px)] text-fg-3 outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-4 [&_svg]:stroke-[1.6]',
            theme === o.id ? 'bg-raised text-fg' : 'hover:text-fg',
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 24 24" className="size-7 text-accent" aria-hidden>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
        <path d="M8 16.5V7.5h4.2a2.8 2.8 0 0 1 0 5.6H8" fill="none" stroke="var(--accent-fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 16.5h3" stroke="var(--accent-fg)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <div className="leading-tight">
        <div dir="ltr" className="text-right text-[16px] font-semibold text-fg">PpFeez</div>
        <div className="text-[12px] text-fg-3">دفتر دفعات PayPal</div>
      </div>
    </div>
  );
}

export function Shell() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['app_status'], queryFn: api.appStatus });
  const counts = useQuery({ queryKey: ['txn_counts', {}], queryFn: () => api.txnCounts({}) });
  const alerts = useQuery({ queryKey: ['refund_alerts'], queryFn: api.refundAlerts });
  const failedEmails = useQuery({ queryKey: ['emails', 'failed', 'count'], queryFn: () => api.emailsList({ status: 'failed', page: 1, pageSize: 1 }) });
  return (
    <div className="flex h-screen min-h-[700px]">
      <aside className="flex w-[232px] shrink-0 flex-col border-e border-line bg-sunken px-3 pb-3 pt-4">
        <div className="px-2.5 pb-6"><Logo /></div>
        <nav className="flex flex-col gap-0.5" aria-label="التنقل الرئيسي">
          <NavItem to="/dashboard" icon={<LayoutGrid />} label={nav.dashboard} count={alerts.data?.length} tone="warn" />
          <NavItem to="/transactions" icon={<ArrowLeftRight />} label={nav.transactions} count={counts.data?.unassigned} />
          <NavItem to="/customers" icon={<Users />} label={nav.customers} />
          <NavItem to="/emails" icon={<Inbox />} label={nav.emails} count={failedEmails.data?.total} tone="warn" />
          <NavItem to="/settings" icon={<Settings />} label={nav.settings} />
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          <ThemeSwitch />
          {status.data?.lockEnabled && <button
            onClick={() => void api.lock().then(() => qc.invalidateQueries({ queryKey: ['app_status'] }))}
            className="flex h-9 items-center gap-2.5 rounded-ctl px-2.5 text-[14.5px] text-fg-2 outline-none transition-colors hover:bg-raised/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-[18px] [&_svg]:stroke-[1.6]"
          >
            <span className="grid size-5 place-items-center text-fg-3"><Lock /></span>
            {nav.lock}
          </button>}
        </div>
      </aside>
      <main className="relative min-w-0 flex-1 overflow-auto">
        <Outlet />
        <SearchDialog />
      </main>
    </div>
  );
}
