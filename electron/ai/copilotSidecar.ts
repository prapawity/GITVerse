/**
 * Copilot sidecar for the Tauri build: the official Copilot SDK only runs on Node, so the Rust backend starts
 * `node copilot-sidecar.mjs` and talks to it with one JSON object per line.
 *
 *   in : {id, method, params}                       → out: {id, result} | {id, error}
 *   in : {method:'toolResult', params:{callId, text, isError}} | {method:'abort', params:{reqId}}
 *   out: {event:'delta', reqId, text} | {event:'toolcall', reqId, callId, name, input}
 *
 * The GitHub token stays in the OS keychain on the Rust side and only arrives here through `setToken`.
 */
import { createInterface } from 'node:readline';
import type { NMsg } from '../../src/shared/aiTypes';
import spec from '../../src/shared/aiSpec.json';
import {
  configureCopilot,
  copilotAdvanceLogin,
  copilotBeginLogin,
  copilotCancelLogin,
  copilotCommitMessage,
  copilotModels,
  copilotResetConversation,
  copilotResolve,
  copilotSetToken,
  copilotShutdown,
  copilotStatus,
  copilotTurn,
} from './copilot';
import { err, errText } from './parse';

// stdout carries the protocol only: anything else the SDK prints goes to stderr
const out = process.stdout.write.bind(process.stdout);
const send = (msg: unknown) => out(JSON.stringify(msg) + '\n');
console.log = console.info = console.debug = console.warn = (...a: unknown[]) => console.error(...a);

let token: string | null = null;
configureCopilot({ readToken: () => token, writeToken: (t) => (token = t), canEncrypt: () => true });

const controllers = new Map<number, AbortController>();
const waiting = new Map<string, (r: { text: string; isError: boolean }) => void>();
let callSeq = 0;
const cancelled = { text: 'Cancelled.', isError: true };

type P = Record<string, any>;
const signalFor = (ms: number) => AbortSignal.timeout(ms);

const methods: Record<string, (p: P) => Promise<unknown> | unknown> = {
  setToken: (p) => copilotSetToken(p.token ?? null),
  status: () => copilotStatus(),
  models: () => copilotModels(),
  beginLogin: () => copilotBeginLogin(),
  advanceLogin: () => copilotAdvanceLogin(),
  cancelLogin: () => copilotCancelLogin(),
  reset: (p) => copilotResetConversation(p.convId),
  commit: (p) => copilotCommitMessage(p.diff, p.model ?? undefined, signalFor(180_000)),
  pullRequest: (p) => copilotCommitMessage(p.prompt, p.model ?? undefined, signalFor(180_000), spec.prSystem),
  resolve: (p) => copilotResolve(p.prompt, p.model ?? undefined, signalFor(240_000)),
  turn: async (p) => {
    const reqId: number = p.reqId;
    const ac = new AbortController();
    controllers.set(reqId, ac);
    try {
      return await copilotTurn(p.convId ?? 0, p.messages as NMsg[], p.model ?? undefined, {
        signal: ac.signal,
        onText: (text) => send({ event: 'delta', reqId, text }),
        callTool: (name, input) =>
          new Promise((resolve) => {
            const callId = `c${++callSeq}`;
            waiting.set(callId, resolve);
            ac.signal.addEventListener('abort', () => waiting.delete(callId) && resolve(cancelled), { once: true });
            send({ event: 'toolcall', reqId, callId, name, input });
          }),
      });
    } catch (x) {
      return ac.signal.aborted ? { ok: false, aborted: true } : { ok: false, error: err('other', errText(x)) };
    } finally {
      controllers.delete(reqId);
    }
  },
  shutdown: async () => {
    await copilotShutdown();
    setTimeout(() => process.exit(0), 10);
  },
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: { id?: number; method?: string; params?: P };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const p = msg.params ?? {};
  if (msg.method === 'toolResult') {
    waiting.get(p.callId)?.({ text: String(p.text ?? ''), isError: !!p.isError });
    waiting.delete(p.callId);
    return;
  }
  if (msg.method === 'abort') {
    controllers.get(p.reqId)?.abort();
    return;
  }
  const fn = msg.method ? methods[msg.method] : undefined;
  if (!fn) {
    send({ id: msg.id, error: `Unknown method: ${msg.method}` });
    return;
  }
  Promise.resolve()
    .then(() => fn(p))
    .then(
      (result) => send({ id: msg.id, result: result ?? null }),
      (e) => send({ id: msg.id, error: errText(e) }),
    );
});
// the app went away: stop the Copilot runtime too
rl.on('close', () => {
  void copilotShutdown().finally(() => process.exit(0));
});
