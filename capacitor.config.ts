import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.codex.remote',
  appName: 'Codex Remote',
  webDir: 'packages/web/dist',
  server: {
    // Allow cleartext for local dev (when connecting to http://ip:port)
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#171816',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#171816',
    },
    Preferences: {
      group: 'codex-remote',
    },
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
