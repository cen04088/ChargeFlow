import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'Chargeflow',
  brand: {
    displayName: 'Chargeflow',
    primaryColor: '#3182F6',
    icon: 'https://chargeflow-production.up.railway.app/static/logo.png',
  },
  web: {
    host: 'chargeflow-production.up.railway.app',
    port: 443,
    commands: {
      dev: 'vite',
      build: 'tsc -b && vite build',
    },
  },
  permissions: [],
  outdir: 'dist',
  webViewProps: {
    type: 'partner',
  },
});
