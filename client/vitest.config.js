import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Frontend tests (spec §71).
 *
 * Components are rendered against a stubbed `fetch` rather than a mocked API
 * layer, so the tests exercise the real query client, the real CSRF handling
 * and the real error mapping.
 */
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(here, 'src'),
            '@shared': path.resolve(here, '..', 'shared'),
        },
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.test.{ts,tsx}'],
        css: { modules: { classNameStrategy: 'non-scoped' } },
        restoreMocks: true,
    },
});
