import { create } from 'zustand';
import { FLOW_TYPES, TOOL_INPUT, TOOL_KIND, type ToolName } from '../shared/aiTools';
import { applyResolutions, describeRegions } from '../lib/conflicts';
import {
  providerLabel,
  type BridgedCall,
  type NMsg,
  type Provider,
  type ToolCall,
  type ToolResult,
  type TurnResult,
} from '../shared/aiTypes';
import { useRepo } from './repoStore';
import { flowFor, useSettings } from './settingsStore';

export type ToolStatus = 'awaiting' | 'running' | 'done' | 'error' | 'declined';
export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; bid: number; final?: boolean } // one bubble per model turn (Copilot: one per stretch between tool calls)
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: ToolStatus; result?: string }
  | { kind: 'note'; tone: 'error' | 'info'; text: string; auth?: boolean };

interface AiState {
  items: Item[];
  transcript: NMsg[]; // provider-neutral; each provider converts it (Claude additionally replays its own thinking blocks)
  busy: boolean;
  reqId: number;
  convId: number;
  bubble: number; // bubble that streamed text currently goes into
  confirm: ((ok: boolean) => void) | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reset: (note?: string) => void;
  answer: (ok: boolean) => void;
}

const ai = () => (window as any).gitApi?.ai;
let reqSeq = 0;
let bubbleSeq = 0;
let wired = false;

/** Run a repo action through the normal store path (overlay + toast), and turn its outcome into a tool result. */
async function report(run: () => Promise<void>): Promise<{ ok: boolean; text: string }> {
  const before = new Set(useRepo.getState().toasts.map((t) => t.id));
  await run();
  const fresh = useRepo.getState().toasts.filter((t) => !before.has(t.id));
  const bad = fresh.find((t) => t.kind === 'error');
  if (bad) return { ok: false, text: `${bad.title}: ${bad.detail ?? ''}`.trim() };
  const warn = fresh.find((t) => t.kind === 'warning');
  if (warn) return { ok: true, text: `${warn.title}. ${warn.detail ?? ''}`.trim() };
  return { ok: true, text: fresh.find((t) => t.kind === 'success')?.title ?? 'Done.' };
}

async function execute(name: ToolName, input: any): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  if (!r.repoPath) return { ok: false, text: 'No repository is open in GITVerse.' };
  const current = r.refs.local.find((b) => b.current)?.name ?? 'HEAD (detached)';
  switch (name) {
    case 'get_repo_status':
      return {
        ok: true,
        text: JSON.stringify({
          repository: r.repoPath.split('/').pop(),
          path: r.repoPath,
          branch: current,
          uncommitted_changes: r.status.length,
          changed_files: r.status.slice(0, 50).map((f) => `${f.index}${f.worktree} ${f.path}`),
          operation_in_progress: r.operation
            ? { kind: r.operation.kind, conflicted_files: r.operation.files, onto: r.operation.onto }
            : null,
          stashes: r.refs.stashes.length,
        }),
      };
    case 'list_branches': {
      const f = (input.filter ?? '').toLowerCase();
      const m = (n: string) => n.toLowerCase().includes(f);
      return {
        ok: true,
        text: JSON.stringify({
          current,
          local: r.refs.local
            .map((b) => b.name)
            .filter(m)
            .slice(0, 300),
          remote: r.refs.remote
            .map((b) => b.name)
            .filter(m)
            .slice(0, 300),
        }),
      };
    }
    case 'recent_commits':
      return {
        ok: true,
        text: JSON.stringify(
          r.commits.slice(0, input.limit ?? 15).map((c) => ({
            hash: c.hash.slice(0, 7),
            subject: c.subject,
            author: c.author,
            date: c.date,
            refs: c.refs.map((x) => x.name),
          })),
        ),
      };
    case 'fetch':
      return report(() => r.action('fetch'));
    case 'pull':
      return report(() => r.action('pull'));
    case 'push':
      return report(() => r.action('push'));
    case 'stash':
      return report(() => r.action('stash'));
    case 'stash_pop':
      return report(() => r.action('stashPop'));
    case 'checkout':
      return report(() => r.checkout(input.ref));
    case 'create_branch':
      return report(() => (input.from ? r.exec('createBranch', input.name, input.from) : r.createBranch(input.name)));
    case 'rebase':
      return withOp(await report(() => r.exec('rebaseOnto', input.onto)));
    case 'merge':
      return withOp(await report(() => r.exec('merge', input.ref, input.no_ff ?? true)));
    case 'flow_start':
      return flowStart(input);
    case 'flow_finish':
      return flowFinish(input);
    case 'get_conflicts':
      return getConflicts();
    case 'get_conflict_file':
      return getConflictFile(input.path);
    case 'resolve_conflict_file':
      return resolveConflictFile(input.path, input.resolutions);
    case 'continue_operation':
      return operate('opContinue', true);
    case 'skip_commit':
      return operate('opSkip', true);
    case 'abort_operation':
      return operate('opAbort', false);
  }
}

// ---------- conflicts ----------
const gitApi = () => (window as any).gitApi;
const MAX_FILE = 200_000;
const clip = (t: string, n = 8000) =>
  t.length > n ? t.slice(0, n) + `\n…[${t.length - n} more characters not shown]` : t;

/** If the last action left an operation stopped on conflicts, say so in the tool result so the model's next step is obvious. */
function withOp(res: { ok: boolean; text: string }) {
  const op = useRepo.getState().operation;
  if (!op) return res;
  return {
    ok: res.ok,
    text: `${res.text}\nThe ${op.kind} is now STOPPED with ${op.files.length} conflicted file(s): ${op.files.join(', ') || '(none left — ready to continue)'}. Use get_conflicts to continue.`,
  };
}

async function getConflicts(): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  const op = r.operation;
  if (!op)
    return {
      ok: true,
      text: JSON.stringify({ operation: null, note: 'No merge, rebase, cherry-pick or revert is in progress.' }),
    };
  const files = await Promise.all(
    op.files.map(async (p) => {
      try {
        return { path: p, regions: describeRegions(await gitApi().readWorkFile(r.repoPath, p)).length };
      } catch {
        return { path: p, regions: null, note: 'could not read (binary, or deleted on one side)' };
      }
    }),
  );
  return {
    ok: true,
    text: JSON.stringify({
      operation: op.kind,
      step: op.step ?? null,
      branch: op.head,
      onto: op.onto,
      A_means: op.kind === 'rebase' ? `${op.onto} (what you rebase onto)` : `${op.head} (current branch)`,
      B_means: op.kind === 'rebase' ? `${op.head} (your commit being replayed)` : `${op.onto} (incoming)`,
      conflicted_files: files,
      already_resolved: op.resolved.map((x) => x.path),
      ready_to_continue: op.files.length === 0,
    }),
  };
}

async function getConflictFile(path: string): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  if (!r.operation?.files.includes(path))
    return { ok: false, text: `"${path}" is not one of the conflicted files. Use get_conflicts for the list.` };
  let src: string;
  try {
    src = await gitApi().readWorkFile(r.repoPath, path);
  } catch (e: any) {
    return { ok: false, text: `Could not read the file: ${e?.message ?? e}` };
  }
  if (src.length > MAX_FILE)
    return { ok: false, text: 'This file is too large to resolve from chat. Resolve it in the merge tool.' };
  const regions = describeRegions(src, 20);
  if (!regions.length)
    return {
      ok: false,
      text: 'No conflict markers found — the file may be binary, or one side deleted it. Resolve it in the merge tool.',
    };
  return {
    ok: true,
    text: JSON.stringify({
      path,
      region_count: regions.length,
      regions: regions.map((g) => ({
        ...g,
        A: clip(g.A),
        B: clip(g.B),
        base: g.base == null ? undefined : clip(g.base),
      })),
    }),
  };
}

async function resolveConflictFile(
  path: string,
  resolutions: { index: number; resolved: string }[],
): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  if (!r.operation?.files.includes(path)) return { ok: false, text: `"${path}" is not one of the conflicted files.` };
  let src: string;
  try {
    src = await gitApi().readWorkFile(r.repoPath, path);
  } catch (e: any) {
    return { ok: false, text: `Could not read the file: ${e?.message ?? e}` };
  }
  const out = applyResolutions(src, resolutions);
  if (!out.ok) return { ok: false, text: out.error }; // nothing is written unless the answer is complete and clean
  try {
    await gitApi().writeWorkFile(r.repoPath, path, out.text);
  } catch (e: any) {
    return { ok: false, text: `Could not write the file: ${e?.message ?? e}` };
  }
  const staged = await report(() => r.exec('resolveFile', path, 'mark'));
  if (!staged.ok) return staged;
  const left = useRepo.getState().operation?.files.length ?? 0;
  return {
    ok: true,
    text: `Resolved and staged ${path}. ${left} conflicted file(s) left${left ? '' : ' — call continue_operation'}.`,
  };
}

async function operate(
  name: 'opContinue' | 'opSkip' | 'opAbort',
  needsFiles: boolean,
): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  const op = r.operation;
  if (!op) return { ok: false, text: 'Nothing is in progress.' };
  if (name === 'opContinue' && op.files.length)
    return { ok: false, text: `${op.files.length} file(s) still have conflicts: ${op.files.join(', ')}.` };
  if (name === 'opSkip' && op.kind === 'merge')
    return { ok: false, text: 'A merge cannot skip a commit. Resolve the conflicts or abort.' };
  void needsFiles;
  return withOp(await report(() => r.exec(name, op.kind)));
}

// ---------- Git Flow ----------
const localBranch = (n: string) => useRepo.getState().refs.local.some((b) => b.name === n);

async function flowStart(input: {
  type: (typeof FLOW_TYPES)[number];
  name: string;
  from?: string;
}): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  const cfg = flowFor(r.repoPath);
  const base = input.from ?? (input.type === 'hotfix' || input.type === 'support' ? cfg.main : cfg.develop);
  const full = `${cfg[input.type]}${input.name.trim().replace(/\s+/g, '-')}`;
  if (localBranch(full)) return { ok: false, text: `Branch "${full}" already exists.` };
  const known =
    localBranch(base) ||
    r.refs.remote.some((b) => b.name === `origin/${base}`) ||
    r.commits.some((c) => c.hash.startsWith(base));
  if (!known)
    return {
      ok: false,
      text: `The start point "${base}" does not exist here. Check the Gitflow branch names in Preferences, or pass "from".`,
    };
  return report(() => r.exec('branchAt', full, base));
}

async function flowFinish(input: {
  delete_branch?: boolean;
  tag_message?: string;
}): Promise<{ ok: boolean; text: string }> {
  const r = useRepo.getState();
  const cfg = flowFor(r.repoPath);
  const cur = r.refs.local.find((b) => b.current)?.name;
  if (!cur) return { ok: false, text: 'HEAD is detached — check out the flow branch first.' };
  const type = FLOW_TYPES.find((t) => cfg[t] && cur.startsWith(cfg[t]));
  if (!type)
    return {
      ok: false,
      text: `"${cur}" is not a Git Flow branch (expected a prefix like ${FLOW_TYPES.map((t) => cfg[t]).join(' ')}).`,
    };
  if (type === 'support') return { ok: false, text: 'Support branches are long-lived; they are not finished.' };
  if (r.operation) return { ok: false, text: `A ${r.operation.kind} is in progress — finish or abort it first.` };
  if (r.status.length)
    return {
      ok: false,
      text: `The working tree has ${r.status.length} uncommitted change(s). Commit or stash them first.`,
    };
  const suffix = cur.slice(cfg[type].length);
  const targets = type === 'feature' || type === 'bugfix' ? [cfg.develop] : [cfg.main, cfg.develop];
  const missing = targets.filter((t) => !localBranch(t));
  if (missing.length)
    return {
      ok: false,
      text: `Missing local branch(es): ${missing.join(', ')}. Check the Gitflow branch names in Preferences.`,
    };

  const done: string[] = [];
  const stop = (why: string) => ({
    ok: false,
    text: `${why}\nCompleted so far: ${done.join('; ') || 'nothing'}.\n${useRepo.getState().operation ? 'A merge is stopped on conflicts — resolve them (get_conflicts), continue_operation, then run the remaining steps by hand (or call flow_finish again from the target branch).' : ''}`.trim(),
  });
  for (const target of targets) {
    let res = await report(() => useRepo.getState().checkout(target));
    if (!res.ok) return stop(`Could not check out ${target}: ${res.text}`);
    done.push(`checked out ${target}`);
    res = await report(() => useRepo.getState().exec('merge', cur, true));
    if (!res.ok) return stop(`Merging ${cur} into ${target} failed: ${res.text}`);
    if (useRepo.getState().operation) return stop(`Merging ${cur} into ${target} stopped on conflicts.`);
    done.push(`merged ${cur} into ${target}`);
    if (target === cfg.main) {
      res = await report(() =>
        useRepo.getState().exec('createAnnotatedTag', suffix, 'HEAD', input.tag_message || `${type} ${suffix}`),
      );
      if (!res.ok) return stop(`Could not tag ${suffix}: ${res.text}`);
      done.push(`tagged ${suffix}`);
    }
  }
  if (input.delete_branch !== false) {
    const res = await report(() => useRepo.getState().exec('deleteBranch', cur));
    if (!res.ok) return stop(`Could not delete ${cur}: ${res.text}`);
    done.push(`deleted ${cur}`);
  }
  return { ok: true, text: `Finished ${type} "${suffix}": ${done.join(', ')}. Nothing was pushed.` };
}

const modelFor = (p: Provider) => {
  const s = useSettings.getState();
  return (p === 'openai' ? s.openaiModel : p === 'copilot' ? s.copilotModel : '') || undefined;
};

export const useAi = create<AiState>((set, get) => {
  const push = (it: Item) => set((s) => ({ items: [...s.items, it] }));
  const patchTool = (id: string, p: Partial<Extract<Item, { kind: 'tool' }>>) =>
    set((s) => ({ items: s.items.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, ...p } : it)) }));
  const startBubble = () => {
    const bid = ++bubbleSeq;
    set((s) => ({ bubble: bid, items: [...s.items, { kind: 'assistant', text: '', bid }] }));
    return bid;
  };

  /** One tool call, from either source: our own loop (Claude, ChatGPT) or a call the Copilot runtime made. Validates,
   *  asks the user before anything that changes the repository, runs it, and reports what happened. */
  async function runTool(call: ToolCall, bridged = false): Promise<ToolResult> {
    const schema = TOOL_INPUT[call.name as ToolName];
    const parsed = schema?.safeParse(call.input);
    push({ kind: 'tool', id: call.id, name: call.name, input: call.input, status: 'running' });
    if (bridged) startBubble(); // text after a tool card belongs below it
    if (!schema || !parsed!.success) {
      patchTool(call.id, { status: 'error', result: 'Invalid tool input' });
      return { id: call.id, text: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }), isError: true };
    }
    if (TOOL_KIND[call.name] === 'write') {
      patchTool(call.id, { status: 'awaiting' });
      const ok = await new Promise<boolean>((resolve) => set({ confirm: resolve }));
      set({ confirm: null });
      if (!ok) {
        patchTool(call.id, { status: 'declined' });
        return { id: call.id, text: 'The user declined this action.', isError: false };
      }
      patchTool(call.id, { status: 'running' });
    }
    const out = await execute(call.name as ToolName, parsed!.data);
    patchTool(call.id, { status: out.ok ? 'done' : 'error', result: out.text });
    return { id: call.id, text: out.text, isError: !out.ok };
  }

  function wire() {
    const api = ai();
    if (wired || !api) return;
    wired = true;
    // streamed text goes into the current bubble; a bubble stops accepting text once its turn's final text arrived
    api.onDelta((_id: number, d: string) =>
      set((s) => ({
        items: s.items.map((it) =>
          it.kind === 'assistant' && it.bid === s.bubble && !it.final ? { ...it, text: it.text + d } : it,
        ),
      })),
    );
    api.onToolCall(async (c: BridgedCall) => {
      const r = await runTool({ id: c.callId, name: c.name, input: c.input }, true);
      await api.toolResult(c.callId, { text: r.text, isError: r.isError });
    });
  }

  return {
    items: [],
    transcript: [],
    busy: false,
    reqId: 0,
    convId: 1,
    bubble: 0,
    confirm: null,

    reset: (note) => {
      if (get().busy) return;
      ai()?.reset(get().convId);
      set((s) => ({
        items: note ? [{ kind: 'note', tone: 'info', text: note }] : [],
        transcript: [],
        convId: s.convId + 1,
      }));
    },
    stop: () => {
      const { reqId, confirm } = get();
      ai()?.abort(reqId);
      confirm?.(false);
    },
    answer: (ok) => get().confirm?.(ok),

    send: async (text) => {
      const api = ai();
      if (!api || get().busy || !text.trim()) return;
      wire();
      const provider = useSettings.getState().aiProvider;
      const model = modelFor(provider);

      push({ kind: 'user', text });
      set((s) => ({ busy: true, transcript: [...s.transcript, { role: 'user', text }] }));
      try {
        for (let round = 0; round < 40; round++) {
          // hard stop on runaway loops (conflict work takes several calls per file)
          const reqId = ++reqSeq;
          set({ reqId });
          const bid = startBubble();
          const res: TurnResult = await api.turn({
            reqId,
            provider,
            convId: get().convId,
            model,
            messages: get().transcript,
          });
          if (!res.ok) {
            if ('aborted' in res) push({ kind: 'note', tone: 'info', text: 'Stopped.' });
            else push({ kind: 'note', tone: 'error', text: res.error.message, auth: res.error.kind === 'auth' });
            // The first request of this send failed: drop the unanswered user text so the history stays valid.
            // Later rounds end with tool results, which stay — the next user message simply follows them.
            if (round === 0) set((s) => ({ transcript: s.transcript.slice(0, -1) }));
            return;
          }
          // The final message is authoritative for providers that run the loop here. Copilot's text is spread over
          // several bubbles (between its own tool calls), so there the streamed text stays as it is.
          if (provider !== 'copilot')
            set((s) => ({
              items: s.items.map((it) =>
                it.kind === 'assistant' && it.bid === bid ? { ...it, text: res.text, final: true } : it,
              ),
            }));
          set((s) => ({
            transcript: [
              ...s.transcript,
              { role: 'assistant', text: res.text, calls: res.calls, native: res.native, by: provider },
            ],
          }));
          if (res.stop === 'refusal') {
            push({ kind: 'note', tone: 'info', text: `${providerLabel(provider)} declined this request.` });
            return;
          }
          if (!res.calls.length) return;
          if (res.stop === 'max') {
            push({ kind: 'note', tone: 'error', text: 'The reply was cut off. Try a shorter request.' });
            return;
          }

          const results: ToolResult[] = [];
          for (const call of res.calls) results.push(await runTool(call));
          set((s) => ({ transcript: [...s.transcript, { role: 'tool', results }] })); // all results in one message
        }
        push({ kind: 'note', tone: 'info', text: 'Stopped after many steps — send another message to continue.' });
      } finally {
        set({ busy: false, confirm: null });
      }
    },
  };
});
