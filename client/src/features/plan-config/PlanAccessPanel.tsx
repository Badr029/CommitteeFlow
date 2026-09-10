import { toast } from 'sonner';
import type { PlanAccessUser } from '@shared/api-types';
import { ApiError } from '@/api/client';
import { usePlanAccess, useSession, useSetPlanAccess } from '@/api/queries';
import { Pill } from '@/components/ui/Pill';
import { Skeleton } from '@/components/ui/Skeleton';
import styles from './PlanConfigPage.module.css';

/**
 * Who can configure the plan (spec §5).
 *
 * Plan Configuration reshapes the booking form, the plan table and both exports
 * for everyone, so the permission is deliberately narrow. This panel grants and
 * revokes it on accounts that already exist; it does not create people or
 * change passwords — see `docs/managing-users.md`.
 */
export function PlanAccessPanel() {
  const session = useSession();
  const accounts = usePlanAccess();
  const setAccess = useSetPlanAccess();

  const me = session.data?.user.id;
  const managers = (accounts.data ?? []).filter((user) => user.canManagePlanConfiguration).length;

  const change = (user: PlanAccessUser, canManage: boolean) => {
    setAccess.mutate(
      { id: user.id, canManagePlanConfiguration: canManage },
      {
        onSuccess: () =>
          toast.success(
            canManage
              ? `${user.name} can now configure the plan`
              : `${user.name} can no longer configure the plan`,
          ),
        onError: (error) =>
          toast.error(
            error instanceof ApiError ? error.message : 'That change could not be saved.',
          ),
      },
    );
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Who can configure the plan</h2>
        <span className={styles.sectionNote}>
          {managers === 0 ? 'Everyone with an account' : `${managers} of ${accounts.data?.length ?? 0} accounts`}
        </span>
      </div>

      {accounts.isPending ? (
        <div className={styles.accessList} aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className={styles.accessRow}>
              <Skeleton width={index === 1 ? 148 : 120} height={11} />
              <Skeleton width={72} height={11} />
              <Skeleton width={36} height={16} />
            </div>
          ))}
        </div>
      ) : accounts.isError || !accounts.data ? (
        <p className={styles.settingNote}>The list of accounts could not be loaded.</p>
      ) : (
        <div className={styles.accessList}>
          {accounts.data.map((user) => {
            /*
             * Both guards are enforced on the server; disabling the control here
             * only saves someone the round trip to an error they cannot act on.
             */
            const isSelf = user.id === me;
            const isLast = user.canManagePlanConfiguration && managers <= 1;
            const locked = user.canManagePlanConfiguration && (isSelf || isLast);

            return (
              <label key={user.id} className={styles.accessRow}>
                <span className={styles.accessWho}>
                  <span className={styles.accessName}>
                    {user.name}
                    {isSelf && <span className={styles.accessYou}> (you)</span>}
                  </span>
                  <span className={styles.fieldKey}>{user.email}</span>
                </span>

                <Pill tone="neutral">
                  {user.role === 'PROJECT_ENGINEER' ? 'Project Engineer' : 'Viewer'}
                </Pill>

                <span className={styles.toggleCell}>
                  <input
                    type="checkbox"
                    aria-label={`${user.name} can configure the plan`}
                    checked={user.canManagePlanConfiguration}
                    disabled={locked || setAccess.isPending}
                    onChange={(event) => change(user, event.target.checked)}
                  />
                  Can configure
                </span>
              </label>
            );
          })}
        </div>
      )}

      <p className={styles.settingNote}>
        Someone with this permission can rename fields, change what is required, add and archive
        fields, and set the booking rules above. Access cannot be removed from the last plan
        manager, or from yourself — a colleague has to do that, so nobody can lock the
        configuration away by accident. Adding and removing accounts is done outside the
        application; see <code>docs/managing-users.md</code>.
      </p>
    </section>
  );
}
