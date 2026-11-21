import { useEffect } from 'react';
import { platformApi } from '../platform/api';
import { useSettings } from '../store/settingsStore';

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function stepZoom(direction: 'in' | 'out' | 'reset') {
  const { zoom, set } = useSettings.getState();
  if (direction === 'reset') return set('zoom', 1);
  const next =
    direction === 'in'
      ? (ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
      : ([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0]);
  set('zoom', next);
}

/** Applies the saved zoom and handles Cmd/Ctrl + = / - / 0. */
export function useAppZoom() {
  const zoom = useSettings((s) => s.zoom);
  useEffect(() => {
    void platformApi()
      ?.setZoom?.(zoom)
      .catch(() => {});
  }, [zoom]);
  useEffect(() => {
    const stop = platformApi()?.onZoomKey?.(stepZoom);
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') stepZoom('in');
      else if (e.key === '-') stepZoom('out');
      else if (e.key === '0') stepZoom('reset');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stop?.();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
