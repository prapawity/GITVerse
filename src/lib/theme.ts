import { useSyncExternalStore } from 'react';
import { useSettings, type Settings } from '../store/settingsStore';

export type ConcreteTheme = Exclude<Settings['theme'], 'system'>;

const query = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
const subscribe = (onChange: () => void) => {
  const media = query();
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
};
const systemIsDark = () => query()?.matches ?? true;

/** The palette actually shown: "system" follows the OS light/dark setting and updates when it changes. */
export function useResolvedTheme(): ConcreteTheme {
  const theme = useSettings((s) => s.theme);
  const dark = useSyncExternalStore(subscribe, systemIsDark, () => true);
  return theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}
