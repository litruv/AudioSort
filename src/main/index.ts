import { app } from 'electron';
import { MainApp } from './MainApp';

const mainApp = new MainApp();

app.whenReady()
  .then(() => mainApp.initialize())
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console -- Logging critical boot failures is necessary for troubleshooting.
    console.error('Failed to initialise application', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  const processRef = (globalThis as { process?: { platform?: string } }).process;
  if (processRef?.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  mainApp.ensureWindow();
});

app.on('before-quit', () => {
  mainApp.dispose();
});
