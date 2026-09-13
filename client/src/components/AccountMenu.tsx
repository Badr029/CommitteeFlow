import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, UserRound, X } from 'lucide-react';
import type { SessionResponse } from '@shared/api-types';
import { useLogout } from '@/api/queries';
import { Button } from './ui/Button';
import styles from './AppShell.module.css';

/**
 * Account menu (phone only).
 *
 * The menu holds account-specific actions only. Theme remains a persistent
 * top-bar control so it never depends on opening the identity menu.
 */
export function AccountMenu({
  session,
  onChangePassword,
  desktop = false,
}: {
  session: SessionResponse;
  onChangePassword: () => void;
  desktop?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { user } = session;

  // Escape closes, and focus goes back to the control that opened it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={desktop ? styles.desktopAccountTrigger : styles.accountTrigger}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen((current) => !current)}
      >
        {desktop ? (
          <span className={styles.identity}>
            <span className={styles.identityName}>{user.name}</span>
            <span className={styles.identityRole}>{user.role === 'PROJECT_ENGINEER' ? 'Project Engineer' : 'Viewer'}</span>
          </span>
        ) : <UserRound size={18} strokeWidth={1.9} />}
      </button>

      {open && (
        <>
          <div className={styles.accountScrim} aria-hidden="true" />
          <div ref={panelRef} className={desktop ? `${styles.accountPanel} ${styles.accountPanelDesktop}` : styles.accountPanel} role="menu">
            <div className={styles.accountIdentity}>
              <span className={styles.accountName}>{user.name}</span>
              <span className={styles.accountRole}>
                {user.role === 'PROJECT_ENGINEER' ? 'Project Engineer' : 'Viewer'}
              </span>
              <span className={styles.accountEmail}>{user.email}</span>
            </div>

            <button type="button" role="menuitem" className={styles.accountItem}
              onClick={() => { onChangePassword(); setOpen(false); }}>
              <KeyRound size={16} />
              Change password
            </button>

            <button
              type="button"
              role="menuitem"
              className={styles.accountItem}
              onClick={() => logout.mutate()}
            >
              <LogOut size={16} />
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </button>

            <div className={styles.accountFoot}>
              <Button variant="ghost" icon={<X size={14} />} onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
