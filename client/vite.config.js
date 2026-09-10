import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(here, 'src'),
            '@shared': path.resolve(here, '..', 'shared'),
        },
    },
    server: {
        port: 5173,
        strictPort: true,
        // In development the SPA runs on Vite and the API on Express. The proxy
        // keeps them same-origin so the session cookie behaves exactly as it does
        // in production, where one Node process serves both.
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:4000',
                changeOrigin: false,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
        // Hashed filenames, so the server can cache them for a year (see app.ts).
        assetsDir: 'assets',
        rollupOptions: {
            output: {
                manualChunks: {
                    react: ['react', 'react-dom', 'react-router-dom'],
                    query: ['@tanstack/react-query'],
                },
            },
        },
    },
});
