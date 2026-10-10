import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Port 3000 is not a preference — Trigger.php hard-codes its CORS allow-list to
 * ['http://localhost:3000', 'https://baines.healthcare'] plus *.vizru-ras.com.
 * A non-matching Origin gets no CORS headers at all and the browser drops the
 * response, so the dev server must stay on 3000 (strictPort, no silent +1).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const platform = env.VIZRU_PLATFORM_URL || 'https://localhost';

  return {
    plugins: [react()],
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        // Dev default: go through the proxy so the self-signed platform cert
        // and CORS are both out of the picture. Set VITE_VIZRU_BASE_URL to call
        // the platform directly instead (see .env.example).
        '/workflow.trigger': {
          target: platform,
          changeOrigin: true,
          secure: false,
          headers: { Origin: 'http://localhost:3000' },
        },
      },
    },
    preview: { port: 3000, strictPort: true },
  };
});
