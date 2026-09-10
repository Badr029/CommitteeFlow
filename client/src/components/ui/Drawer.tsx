import * as Dialog from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useViewport } from '@/lib/viewport';
import { Button } from './Button';
import styles from './overlay.module.css';

/**
 * Side drawer on a wide screen, sheet on a phone.
 *
 * Booking is the product's primary action and deserves protected focus, but not
 * a full page: the drawer keeps the month it belongs to visible behind it. Focus
 * trapping, escape handling, scroll locking and `aria-modal` come from Radix
 * rather than being re-implemented.
 *
 * On a phone the same content arrives from the bottom instead of the side,
 * because a 375px-wide panel sliding in from the right is just the screen. Two
 * presentations:
 *
 * - `full` covers the viewport below a short header. For anything with a form
 *   or a body worth reading — booking, details, a committee session.
 * - `sheet` is sized to its content and capped, for a short set of choices like
 *   the filters. Both keep their actions pinned above the home indicator.
 */

export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  wide = false,
  mobilePresentation = 'full',
  footer,
  children,
  /** Guard against closing while a save is in flight or a form is dirty. */
  onRequestClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: ReactNode;
  wide?: boolean;
  mobilePresentation?: 'full' | 'sheet';
  footer?: ReactNode;
  children: ReactNode;
  onRequestClose?: () => boolean;
}) {
  const isMobile = useViewport() === 'mobile';

  const handleOpenChange = (next: boolean) => {
    if (!next && onRequestClose && !onRequestClose()) return;
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.scrim} />
        <Dialog.Content
          className={cn(
            styles.drawer,
            wide && styles.wide,
            isMobile && styles.sheet,
            isMobile && mobilePresentation === 'sheet' && styles.sheetAuto,
          )}
          aria-describedby={undefined}
        >
          {isMobile && <span className={styles.grabber} aria-hidden="true" />}
          <header className={styles.drawerHead}>
            <div className={styles.drawerTitleGroup}>
              <Dialog.Title className={styles.drawerTitle}>{title}</Dialog.Title>
              {subtitle && <div className={styles.drawerSubtitle}>{subtitle}</div>}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" iconOnly icon={<X size={16} />} aria-label="Close" />
            </Dialog.Close>
          </header>

          <div className={styles.drawerBody}>{children}</div>

          {footer && <footer className={styles.drawerFoot}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Confirmation dialog.
 *
 * Reserved for the two actions that destroy or discard work — cancelling a
 * booking and abandoning unsaved edits. Everything else happens inline.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Keep editing',
  destructive = false,
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.scrim} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          <Dialog.Description className={styles.dialogBody}>{description}</Dialog.Description>
          {children}
          <div className={styles.dialogActions}>
            <Dialog.Close asChild>
              <Button variant="ghost">{cancelLabel}</Button>
            </Dialog.Close>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              loading={loading}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { VisuallyHidden };
