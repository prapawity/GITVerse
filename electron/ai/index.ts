import { app, ipcMain, shell } from 'electron';
import type { BridgedCall, Provider, ResolveResult, TurnRequest, TurnResult } from '../../src/shared/aiTypes';
import { claudeCommitMessage, claudeResolve, claudeSetKey, claudeStatus, claudeTurn } from './claude';
import { copilotAdvanceLogin, copilotBeginLogin, copilotCancelLogin, copilotCommitMessage, copilotModels, copilotResetConversation, copilotResolve, copilotSetToken, copilotShutdown, copilotStatus, copilotTurn } from './copilot';
import { err, errText, Hooks } from './common';
import { openaiCancelSignIn, openaiCommitMessage, openaiModels, openaiResolve, openaiSetKey, openaiSignIn, openaiSignOut, openaiStatus, openaiTurn } from './openai';

/**
 * All model access is here, in the main process: keys, tokens and sign-ins never reach the renderer.
 * The renderer owns the conversation and runs tools (it has the repository state and the approval UI).
 */
const controllers = new Map<number, AbortController>();
const claudeStreams = new Map<number, { abort(): void }>();
const waiting = new Map<string, { reqId: number; resolve: (r: { text: string; isError: boolean }) => void }>();
let callSeq = 0;

const cancelled = { text: 'The request was cancelled.', isError: true };

export function registerAi() {
  app.on('before-quit', () => { void copilotShutdown(); });

  ipcMain.handle('ai:status', () => ({ claude: claudeStatus(), openai: openaiStatus() }));
  ipcMain.handle('ai:copilotStatus', () => copilotStatus());

  const wrap = async <T>(fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
    try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: errText(e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') }; }
  };

  ipcMain.handle('ai:setKey', (_e, provider: Provider, key: string | null) =>
    wrap(async () => { if (provider === 'claude') claudeSetKey(key); else if (provider === 'openai') openaiSetKey(key); else await copilotSetToken(key); }));

  const openCopilotStep = async (step: Awaited<ReturnType<typeof copilotBeginLogin>>) => {
    if (step.kind === 'open-url') {
      const url = new URL(step.url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('GitHub returned an unexpected sign-in address.');
      await shell.openExternal(url.toString());
    }
    return step;
  };
  ipcMain.handle('ai:copilotBeginLogin', () => wrap(async () => openCopilotStep(await copilotBeginLogin())));
  ipcMain.handle('ai:copilotAdvanceLogin', () => wrap(async () => openCopilotStep(await copilotAdvanceLogin())));
  ipcMain.handle('ai:copilotCancelLogin', () => copilotCancelLogin());

  ipcMain.handle('ai:openaiSignIn', () => wrap(() => openaiSignIn((u) => { void shell.openExternal(u); })));
  ipcMain.handle('ai:openaiCancel', () => { openaiCancelSignIn(); });
  ipcMain.handle('ai:openaiSignOut', () => { openaiSignOut(); });
  ipcMain.handle('ai:models', (_e, provider: Provider) => wrap(() => (provider === 'openai' ? openaiModels() : provider === 'copilot' ? copilotModels() : Promise.resolve([]))));

  // ---- chat turn ----
  ipcMain.handle('ai:turn', async (e, req: TurnRequest): Promise<TurnResult> => {
    const ac = new AbortController();
    controllers.set(req.reqId, ac);
    const send = (ch: string, ...a: unknown[]) => { if (!e.sender.isDestroyed()) e.sender.send(ch, ...a); };
    const hooks: Hooks = {
      signal: ac.signal,
      onText: (d) => send('ai:delta', req.reqId, d),
      // a stateful provider ran into one of our tools: ask the renderer to run it (it may show an approval card first)
      callTool: (name, input) => new Promise((resolve) => {
        const callId = `c${++callSeq}`;
        waiting.set(callId, { reqId: req.reqId, resolve });
        ac.signal.addEventListener('abort', () => { if (waiting.delete(callId)) resolve(cancelled); }, { once: true });
        send('ai:toolcall', { reqId: req.reqId, callId, name, input } satisfies BridgedCall);
      }),
    };
    try {
      if (req.provider === 'claude') return await claudeTurn(req.messages, hooks, claudeStreams, req.reqId);
      if (req.provider === 'openai') return await openaiTurn(req.messages, req.model, hooks);
      return await copilotTurn(req.convId, req.messages, req.model, hooks);
    } catch (x) {
      return ac.signal.aborted ? { ok: false, aborted: true } : { ok: false, error: err('other', errText(x)) };
    } finally {
      controllers.delete(req.reqId);
      for (const [id, w] of waiting) if (w.reqId === req.reqId) { waiting.delete(id); w.resolve(cancelled); }
    }
  });

  ipcMain.handle('ai:toolResult', (_e, callId: string, r: { text: string; isError: boolean }) => { waiting.get(callId)?.resolve(r); waiting.delete(callId); });
  ipcMain.handle('ai:abort', (_e, reqId: number) => { controllers.get(reqId)?.abort(); claudeStreams.get(reqId)?.abort(); });
  ipcMain.handle('ai:reset', (_e, convId: number) => copilotResetConversation(convId));

  ipcMain.handle('ai:commitMessage', async (_e, provider: Provider, model: string | undefined, diff: string) => {
    if (!['claude', 'openai', 'copilot'].includes(provider) || typeof diff !== 'string' || !diff.trim() || diff.length > 150000) return { ok: false, error: err('other', 'Invalid staged diff or AI provider.') };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000);
    try {
      return provider === 'claude' ? await claudeCommitMessage(diff, ac.signal) : provider === 'openai' ? await openaiCommitMessage(diff, model, ac.signal) : await copilotCommitMessage(diff, model, ac.signal);
    } finally { clearTimeout(timer); }
  });

  // ---- "Auto-resolve with AI" ----
  ipcMain.handle('ai:resolveConflict', async (_e, provider: Provider, model: string | undefined, prompt: string, count: number): Promise<ResolveResult> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4 * 60_000);
    try {
      const r = provider === 'claude' ? await claudeResolve(prompt, count) : provider === 'openai' ? await openaiResolve(prompt, model, ac.signal) : await copilotResolve(prompt, model, ac.signal);
      if (!r.ok) return r;
      // keep only well-formed entries for regions that exist, and never accept leftover conflict markers
      return { ok: true, resolutions: r.resolutions.filter((x) => x.index >= 0 && x.index < count && !/^(<<<<<<<|=======|>>>>>>>)/m.test(x.resolved)) };
    } finally {
      clearTimeout(timer);
    }
  });
}
