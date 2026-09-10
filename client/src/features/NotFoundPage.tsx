import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * The sitemap is small on purpose (spec §6, §7), so an unknown path is almost
 * always a stale link. Point back at the plan rather than explaining HTTP.
 */
export function NotFoundPage() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 'var(--space-9)' }}>
      <EmptyState
        icon={<Compass size={26} strokeWidth={1.5} />}
        title="That page does not exist"
        body="CommitteeFlow has three places: the Committee Plan, Activity, and Plan Configuration."
        action={
          <Link
            to="/plan"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 'var(--control-height)',
              padding: '0 var(--space-5)',
              background: 'var(--ink)',
              color: 'var(--surface-panel)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Open the Committee Plan
          </Link>
        }
      />
    </div>
  );
}
