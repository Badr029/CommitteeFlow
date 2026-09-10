import { Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useSession } from '@/api/queries';
import { useTheme } from '@/lib/theme';
import { useViewport } from '@/lib/viewport';
import { AppShell } from '@/components/AppShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { AppBooting } from '@/features/auth/AppBooting';
import { PlanPage } from '@/features/plan/PlanPage';
import { ActivityPage } from '@/features/activity/ActivityPage';
import { PlanConfigPage } from '@/features/plan-config/PlanConfigPage';
import { NotFoundPage } from '@/features/NotFoundPage';

/**
 * Route table.
 *
 * The sitemap is deliberately small (spec §6, §7): the Committee Plan is home,
 * Activity is the audit view, and Plan Configuration sits behind a permission.
 * Booking is an action inside the plan, never a destination of its own.
 */
export function App() {
  const { theme, toggleTheme } = useTheme();
  const session = useSession();

  // The whole app depends on knowing who is asking, so the first load renders
  // a skeleton of the plan rather than an empty screen or a spinner.
  if (session.isPending) {
    return <AppBooting />;
  }

  if (!session.data) {
    return (
      <>
        <LoginPage theme={theme} onToggleTheme={toggleTheme} />
        <AppToaster theme={theme} />
      </>
    );
  }

  return (
    <>
      <AppShell session={session.data} theme={theme} onToggleTheme={toggleTheme}>
        <Routes>
          <Route path="/" element={<Navigate to="/plan" replace />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route
            path="/plan-configuration"
            element={
              session.data.user.permissions.canManagePlanConfiguration ? (
                <PlanConfigPage />
              ) : (
                <Navigate to="/plan" replace />
              )
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
      <AppToaster theme={theme} />
    </>
  );
}

function AppToaster({ theme }: { theme: 'light' | 'dark' }) {
  const isMobile = useViewport() === 'mobile';

  return (
    <Toaster
      theme={theme}
      /*
       * A phone puts the toast at the top. At the bottom it would land on the
       * navigation bar, and dismissing it would mean tapping over the control
       * you were reaching for.
       */
      position={isMobile ? 'top-center' : 'bottom-right'}
      closeButton
      // Long enough to read a conflict message, short enough not to linger.
      duration={5000}
      gap={8}
      offset={isMobile ? 12 : 16}
      // Toasts are announcements, never the only place a result is reported.
      mobileOffset={12}
      toastOptions={{
        className: 'app-toast',
        style: {
          fontFamily: 'var(--font-ui)',
          fontSize: 'var(--text-base)',
          borderRadius: 'var(--radius-md)',
        },
      }}
    />
  );
}
