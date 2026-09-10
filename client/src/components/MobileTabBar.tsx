import { NavLink } from 'react-router-dom';
import { CalendarRange, History, Settings2 } from 'lucide-react';
import type { SessionResponse } from '@shared/api-types';
import { cn } from '@/lib/cn';
import styles from './AppShell.module.css';

/**
 * Bottom navigation (phone only).
 *
 * The same three destinations as the desktop top bar, in the same order —
 * mobile is not a different information architecture, only a different shape.
 * Plan Configuration is absent, not disabled, for anyone without the
 * permission: a control that exists only to refuse is worse than no control.
 */
export function MobileTabBar({ session }: { session: SessionResponse }) {
  const canConfigure = session.user.permissions.canManagePlanConfiguration;

  return (
    <nav className={styles.tabBar} aria-label="Sections">
      <Tab to="/plan" icon={<CalendarRange size={19} strokeWidth={1.9} />} label="Plan" />
      <Tab to="/activity" icon={<History size={19} strokeWidth={1.9} />} label="Activity" />
      {canConfigure && (
        <Tab to="/plan-configuration" icon={<Settings2 size={19} strokeWidth={1.9} />} label="Config" />
      )}
    </nav>
  );
}

function Tab({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(styles.tab, isActive && styles.tabActive)}
    >
      {({ isActive }) => (
        <>
          {/*
           * The active marker is a rule above the tab rather than a filled
           * pill: it reads as an instrument's indicator, and it leaves the
           * label at full contrast instead of inverting it.
           */}
          <span className={styles.tabMarker} aria-hidden="true" />
          {icon}
          <span className={styles.tabLabel}>{label}</span>
          {isActive && <span className="sr-only">(current section)</span>}
        </>
      )}
    </NavLink>
  );
}
