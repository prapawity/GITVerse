import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { initPlatform, platformApi } from './platform/api';

const root = document.getElementById('root')!;

function showStartupError(message: string) {
  const heading = document.createElement('h1');
  heading.textContent = 'GITVerse by PRAPAWITY could not start';
  const detail = document.createElement('p');
  detail.textContent = message;
  root.append(heading, detail);
}

// Electron's preload sets the bridge synchronously, so a missing bridge is reported before any await
// (the smoke test reads this heading right after the page loads).
if (navigator.userAgent.includes('Electron/') && platformApi()?.stateStorage == null) {
  console.error('[startup] Electron preload bridge is unavailable; saved repositories were not changed.');
  showStartupError(
    'The desktop connection did not load. Your saved repositories have not been changed. Restart GITVerse by PRAPAWITY. In development, stop and restart npm run dev.',
  );
} else {
  void (async () => {
    try {
      // Tauri builds its bridge here (async IPC); Electron's is already in place.
      await initPlatform();
    } catch (error) {
      console.error('[startup] desktop bridge failed to initialize', error);
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
}
