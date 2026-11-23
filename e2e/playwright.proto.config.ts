import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * Parcours du site prototype (celui qui est déployé), contre l'API heuristique.
 * Pas d'appel à un vrai modèle.
 */
const API_PORT = 8789;
const WEB_PORT = 8092;
const AUDIO_FIXTURE = fileURLToPath(
  new URL('../apps/api/src/fixtures/dictee.wav', import.meta.url),
);

export default defineConfig({
  testDir: './proto',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'off',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 390, height: 844 },
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${AUDIO_FIXTURE}`,
      ],
    },
  },
  webServer: [
    {
      command: 'node --import tsx src/main.ts',
      cwd: '../apps/api',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        API_PORT: String(API_PORT),
        API_BIND: '127.0.0.1',
        LLM_PROVIDER: 'heuristic',
        CLASSIFIER_PROVIDER: 'heuristic',
        STT_PROVIDER: 'none',
        DATA_DIR: '',
        SIM_BOOT: 'start',
      },
    },
    {
      command: `node serve-prototype.mjs ../prototypes/bino ${WEB_PORT} http://127.0.0.1:${API_PORT}`,
      cwd: '.',
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
