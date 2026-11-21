import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  ListPlus,
  Loader2,
  PenLine,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';
import { desktopApi } from '../platform/api';
import {
  detectHostedRepo,
  HOST_KINDS,
  HOST_LABEL,
  remoteHost,
  REQUEST_NOUN,
  tokenPageUrl,
  type ConnectResult,
  type HostedRepo,
  type HostKind,
} from '../shared/pullRequests';
import {
  aiPrompt,
  commitList,
  compare,
  connectHost,
  createRequest,
  defaultBranch,
  existingRequest,
  HostError,
  parseAiResult,
  pastRequests,
  REQUESTS_CHANGED,
  savedKindKey,
  templates as loadTemplates,
  titleFromBranch,
  issueFromBranch,
  type Template,
} from '../lib/pullRequests';
import { askConfirm } from './Dialogs';

const field =
  'w-full rounded-md border border-surface bg-crust px-3 py-2 outline-none transition-colors focus:border-accent';
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const TOKEN_HELP: Record<HostKind, string> = {
  github: 'A personal access token with the "repo" scope (classic), or Pull requests: read & write (fine-grained).',
  gitlab: 'A personal access token with the "api" scope. Your Git password cannot be used for the GitLab API.',
  bitbucket: 'Enter "username:app-password" (Pull requests: write) or a repository access token.',
};

type Connection = { state: 'checking' } | { state: 'needed'; tried: string[] } | ({ state: 'ok' } & ConnectResult);
type Mode = 'manual' | 'ai';
type AiPhase = 'idle' | 'reading' | 'examples' | 'writing' | 'typing' | 'done';

const AI_STEPS: { phase: AiPhase; label: (n: number, noun: string) => string }[] = [
  { phase: 'reading', label: () => 'Reading commits and changes' },
  {
    phase: 'examples',
    label: (n, noun) => (n ? `Learning from ${n} earlier ${noun}s` : 'Looking for earlier examples'),
  },
  { phase: 'writing', label: () => 'Writing title and description' },
];
const ORDER: AiPhase[] = ['idle', 'reading', 'examples', 'writing', 'typing', 'done'];

export function PullRequestDialog({
  repo: cwd,
  onClose,
  onPush,
}: {
  repo: string;
  onClose: () => void;
  onPush: () => void;
}) {
  const refs = useRepo((s) => s.refs);
  const [remote, setRemote] = useState<string | null>(null);
  const [override, setOverride] = useState<HostKind | null>(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<Connection>({ state: 'needed', tried: [] });
  const [token, setToken] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [mode, setMode] = useState<Mode>('manual');
  const [commits, setCommits] = useState<string[] | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhase>('idle');
  const [exampleCount, setExampleCount] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  const touched = useRef({ title: false, body: false });
  const typing = useRef(0);
  const aiBusy = aiPhase !== 'idle' && aiPhase !== 'done';
  const busy = creating || aiBusy || verifying || connection.state === 'checking';

  // the origin remote decides the provider
  useEffect(() => {
    let active = true;
    desktopApi()
      .remoteUrl(cwd)
      .then((url: string) => {
        if (!active) return;
        setRemote(url);
        const host = remoteHost(url);
        const saved = host ? desktopApi().stateStorage.getItem(savedKindKey(host)) : null;
        if (saved && (HOST_KINDS as string[]).includes(saved)) setOverride(saved as HostKind);
      })
      .catch(() => active && setError('This repository has no "origin" remote. Add one to create a pull request.'));
    return () => {
      active = false;
    };
  }, [cwd]);
  const hosted: HostedRepo | null = useMemo(
    () => (remote ? detectHostedRepo(remote, override) : null),
    [remote, override],
  );
  const detected = useMemo(() => (remote ? detectHostedRepo(remote) : null), [remote]);
  const noun = hosted ? REQUEST_NOUN[hosted.kind] : 'Pull Request';
  const connected = connection.state === 'ok';

  const originBranches = useMemo(
    () =>
      refs.remote
        .map((r) => r.name)
        .filter((name) => name.startsWith('origin/'))
        .map((name) => name.slice(7))
        .sort((a, b) => a.localeCompare(b)),
    [refs.remote],
  );
  const current = refs.local.find((b) => b.current);
  const headLocal = refs.local.find((b) => b.name === head);
  const headPushed = originBranches.includes(head);
  const unpushed = (headLocal && headPushed ? headLocal.ahead : 0) ?? 0;

  // connect: saved token, else credentials already on this machine
  const connect = async (entered?: string) => {
    if (!hosted) return;
    if (!entered) setConnection({ state: 'checking' });
    setError('');
    try {
      const result = await connectHost(hosted, entered);
      if (result.connected) {
        setConnection({ state: 'ok', ...result });
        setToken('');
        // the sidebar list may be showing a "token missing" error: let it load again
        window.dispatchEvent(new Event(REQUESTS_CHANGED));
      } else if (entered) setError(`${hosted.host} did not accept this token. Check that it has the right scope.`);
      else setConnection({ state: 'needed', tried: result.tried ?? [] });
    } catch (e) {
      setError(clean(e));
      if (!entered) setConnection({ state: 'needed', tried: [] });
    }
  };
  // default branches once connected
  useEffect(() => {
    if (!hosted || !connected) return;
    let active = true;
    setHead((value) => value || current?.name || '');
    defaultBranch(hosted)
      .then((name) => active && name && setBase((value) => value || name))
      .catch(() => {
        const fallback = ['main', 'master', 'develop'].find((b) => originBranches.includes(b));
        if (active && fallback) setBase((value) => value || fallback);
      });
    return () => {
      active = false;
    };
  }, [hosted, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // project templates for the target branch
  useEffect(() => {
    if (!hosted || !connected || !base) return;
    let active = true;
    void loadTemplates(hosted, cwd, base).then((list) => {
      if (!active) return;
      setTemplates(list);
      if (list[0]) {
        setTemplate((value) => value || list[0].name);
        if (!touched.current.body) setBody((value) => value || list[0].body);
      }
    });
    return () => {
      active = false;
    };
  }, [hosted, connected, base, cwd]);

  // commits on the branch (pre-fill) and an already-open request for the pair
  useEffect(() => {
    setExisting(null);
    setCommits(null);
    if (!hosted || !connected || !base || !head || !headPushed || base === head) return;
    let active = true;
    existingRequest(hosted, base, head)
      .then((url) => active && setExisting(url))
      .catch(() => {});
    compare(hosted, base, head)
      .then((c) => active && setCommits(c.commits))
      .catch(() => active && setCommits([]));
    return () => {
      active = false;
    };
  }, [hosted, connected, base, head, headPushed]);

  // a branch made for an issue (feature/123-…) closes it when merged
  useEffect(() => {
    const issue = issueFromBranch(head);
    if (!issue || touched.current.body) return;
    setBody((value) =>
      new RegExp(`#${issue}\\b`).test(value)
        ? value
        : `${value.trimEnd()}${value.trim() ? '\n\n' : ''}Closes #${issue}`,
    );
  }, [head, templates]);

  // manual pre-fill: a single commit's subject, else a title made from the branch name
  useEffect(() => {
    if (!head || touched.current.title || aiPhase !== 'idle') return;
    const subjects = commitList(commits ?? [])
      .split('\n')
      .filter(Boolean);
    setTitle(subjects.length === 1 ? subjects[0].slice(2) : titleFromBranch(head));
  }, [head, commits, aiPhase]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !document.querySelector('[role="dialog"][aria-label]')) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, busy]);
  useEffect(() => () => cancelAnimationFrame(typing.current), []);

  const chooseKind = (kind: HostKind) => {
    const host = remote ? remoteHost(remote) : null;
    if (!host || detected) return;
    desktopApi().stateStorage.setItem(savedKindKey(host), kind);
    setOverride(kind);
  };

  const submitToken = async () => {
    if (!token.trim() || verifying) return;
    setVerifying(true);
    await connect(token.trim());
    setVerifying(false);
  };

  const applyTemplate = async (name: string) => {
    const next = templates.find((t) => t.name === name);
    setTemplate(name);
    if (!next) return;
    if (body.trim() && body !== templates.find((t) => t.name === template)?.body) {
      if (!(await askConfirm('Replace description?', 'Applying the template replaces the current description.')))
        return;
    }
    setBody(next.body);
    touched.current.body = false;
  };

  const insertCommits = () => {
    const list = commitList(commits ?? []);
    if (!list) return;
    setBody((value) => `${value.trimEnd()}${value.trim() ? '\n\n' : ''}${list}\n`);
    touched.current.body = true;
  };

  /** Reveal the AI text progressively in the fields; the user can edit as soon as it finishes. */
  const typeIn = (nextTitle: string, nextBody: string) =>
    new Promise<void>((resolve) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTitle(nextTitle);
        setBody(nextBody);
        return resolve();
      }
      const total = nextTitle.length + nextBody.length;
      const duration = Math.min(1600, 300 + total * 2);
      const start = performance.now();
      const frame = (now: number) => {
        const shown = Math.round(Math.min(1, (now - start) / duration) * total);
        setTitle(nextTitle.slice(0, shown));
        setBody(nextBody.slice(0, Math.max(0, shown - nextTitle.length)));
        if (shown < total) typing.current = requestAnimationFrame(frame);
        else resolve();
      };
      typing.current = requestAnimationFrame(frame);
    });

  const generate = async () => {
    if (!hosted || busy) return;
    if (!headPushed) return setError(`Push "${head}" first: AI reads the changes from ${hosted.host}.`);
    const templateBody = templates.find((t) => t.name === template)?.body ?? '';
    const notes = touched.current.body && body.trim() && body !== templateBody ? body : '';
    if (
      (touched.current.title || notes) &&
      !(await askConfirm('Replace title and description?', 'AI will write a new title and description.', {
        label: 'Generate',
      }))
    )
      return;
    setError('');
    setExampleCount(0);
    setAiPhase('reading');
    try {
      const comparison = await compare(hosted, base, head);
      if (!comparison.commits.length && !comparison.files.length && !comparison.diff)
        throw new Error(`"${head}" has no changes compared with "${base}".`);
      setAiPhase('examples');
      const examples = await pastRequests(hosted).catch(() => []);
      setExampleCount(examples.length);
      setAiPhase('writing');
      const settings = useSettings.getState();
      const provider = settings.aiProvider;
      const model =
        (provider === 'openai' ? settings.openaiModel : provider === 'copilot' ? settings.copilotModel : '') ||
        undefined;
      const prompt = aiPrompt({ kind: hosted.kind, base, head, template: templateBody, examples, comparison, notes });
      const result = await desktopApi().ai.pullRequest(provider, model, prompt);
      if (!result.ok) throw new Error(result.error.message);
      const parsed = parseAiResult(String(result.text));
      if (!parsed.title) throw new Error('AI did not return a usable title.');
      setAiPhase('typing');
      await typeIn(parsed.title, parsed.body);
      touched.current = { title: true, body: true };
      setAiPhase('done');
      useRepo.getState().recordActivity('success', `AI wrote a ${noun.toLowerCase()} description`, undefined, cwd);
    } catch (e) {
      setError(clean(e));
      setAiPhase('idle');
    }
  };

  const create = async () => {
    if (!hosted || busy || !title.trim()) return;
    setCreating(true);
    setError('');
    try {
      const url = await createRequest(hosted, { base, head, title: title.trim(), body, draft });
      setCreated(url);
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
      useRepo.getState().recordActivity('success', `${noun} created`, `${head} → ${base}`, cwd);
      useRepo.getState().toast(`${noun} created: ${head} → ${base}`);
    } catch (e) {
      setError(clean(e));
      if (e instanceof HostError && e.status === 401) setConnection({ state: 'needed', tried: [] });
    } finally {
      setCreating(false);
    }
  };

  const open = (url: string) => {
    if (hosted)
      void desktopApi()
        .hosting.open(hosted.kind, hosted.host, url)
        .catch((e) => setError(clean(e)));
  };

  const ready = !!hosted && !!base && !!head && base !== head && headPushed;
  const canCreate = ready && !!title.trim() && !busy;
  const showFields = mode === 'manual' || aiPhase !== 'idle';
  const phaseIndex = ORDER.indexOf(aiPhase);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-[860px] flex-col overflow-hidden rounded-lg border border-surface bg-mantle shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-surface px-5 py-4">
          <GitPullRequest size={20} className="text-accent" aria-hidden />
          <h2 id="pr-title" className="flex-1 text-lg font-semibold">
            Create {noun}
          </h2>
          {connection.state === 'ok' && hosted && (
            <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs text-success">
              <Check size={13} aria-hidden /> {connection.account}
              <button
                onClick={() => setConnection({ state: 'needed', tried: [] })}
                className="ml-1 text-sub underline-offset-2 hover:text-text hover:underline"
              >
                change
              </button>
            </span>
          )}
          <button onClick={onClose} disabled={busy} aria-label="Close" className="rounded p-1.5 hover:bg-surface">
            <X size={18} />
          </button>
        </header>

        <div className="flex border-b border-surface" role="tablist" aria-label="Hosting provider">
          {HOST_KINDS.map((kind) => {
            const active = hosted?.kind === kind;
            const locked = !!detected && detected.kind !== kind;
            return (
              <button
                key={kind}
                role="tab"
                aria-selected={active}
                disabled={locked || !remote}
                onClick={() => chooseKind(kind)}
                title={locked ? `This repository is on ${HOST_LABEL[detected!.kind]}` : undefined}
                className={`flex-1 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${active ? 'border-accent text-text' : 'border-transparent text-sub hover:text-text'} disabled:cursor-default disabled:opacity-35`}
              >
                {HOST_LABEL[kind]}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {remote && !hosted && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              Could not tell which service hosts {remoteHost(remote) ?? 'this remote'}. Choose GitHub, GitLab or
              Bitbucket above.
            </p>
          )}
          {hosted && (
            <p className="mb-4 text-sm text-sub">
              <span className="font-semibold text-text">{hosted.path}</span> on {hosted.host}
              {detected ? '' : ` (set as ${HOST_LABEL[hosted.kind]})`}
            </p>
          )}

          {/* step 1: connect, on its own; nothing else works without it */}
          {hosted && connection.state === 'checking' && (
            <div className="fade-in flex items-center gap-3 py-10 text-sm text-sub">
              <Loader2 size={18} className="animate-spin" aria-hidden />
              Checking credentials saved for {hosted.host}…
            </div>
          )}
          {hosted && connection.state === 'needed' && (
            <div className="slide-down mx-auto max-w-[560px] space-y-4 py-4">
              <div className="flex items-start gap-3">
                <span className="rounded-full bg-warning/15 p-2 text-warning">
                  <KeyRound size={20} aria-hidden />
                </span>
                <div>
                  <h3 className="font-semibold">Connect to {hosted.host}</h3>
                  <p className="mt-1 text-sm text-sub">{TOKEN_HELP[hosted.kind]}</p>
                  {connection.tried.length > 0 && (
                    <p className="mt-2 text-xs text-sub">
                      Tried, not accepted by the API: {connection.tried.join(', ')}.
                    </p>
                  )}
                </div>
              </div>
              <p className="text-xs text-sub">
                Saved hosting, Git, CLI, and configured environment credentials are checked only when you choose this
                action. Push-profile tokens are never used to connect to hosting services.
              </p>
              <button
                onClick={() => void connect()}
                disabled={verifying}
                className="btn-secondary flex w-full items-center justify-center gap-2 px-4 py-2"
              >
                {verifying && <Loader2 size={15} className="animate-spin" aria-hidden />}
                Check saved credentials for {hosted.host}
              </button>
              <button
                onClick={() => open(tokenPageUrl(hosted.kind, hosted.host))}
                className="btn-secondary flex w-full items-center justify-center gap-2 px-4 py-2"
              >
                Create a token on {hosted.host} <ExternalLink size={14} aria-hidden />
              </button>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste the access token"
                  aria-label="Access token"
                  className={field}
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && void submitToken()}
                />
                <button
                  onClick={() => void submitToken()}
                  disabled={!token.trim() || verifying}
                  className="flex shrink-0 items-center gap-2 rounded-md bg-accent/20 px-4 text-sm font-semibold text-accent hover:bg-accent/30 disabled:opacity-40"
                >
                  {verifying && <Loader2 size={15} className="animate-spin" aria-hidden />}
                  Connect
                </button>
              </div>
              <p className="text-xs text-sub">
                Your entered token is stored in the system keychain and only sent to {hosted.host}.
              </p>
            </div>
          )}

          {connection.state === 'ok' && connection.sessionOnly && (
            <p className="slide-down mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
              macOS Keychain did not allow this copy of the app to save secrets, so the token is kept only until
              GITVerse quits. Allow access to “GITVerse Safe Storage” in Keychain Access to keep it.
            </p>
          )}
          {/* step 2: the request */}
          {hosted && connected && (
            <div className="fade-in space-y-4">
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-sub">From branch</span>
                  <select value={head} onChange={(e) => setHead(e.target.value)} className={field} disabled={busy}>
                    <option value="">Select…</option>
                    {[...new Set([...(current ? [current.name] : []), ...originBranches])].map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="pb-2 text-sub" aria-hidden>
                  →
                </span>
                <label className="block text-sm">
                  <span className="mb-1 block text-sub">Into branch</span>
                  <select value={base} onChange={(e) => setBase(e.target.value)} className={field} disabled={busy}>
                    <option value="">Select…</option>
                    {originBranches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {head && !headPushed && (
                <div className="slide-down flex items-center gap-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
                  <AlertTriangle size={16} className="shrink-0" aria-hidden />
                  <span className="flex-1">&quot;{head}&quot; is not on origin yet. Push it first.</span>
                  <button onClick={onPush} className="btn-secondary flex shrink-0 items-center gap-1.5 px-3 py-1">
                    <Upload size={14} aria-hidden /> Push
                  </button>
                </div>
              )}
              {unpushed > 0 && (
                <p className="text-sm text-warning">
                  {unpushed} local commit{unpushed === 1 ? ' is' : 's are'} not pushed and will not be included.
                </p>
              )}
              {base && head && base === head && <p className="text-sm text-warning">Choose two different branches.</p>}
              {existing && (
                <p className="slide-down flex items-center gap-2 text-sm text-sub">
                  A {noun.toLowerCase()} for these branches is already open.
                  <button
                    onClick={() => open(existing)}
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    Open it <ExternalLink size={13} aria-hidden />
                  </button>
                </p>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex rounded-lg border border-surface p-1" role="tablist" aria-label="How to write it">
                  {(
                    [
                      ['manual', 'Write it myself', PenLine],
                      ['ai', 'Write with AI', Sparkles],
                    ] as const
                  ).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={mode === id}
                      disabled={aiBusy}
                      onClick={() => setMode(id)}
                      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${mode === id ? (id === 'ai' ? 'bg-ai/15 text-ai' : 'bg-accent/15 text-accent') : 'text-sub hover:text-text'}`}
                    >
                      <Icon size={15} aria-hidden /> {label}
                    </button>
                  ))}
                </div>
                <label className="block min-w-[200px] flex-1 text-sm">
                  <span className="mb-1 block text-sub">Template</span>
                  <select
                    value={template}
                    onChange={(e) => void applyTemplate(e.target.value)}
                    className={field}
                    disabled={!templates.length || aiBusy}
                  >
                    {!templates.length && <option value="">No template in this project</option>}
                    {templates.length > 0 && <option value="">None</option>}
                    {templates.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                        {t.source === 'local' ? ' (working tree)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {mode === 'ai' && aiPhase === 'idle' && (
                <div className="slide-down rounded-lg border border-ai/30 bg-ai/5 p-4">
                  <p className="flex items-center gap-2 font-semibold text-ai">
                    <Sparkles size={16} aria-hidden /> Let AI draft it
                  </p>
                  <p className="mt-1 text-sm text-sub">
                    Reads the commits and diff of {head || 'the branch'}, follows the
                    {template ? ` “${template}” template` : ' project style'} and how earlier {noun.toLowerCase()}s were
                    written. You can edit everything before creating.
                  </p>
                  <button
                    onClick={() => void generate()}
                    disabled={!ready}
                    className="mt-3 flex items-center gap-2 rounded-md bg-ai/20 px-4 py-2 text-sm font-semibold text-ai hover:bg-ai/30 disabled:opacity-40"
                  >
                    <Sparkles size={15} aria-hidden /> Generate title and description
                  </button>
                </div>
              )}

              {mode === 'ai' && aiPhase !== 'idle' && (
                <ol className="slide-down flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-live="polite">
                  {AI_STEPS.map((step) => {
                    const at = ORDER.indexOf(step.phase);
                    const doneStep = phaseIndex > at;
                    const active = phaseIndex === at;
                    return (
                      <li
                        key={step.phase}
                        className={`flex items-center gap-1.5 transition-colors ${doneStep ? 'text-success' : active ? 'text-ai' : 'text-sub/60'}`}
                      >
                        {doneStep ? (
                          <Check size={14} className="pop-in" aria-hidden />
                        ) : active ? (
                          <Loader2 size={14} className="animate-spin" aria-hidden />
                        ) : (
                          <span className="h-3.5 w-3.5 rounded-full border border-current" aria-hidden />
                        )}
                        {step.label(exampleCount, noun.toLowerCase())}
                      </li>
                    );
                  })}
                  {aiPhase === 'done' && (
                    <li className="pop-in ml-auto">
                      <button
                        onClick={() => void generate()}
                        className="flex items-center gap-1.5 text-ai hover:underline"
                        disabled={!ready}
                      >
                        <RefreshCw size={13} aria-hidden /> Regenerate
                      </button>
                    </li>
                  )}
                </ol>
              )}

              {showFields && (
                <div className={`space-y-4 ${mode === 'ai' && aiPhase !== 'idle' ? 'ai-fields' : ''}`}>
                  <label className="block text-sm">
                    <span className="mb-1 flex items-center gap-2 text-sub">
                      Title
                      {mode === 'ai' && aiPhase === 'done' && (
                        <span className="pop-in rounded bg-ai/15 px-1.5 text-2xs text-ai">AI draft · editable</span>
                      )}
                    </span>
                    <div
                      className={`relative ${aiPhase === 'reading' || aiPhase === 'examples' || aiPhase === 'writing' ? 'ai-shimmer' : ''}`}
                    >
                      <input
                        value={title}
                        onChange={(e) => {
                          touched.current.title = true;
                          setTitle(e.target.value);
                        }}
                        placeholder={`${noun} title`}
                        className={field}
                        disabled={aiBusy}
                      />
                    </div>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 flex items-center gap-2 text-sub">
                      <span className="flex-1">Description</span>
                      {mode === 'manual' && (commits?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          onClick={insertCommits}
                          className="flex items-center gap-1 text-xs text-accent hover:underline"
                        >
                          <ListPlus size={13} aria-hidden /> Insert {commits!.length} commit
                          {commits!.length === 1 ? '' : 's'}
                        </button>
                      )}
                    </span>
                    <div
                      className={`relative ${aiPhase === 'reading' || aiPhase === 'examples' || aiPhase === 'writing' ? 'ai-shimmer' : ''}`}
                    >
                      <textarea
                        value={body}
                        onChange={(e) => {
                          touched.current.body = true;
                          setBody(e.target.value);
                        }}
                        placeholder={`${noun} description (Markdown)`}
                        rows={12}
                        className={`${field} resize-y font-mono text-sm`}
                        disabled={aiBusy}
                      />
                    </div>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                    Create as draft
                  </label>
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 whitespace-pre-wrap break-words text-sm text-danger">
              {error}
            </p>
          )}
          {created && (
            <div
              role="status"
              className="slide-down mt-4 flex items-center gap-3 rounded-md border border-success/40 bg-success/10 p-3 text-sm"
            >
              <span className="flex-1 text-success">{noun} created.</span>
              <button onClick={() => open(created)} className="flex items-center gap-1 text-accent hover:underline">
                Open in browser <ExternalLink size={13} aria-hidden />
              </button>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-3 border-t border-surface px-5 py-4">
          <button onClick={onClose} disabled={busy} className="btn-secondary min-w-[120px] px-4 py-2">
            {created ? 'Close' : 'Cancel'}
          </button>
          {!created && connected && (
            <button
              onClick={() => void create()}
              disabled={!canCreate}
              className="flex min-w-[180px] items-center justify-center gap-2 rounded-md bg-success/20 px-4 py-2 text-sm font-semibold text-success transition-colors hover:bg-success/30 disabled:opacity-40"
            >
              {creating && <Loader2 size={16} className="animate-spin" aria-hidden />}
              Create {noun}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
