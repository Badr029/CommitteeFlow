/**
 * The published sign-ins for the review deployment.
 *
 * A public demo that asks a stranger for credentials is not a demo. These are
 * the accounts `npm run demo` creates, and the sign-in screen offers them so a
 * visitor can be inside the plan in one click instead of hunting for a password
 * on the page that sent them.
 *
 * **Off unless asked for.** The hint appears only when `VITE_DEMO_ACCOUNTS` is
 * set at build time, so a real installation never advertises an account that
 * does not exist there. Vercel carries it for the demo project; nothing else
 * does.
 *
 * Keep this list in step with `server/scripts/demo.ts` — it is the same pair of
 * accounts described from the other side, and a mismatch shows up as a demo that
 * refuses its own credentials.
 */

export interface DemoAccount {
  label: string;
  /** What this account can do, in the words a visitor would use. */
  can: string;
  email: string;
  password: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    label: 'Project Engineer',
    can: 'Book, edit, cancel, import, configure',
    email: 'engineer@demo.committeeflow.app',
    password: 'DemoEngineer#2026',
  },
  {
    label: 'Viewer',
    can: 'Read the plan and export it',
    email: 'viewer@demo.committeeflow.app',
    password: 'DemoViewer#2026',
  },
];

/**
 * Whether this build is the public demo.
 *
 * Read with dot notation deliberately. Vite replaces
 * `import.meta.env.VITE_DEMO_ACCOUNTS` with a literal at build time, so this
 * whole constant folds to `false` in an ordinary build and the bundler drops the
 * panel — and these addresses with it. Bracket notation would survive as a
 * runtime lookup and ship the credentials to every installation.
 */
export const isDemoBuild = import.meta.env.VITE_DEMO_ACCOUNTS === 'true';
