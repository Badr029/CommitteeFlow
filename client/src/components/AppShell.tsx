import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { CalendarRange, History, Moon, Settings2, Sun } from 'lucide-react';
import type { SessionResponse } from '@shared/api-types';
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
 * every size, in two shapes. Wide screens get a single top bar. A phone keeps
 * the theme and identity controls visible while the destinations drop to a
 * bottom bar within thumb reach.
 *
 * Plan Configuration only appears for someone who holds the permission, and the
 * server enforces the same rule independently, so hiding it is convenience,
 * not security.
 */
export function AppShell({
  session,
  theme,
  onToggleTheme,
  onChangePassword,
  children,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
  onChangePassword: () => void;
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
        <MobileBar session={session} theme={theme} onToggleTheme={onToggleTheme} onChangePassword={onChangePassword} />
      ) : (
        <DesktopBar
          session={session}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onChangePassword={onChangePassword}
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
  onChangePassword,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
  onChangePassword: () => void;
}) {
  return (
    <header className={cn(styles.bar, styles.barMobile)}>
      <NavLink to="/plan" className={styles.brand}>
        <BrandMark size={20} />
        <span className={styles.brandNameMobile}>CommitteeFlow</span>
      </NavLink>

      <div className={styles.spacer} />

      <div className={styles.barRight}>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} mobile />
        <AccountMenu session={session} onChangePassword={onChangePassword} />
      </div>
    </header>
  );
}

function DesktopBar({
  session,
  theme,
  onToggleTheme,
  onChangePassword,
  compact,
}: {
  session: SessionResponse;
  theme: Theme;
  onToggleTheme: () => void;
  onChangePassword: () => void;
  compact: boolean;
}) {
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
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <AccountMenu session={session} onChangePassword={onChangePassword} desktop />
      </div>
    </header>
  );
}

function ThemeToggle({
  theme,
  onToggle,
  mobile = false,
}: {
  theme: Theme;
  onToggle: () => void;
  mobile?: boolean;
}) {
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <Button
      variant="ghost"
      iconOnly
      icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      className={mobile ? styles.themeToggleMobile : styles.themeToggle}
      onClick={onToggle}
      aria-label={label}
      title={label}
    />
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
