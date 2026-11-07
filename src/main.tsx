import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppLaunch } from './components/AppLaunch';
import './index.css';

const root = document.getElementById('root')!;
const bridge = 'gitApi' in window ? window.gitApi : undefined;
const hasDesktopStorage =
  typeof bridge === 'object' && bridge !== null && 'stateStorage' in bridge && bridge.stateStorage != null;
if (navigator.userAgent.includes('Electron/') && !hasDesktopStorage) {
  console.error('[startup] Electron preload bridge is unavailable; saved repositories were not changed.');
  const heading = document.createElement('h1');
  heading.textContent = 'GITVerse could not start';
  const detail = document.createElement('p');
  detail.textContent =
    'The desktop connection did not load. Your saved repositories have not been changed. Restart GITVerse. In development, stop and restart npm run dev.';
  root.append(heading, detail);
} else {
  createRoot(root).render(
    <React.StrictMode>
      <AppLaunch>
        <App />
      </AppLaunch>
    </React.StrictMode>,
  );
}
