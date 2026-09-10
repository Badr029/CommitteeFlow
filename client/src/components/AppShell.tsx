import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { CalendarRange, History, LogOut, Moon, Settings2, Sun } from 'lucide-react';
import type { SessionResponse } from '@shared/api-types';
import { useLogout } from '@/api/queries';
import { cn } from '@/lib/cn';
import type { Theme } from '@/lib/theme';
import { useViewport } from '@/lib/viewport';
import { AccountMenu } from './AccountMenu';
import { MobileTabBar } from './MobileTabBar';
import { Button } from './ui/Button';
import styles from './AppShell.module.css';

/**
 * The frame every signed-in screen sits in.
 *
 * Three destinations, one identity, one theme switch — the same architecture at
 * every size, in two shapes. Wide screens get a single top bar. A phone splits
 * it: identity and theme move behind an account control, and the destinations
 * drop to a bottom bar within thumb reach.
 *
 * Plan Configuration only appears for someone who holds the permission, and the
 * server enforces the same rule independently, so hiding it is convenience,
 * not security.
 */
export function AppShell({
  session,
  theme,
  onToggleTheme,
  children,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const viewport = useViewport();
  const isMobile = viewport === 'mobile';

  return (
    <div className={cn(styles.shell, isMobile && styles.shellMobile)}>
      <a className="skip-link" href="#main">
        Skip to the plan
      </a>

      {isMobile ? (
        <MobileBar session={session} theme={theme} onToggleTheme={onToggleTheme} />
      ) : (
        <DesktopBar
          session={session}
          theme={theme}
          onToggleTheme={onToggleTheme}
          compact={viewport === 'tablet'}
        />
      )}

      <main id="main" className={styles.main}>
        {children}
      </main>

      {isMobile && <MobileTabBar session={session} />}
    </div>
  );
}

function MobileBar({
  session,
  theme,
  onToggleTheme,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header className={cn(styles.bar, styles.barMobile)}>
      <NavLink to="/plan" className={styles.brand}>
        <BrandMark size={20} />
        <span className={styles.brandNameMobile}>CommitteeFlow</span>
      </NavLink>

      <div className={styles.spacer} />

      <AccountMenu session={session} theme={theme} onToggleTheme={onToggleTheme} />
    </header>
  );
}

function DesktopBar({
  session,
  theme,
  onToggleTheme,
  compact,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
  compact: boolean;
}) {
  const logout = useLogout();
  const { user } = session;

  return (
    <header className={styles.bar}>
      <NavLink to="/plan" className={styles.brand}>
        <BrandMark />
        <span className={styles.brandName}>CommitteeFlow</span>
      </NavLink>

      <nav className={styles.nav} aria-label="Sections">
        {/* A tablet keeps every destination; only the labels shorten. */}
        <ShellLink to="/plan" icon={<CalendarRange size={14} />}>
          {compact ? 'Plan' : 'Committee Plan'}
        </ShellLink>
        <ShellLink to="/activity" icon={<History size={14} />}>
          Activity
        </ShellLink>
        {user.permissions.canManagePlanConfiguration && (
          <ShellLink to="/plan-configuration" icon={<Settings2 size={14} />}>
            {compact ? 'Configuration' : 'Plan Configuration'}
          </ShellLink>
        )}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.barRight}>
        <div className={styles.identity}>
          <span className={styles.identityName}>{user.name}</span>
          <span className={styles.identityRole}>
            {user.role === 'PROJECT_ENGINEER' ? 'Project Engineer' : 'Viewer'}
          </span>
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <Button
          variant="ghost"
          iconOnly
          icon={theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        />

        <Button
          variant="ghost"
          iconOnly
          icon={<LogOut size={15} />}
          onClick={() => logout.mutate()}
          loading={logout.isPending}
          aria-label="Sign out"
          title="Sign out"
        />
      </div>
    </header>
  );
}

function ShellLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(styles.navLink, isActive && styles.navLinkActive)}
    >
      {icon}
      {children}
    </NavLink>
  );
}

/** A committee schedule reduced to a mark: ruled lines, one slot picked out. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className={styles.brandMark}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9h20M6 16h20M6 23h12"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="square"
      />
      <circle cx="24" cy="23" r="3.2" fill="var(--accent)" />
    </svg>
  );
}
