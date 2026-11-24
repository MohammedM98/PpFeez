import { NavLink, Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Inbox, LayoutGrid, Lock, Minimize2, Moon, PanelRightClose, PanelRightOpen, Settings, Sun, Users, Monitor } from 'lucide-react';
import { api } from '@/lib/api';
import { nav } from '@/lib/strings';
import { useTheme } from '@/lib/theme';
import { useUiPrefs } from '@/lib/uiPrefs';
import { useFullscreen } from '@/lib/fullscreen';
import { cx } from '@/components/ui/cx';
import type { ReactNode } from 'react';
import { SearchDialog } from '@/components/transactions/SearchDialog';
import { ExcelSyncListener } from '@/components/customers/CustomerExcel';
import { Shortcuts } from './Shortcuts';

function NavItem({ to, icon, label, count, tone = 'muted', narrow }: { to: string; icon: ReactNode; label: string; count?: number; tone?: 'muted' | 'warn'; narrow?: boolean }) {
  if (narrow) {
    return (
      <NavLink to={to} aria-label={count ? `${label} (${count})` : label} title={count ? `${label} (${count})` : label}
        className={({ isActive }) => cx(
          'relative grid h-10 w-10 place-items-center rounded-ctl outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-[19px] [&_svg]:stroke-[1.6]',
          isActive ? 'bg-raised text-accent-ink' : 'text-fg-3 hover:bg-raised/60 hover:text-fg')}>
        {icon}
        {!!count && <span aria-hidden className={cx('num absolute -top-0.5 end-0 min-w-4 rounded-full px-1 text-center text-[10.5px] leading-4', tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-raised text-fg-2')}>{count}</span>}
      </NavLink>
    );
  }
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

function ThemeSwitch({ narrow }: { narrow?: boolean }) {
  const { theme, setTheme } = useTheme();
  const opts = [
    { id: 'light' as const, icon: <Sun />, label: 'فاتح' },
    { id: 'dark' as const, icon: <Moon />, label: 'داكن' },
    { id: 'system' as const, icon: <Monitor />, label: 'حسب النظام' },
  ];
  return (
    <div role="radiogroup" aria-label={nav.theme} className={cx('grid gap-0.5 rounded-ctl bg-bg p-0.5', narrow ? 'w-10 grid-cols-1' : 'grid-cols-3')}>
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

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-8 text-accent" role="img" aria-label="PpFeez">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
      <path d="M8 16.5V7.5h4.2a2.8 2.8 0 0 1 0 5.6H8" fill="none" stroke="var(--accent-fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 16.5h3" stroke="var(--accent-fg)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
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
  // SPEC 6.10: the sidebar folds to icons (remembered); table full screen hides it altogether
  const { prefs, update } = useUiPrefs();
  const narrow = !!prefs.sidebarCollapsed;
  const { full, exit } = useFullscreen();
  const fold = () => update((p) => ({ ...p, sidebarCollapsed: !narrow }));
  return (
    <div className="flex h-screen min-h-[700px]">
      {!full && (
        <aside data-sidebar={narrow ? 'narrow' : 'wide'} className={cx('flex shrink-0 flex-col border-e border-line bg-sunken pb-3 pt-4 transition-[width] duration-200', narrow ? 'w-[64px] items-center px-2' : 'w-[232px] px-3')}>
          <div className={cx('pb-6', narrow ? '' : 'px-2.5')}>{narrow ? <LogoMark /> : <Logo />}</div>
          <nav className={cx('flex flex-col gap-0.5', narrow && 'items-center gap-1')} aria-label="التنقل الرئيسي">
            <NavItem narrow={narrow} to="/dashboard" icon={<LayoutGrid />} label={nav.dashboard} count={alerts.data?.length} tone="warn" />
            <NavItem narrow={narrow} to="/transactions" icon={<ArrowLeftRight />} label={nav.transactions} count={counts.data?.unassigned} />
            <NavItem narrow={narrow} to="/customers" icon={<Users />} label={nav.customers} />
            <NavItem narrow={narrow} to="/emails" icon={<Inbox />} label={nav.emails} count={failedEmails.data?.total} tone="warn" />
            <NavItem narrow={narrow} to="/settings" icon={<Settings />} label={nav.settings} />
          </nav>
          <div className={cx('mt-auto flex flex-col gap-2', narrow && 'items-center')}>
            <ThemeSwitch narrow={narrow} />
            {status.data?.lockEnabled && <button
              onClick={() => void api.lock().then(() => qc.invalidateQueries({ queryKey: ['app_status'] }))}
              aria-label={nav.lock} title={nav.lock}
              className={cx('flex h-9 items-center gap-2.5 rounded-ctl text-[14.5px] text-fg-2 outline-none transition-colors hover:bg-raised/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-[18px] [&_svg]:stroke-[1.6]', narrow ? 'w-10 justify-center' : 'px-2.5')}
            >
              <span className="grid size-5 place-items-center text-fg-3"><Lock /></span>
              {!narrow && nav.lock}
            </button>}
            <button onClick={fold} aria-label={narrow ? 'توسيع الشريط الجانبي' : 'طيّ الشريط الجانبي'} title={narrow ? 'توسيع الشريط الجانبي' : 'طيّ الشريط الجانبي'} aria-expanded={!narrow}
              className={cx('flex h-9 items-center gap-2.5 rounded-ctl text-[13.5px] text-fg-3 outline-none transition-colors hover:bg-raised/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus [&_svg]:size-[18px] [&_svg]:stroke-[1.6]', narrow ? 'w-10 justify-center' : 'px-2.5')}>
              {narrow ? <PanelRightOpen /> : <><PanelRightClose />طيّ الشريط</>}
            </button>
          </div>
        </aside>
      )}
      <main className="relative min-w-0 flex-1 overflow-auto">
        <Outlet />
        {full && (
          <button onClick={exit} className="fixed end-6 top-2 z-40 inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] text-fg-2 shadow-(--shadow-float) outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
            <Minimize2 className="size-3.5" />خروج من ملء الشاشة <kbd className="num text-fg-3">F11</kbd>
          </button>
        )}
        <SearchDialog />
        <ExcelSyncListener />
        <Shortcuts />
      </main>
    </div>
  );
}
