import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, useSettings } from './settingsStore';
import { storage } from '../lib/storage';

test('application font size uses presets and resets independently of terminal font size', () => {
  const previous = useSettings.getState();
  try {
    useSettings.getState().set('termFontSize', 20);
    for (const [value, expected] of [
      [10, 12],
      [30, 18],
      [15.7, 14],
      [12, 12],
      [14, 14],
      [18, 18],
      [NaN, 14],
    ]) {
      useSettings.getState().set('fontSize', value);
      assert.equal(useSettings.getState().fontSize, expected);
      assert.equal(useSettings.getState().termFontSize, 20);
    }
    useSettings.getState().reset();
    assert.equal(useSettings.getState().fontSize, DEFAULTS.fontSize);
  } finally {
    useSettings.setState(previous);
  }
});

test('font size persists, restores, and defaults for legacy or invalid saved settings', async () => {
  const previous = useSettings.getState();
  const originalGet = storage.getItem;
  const originalSet = storage.setItem;
  let saved: string | null = null;
  storage.getItem = () => saved;
  storage.setItem = (_key, value) => {
    saved = value;
  };
  try {
    useSettings.getState().set('fontSize', 17);
    assert.equal(JSON.parse(saved!).state.fontSize, 18);
    useSettings.setState({ fontSize: 14 });
    saved = JSON.stringify({ state: { fontSize: 17 }, version: 0 });
    await useSettings.persist.rehydrate();
    assert.equal(useSettings.getState().fontSize, 18);
    for (const state of [{ theme: 'light' }, { fontSize: 'huge' }, { fontSize: 100 }]) {
      saved = JSON.stringify({ state, version: 0 });
      await useSettings.persist.rehydrate();
      assert.equal(useSettings.getState().fontSize, 'fontSize' in state && state.fontSize === 100 ? 18 : 14);
    }
  } finally {
    storage.getItem = originalGet;
    storage.setItem = originalSet;
    useSettings.setState(previous);
  }
});
