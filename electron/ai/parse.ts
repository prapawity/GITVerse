import { ConflictResolution } from '../../src/shared/aiTools';
import type { AiErr, ResolveResult } from '../../src/shared/aiTypes';

/** Provider helpers with no Electron dependency (also bundled into the Copilot sidecar). */
export const err = (kind: AiErr['kind'], message: string): AiErr => ({ kind, message });
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Callbacks a provider uses while a turn runs. */
export interface Hooks {
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** Stateful providers (Copilot) run tools themselves; this hands a call to the app and waits for its result. */
  callTool: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/** Shared by every provider that returns the resolution as JSON text. */
export function parseResolution(text: string): ResolveResult {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const p = ConflictResolution.safeParse(JSON.parse(m ? m[0] : text));
    if (p.success) return { ok: true, resolutions: p.data.resolutions };
  } catch {
    /* fall through */
  }
  return { ok: false, error: err('other', 'The AI did not return a usable result. Try again.') };
}
