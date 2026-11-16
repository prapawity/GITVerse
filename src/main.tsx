import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { initPlatform, platformApi } from './platform/api';

const root = document.getElementById('root')!;

function showStartupError(message: string) {
  const heading = document.createElement('h1');
  heading.textContent = 'GITVerse could not start';
  const detail = document.createElement('p');
  detail.textContent = message;
  root.append(heading, detail);
}

void (async () => {
  try {
    await initPlatform();
  } catch (error) {
    console.error('[startup] desktop bridge failed to initialize', error);
  }
  const hasDesktopStorage = platformApi()?.stateStorage != null;
  if (navigator.userAgent.includes('Electron/') && !hasDesktopStorage) {
    console.error('[startup] Electron preload bridge is unavailable; saved repositories were not changed.');
    showStartupError(
      'The desktop connection did not load. Your saved repositories have not been changed. Restart GITVerse. In development, stop and restart npm run dev.',
    );
    return;
  }
  // Imported only after the bridge exists: the stores read persisted state when their modules load.
  const [{ default: App }, { AppLaunch }] = await Promise.all([import('./App'), import('./components/AppLaunch')]);
  createRoot(root).render(
    <React.StrictMode>
      <AppLaunch>
        <App />
      </AppLaunch>
    </React.StrictMode>,
  );
})();
