import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  GitMerge,
  Info,
  KeyRound,
  Palette,
  Settings as Gear,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Undo2,
  UserRound,
  Workflow,
} from 'lucide-react';
import { AI_MODEL } from '../shared/aiTools';
import { PROVIDERS } from '../shared/aiTypes';
import { askConfirm } from './Dialogs';
import {
  clamp,
  DEFAULTS,
  FLOW_DEFAULTS,
  flowFor,
  useSettings,
  type FlowConfig,
  type Settings as S,
} from '../store/settingsStore';
import { useRepo } from '../store/repoStore';
import { ProfileSettings } from './ProfileSettings';
import { ApplicationAbout } from './ApplicationAbout';

export type Section = 'general' | 'appearance' | 'terminal' | 'conflicts' | 'ai' | 'gitflow' | 'profiles' | 'about';

const input =
  'w-full max-w-[360px] rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-[#4cc2ff]';

function Row({
  label,
  htmlFor,
  children,
  hint,
  warn,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  warn?: string;
}) {
  return (
    <div className="grid max-w-[850px] grid-cols-1 items-start gap-x-8 gap-y-2 border-b border-surface/60 py-5 sm:grid-cols-[minmax(160px,220px)_1fr]">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[14px] font-medium sm:pt-2">
          {label}
        </label>
      ) : (
        <div className="text-[14px] font-medium sm:pt-2">{label}</div>
      )}
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-sub">{hint}</p>}
        {warn && <p className="mt-1.5 flex max-w-[640px] gap-1.5 text-[13px] text-[#f9e2af]">{warn}</p>}
      </div>
    </div>
  );
}

function AiRow({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="border-t border-surface/70 py-5 first:border-0 first:pt-0 last:pb-0">
      <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-semibold text-text">
        {label}
      </label>
      {children}
      {hint && <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-sub">{hint}</p>}
    </div>
  );
}

function Check({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex min-h-[36px] cursor-pointer items-center gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[18px] w-[18px] accent-[#4cc2ff]"
      />
      {children && <span className="text-[14px] text-sub">{children}</span>}
    </label>
  );
}

/** Number field that keeps what you type while editing and only commits a clamped value on blur / Enter. */
function Num({
  id,
  value,
  min,
  max,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = clamp(Number(text), min, max, value);
    onCommit(n);
    setText(String(n));
  };
  return (
    <input
      id={id}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={input}
    />
  );
}

type Msg = { ok: boolean; text: string } | null;
const clean = (m: unknown) =>
  String((m as any)?.message ?? m).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** A secret the user pastes (API key / token). It goes straight to the main process, is stored encrypted and is never shown again. */
function SecretField({
  id,
  saved,
  placeholder,
  onSave,
  onRemove,
}: {
  id: string;
  saved: boolean;
  placeholder: string;
  onSave: (v: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [v, setV] = useState('');
  return (
    <div className="flex max-w-[520px] gap-2">
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={saved ? '•••••••• (saved)' : placeholder}
        className={input}
      />
      <button
        disabled={!v.trim()}
        onClick={async () => {
          await onSave(v);
          setV('');
        }}
        className="min-h-[38px] rounded-md bg-[#4cc2ff] px-4 font-medium text-crust disabled:opacity-40"
      >
        Save
      </button>
      {saved && (
        <button
          onClick={onRemove}
          className="min-h-[38px] rounded-md border border-[#f38ba8]/60 px-3 text-[#f38ba8] hover:bg-[#f38ba8]/15"
        >
          Remove
        </button>
      )}
    </div>
  );
}

function ModelPick({
  id,
  value,
  onChange,
  provider,
  enabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  provider: 'openai' | 'copilot';
  enabled: boolean;
}) {
  const ai = (window as any).gitApi?.ai;
  const [list, setList] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    setList(null);
    ai?.models(provider)
      .then((r: any) => (r.ok ? setList(r.value) : (setList([]), setErr(r.message))))
      .catch((e: unknown) => {
        setList([]);
        setErr(clean(e));
      });
  };
  useEffect(() => {
    if (enabled) load();
    else setList(null);
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled) return <div className="pt-2 text-[14px] text-sub">Connect an account first.</div>;
  return (
    <div>
      <div className="flex max-w-[520px] items-center gap-2">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={!list} className={input}>
          <option value="">{provider === 'openai' ? 'First model the account offers' : "Copilot's default"}</option>
          {value && list && !list.includes(value) && <option value={value}>{value}</option>}
          {list?.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button onClick={load} className="min-h-[38px] rounded-md border border-surface px-3 hover:bg-surface/60">
          Refresh
        </button>
      </div>
      {!list && <p className="mt-1 text-[13px] text-sub">Loading models…</p>}
      {err && (
        <p role="alert" className="mt-1 text-[13px] text-[#f38ba8]">
          {err}
        </p>
      )}
    </div>
  );
}

/** Which AI answers the chat and "Auto-resolve with AI", and how each one is connected — always with the user's own account. */
function AiSettings() {
  const ai = (window as any).gitApi?.ai;
  const st = useSettings();
  const [status, setStatus] = useState<any>(null);
  const [cop, setCop] = useState<any>(null);
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const [signing, setSigning] = useState(false);
  const [copSigning, setCopSigning] = useState(false);
  const copLoginActive = useRef(false);
  const say = (k: string, m: Msg) => setMsg((x) => ({ ...x, [k]: m }));
  const load = () =>
    ai
      ?.status()
      .then(setStatus)
      .catch(() => setStatus(null));
  const loadCop = () => {
    setCop(null);
    ai?.copilotStatus()
      .then(setCop)
      .catch(() => setCop({ available: false, authenticated: false, message: 'Could not check Copilot.' }));
  };
  useEffect(() => {
    load();
    loadCop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      copLoginActive.current = false;
      void ai?.copilotCancelLogin();
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const signInCopilot = async () => {
    copLoginActive.current = true;
    setCopSigning(true);
    say('copilot', null);
    try {
      let response = await ai.copilotBeginLogin();
      while (copLoginActive.current) {
        if (!response.ok) throw new Error(response.message);
        const step = response.value;
        if (step.kind === 'error') throw new Error(step.message);
        if (step.kind === 'completed') {
          if (step.result.status !== 'completed')
            throw new Error(
              'GitHub sign-in requires an additional account or storage choice. Use the terminal sign-in below.',
            );
          say('copilot', { ok: true, text: 'GitHub account connected.' });
          loadCop();
          return;
        }
        if (step.kind === 'input-required')
          throw new Error('This GitHub account requires an additional input. Use the terminal sign-in below.');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (copLoginActive.current) response = await ai.copilotAdvanceLogin();
      }
    } catch (error) {
      if (copLoginActive.current) say('copilot', { ok: false, text: clean(error) });
    } finally {
      copLoginActive.current = false;
      await ai.copilotCancelLogin();
      setCopSigning(false);
    }
  };

  const setKey = (provider: 'claude' | 'openai' | 'copilot', k: string) => async (value: string | null) => {
    const r = await ai.setKey(provider, value);
    say(
      k,
      r.ok
        ? { ok: true, text: value ? 'Saved (encrypted with your system keychain).' : 'Removed.' }
        : { ok: false, text: r.message },
    );
    load();
    if (provider === 'copilot') loadCop();
  };
  const signIn = async () => {
    setSigning(true);
    say('openai', null);
    const r = await ai.openaiSignIn();
    setSigning(false);
    say(
      'openai',
      r.ok
        ? {
            ok: true,
            text: r.value.planUsage
              ? `Signed in as ${r.value.account}.`
              : `Signed in as ${r.value.account}, but this app was not granted ChatGPT plan usage — use your own API key below.`,
          }
        : { ok: false, text: r.message },
    );
    load();
  };
  const o = status?.openai,
    c = status?.claude;
  const Msgline = ({ k }: { k: string }) =>
    msg[k] ? (
      <p
        role={msg[k]!.ok ? 'status' : 'alert'}
        className={`mt-2 max-w-[560px] text-[13px] ${msg[k]!.ok ? 'text-[#a6e3a1]' : 'text-[#f38ba8]'}`}
      >
        {msg[k]!.text}
      </p>
    ) : null;
  const copyCmd = (t: string) => navigator.clipboard.writeText(t).catch(() => {});
  const card = 'rounded-xl border border-surface bg-mantle/70 p-5 sm:p-6';

  return (
    <div className="mx-auto max-w-[920px] space-y-6 pb-4">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#4cc2ff]/25 bg-[#4cc2ff]/10 text-[#4cc2ff]">
          <Sparkles size={22} aria-hidden />
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#4cc2ff]">Preferences</p>
          <h1 className="text-[28px] font-semibold leading-tight">AI Assistant</h1>
          <p className="mt-2 max-w-[700px] text-[14px] leading-relaxed text-sub">
            Connect your own account to chat about your repository and get help resolving conflicts. Actions that change
            the repository always require your approval.
          </p>
        </div>
      </div>
      {!ai && <p className="text-[#f9e2af]">The AI assistant is available in the desktop app.</p>}

      <section className={card} aria-labelledby="ai-provider-heading">
        <h2 id="ai-provider-heading" className="text-[17px] font-semibold">
          Choose your assistant
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Used for chat and Auto-resolve with AI. You can also switch providers in chat.
        </p>
        <div role="group" aria-label="AI provider" className="mt-4 grid gap-3 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              aria-pressed={st.aiProvider === p.id}
              onClick={() => st.set('aiProvider', p.id)}
              className={`min-h-[84px] rounded-lg border px-4 py-3 text-left transition-colors ${st.aiProvider === p.id ? 'border-[#4cc2ff] bg-[#4cc2ff]/10' : 'border-surface bg-crust/50 hover:border-sub/60 hover:bg-surface/40'}`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold">
                {p.label}
                {st.aiProvider === p.id && <CheckCircle2 size={17} className="shrink-0 text-[#4cc2ff]" aria-hidden />}
              </div>
              <div className="mt-1 text-[12px] text-sub">{p.sub}</div>
            </button>
          ))}
        </div>
      </section>

      <section className={card} aria-labelledby="claude-heading">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#fab387]/15 text-[#fab387]">
            <KeyRound size={19} aria-hidden />
          </div>
          <div>
            <h2 id="claude-heading" className="text-[17px] font-semibold">
              Claude
            </h2>
            <p className="text-[13px] text-sub">Connect with an Anthropic API key</p>
          </div>
        </div>
        <AiRow label="Model">
          <div className="font-mono text-[14px]">{AI_MODEL}</div>
        </AiRow>
        <AiRow
          label="Anthropic API key"
          htmlFor="aik"
          hint={
            <>
              {!c
                ? 'Checking…'
                : c.storedKey
                  ? 'Using the key saved in GITVerse.'
                  : c.envKey
                    ? 'Using ANTHROPIC_API_KEY from your environment.'
                    : 'No key saved.'}{' '}
              Get a key at console.anthropic.com.
            </>
          }
        >
          <SecretField
            id="aik"
            saved={!!c?.storedKey}
            placeholder="sk-ant-…"
            onSave={setKey('claude', 'claude')}
            onRemove={() => setKey('claude', 'claude')(null)}
          />
          <Msgline k="claude" />
          {c && !c.canEncrypt && (
            <p className="mt-2 text-[13px] text-[#f9e2af]">
              Secure storage is unavailable on this system — set ANTHROPIC_API_KEY instead.
            </p>
          )}
        </AiRow>
      </section>

      <section className={card} aria-labelledby="chatgpt-heading">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#a6e3a1]/15 text-[#a6e3a1]">
            <Sparkles size={19} aria-hidden />
          </div>
          <div>
            <h2 id="chatgpt-heading" className="text-[17px] font-semibold">
              ChatGPT
            </h2>
            <p className="text-[13px] text-sub">Connect your account or API key</p>
          </div>
        </div>
        <AiRow
          label="Account"
          hint={
            <>
              Signs in with your ChatGPT account in the browser and uses your plan's allowance (Plus / Pro). If OpenAI
              doesn't enable this for the app, use your own API key below.
            </>
          }
        >
          <div className="flex max-w-[520px] items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 truncate text-[14px]">
              {!o ? (
                'Checking…'
              ) : o.signedIn ? (
                <>
                  Signed in as <b>{o.account}</b>
                  {o.planUsage ? '' : ' (no plan usage)'}
                </>
              ) : (
                'Not signed in'
              )}
            </span>
            {signing ? (
              <button
                onClick={() => ai.openaiCancel()}
                className="min-h-[38px] rounded-md border border-surface px-4 hover:bg-surface/60"
              >
                Cancel
              </button>
            ) : o?.signedIn ? (
              <button
                onClick={async () => {
                  await ai.openaiSignOut();
                  say('openai', { ok: true, text: 'Signed out.' });
                  load();
                }}
                className="min-h-[38px] rounded-md border border-surface px-4 hover:bg-surface/60"
              >
                Sign out
              </button>
            ) : (
              <button
                disabled={!ai}
                onClick={signIn}
                className="min-h-[38px] rounded-md bg-[#4cc2ff] px-4 font-medium text-crust disabled:opacity-40"
              >
                Sign in with ChatGPT
              </button>
            )}
          </div>
          {signing && (
            <p role="status" className="mt-2 text-[13px] text-sub">
              Finish signing in in your browser, then return here…
            </p>
          )}
          <Msgline k="openai" />
        </AiRow>
        <AiRow
          label="OpenAI API key"
          htmlFor="oak"
          hint={
            <>
              Optional alternative, billed to your OpenAI API account.{' '}
              {o?.signedIn && o.planUsage ? 'The ChatGPT sign-in is used first.' : ''}
            </>
          }
        >
          <SecretField
            id="oak"
            saved={!!o?.hasApiKey}
            placeholder="sk-…"
            onSave={setKey('openai', 'oak')}
            onRemove={() => setKey('openai', 'oak')(null)}
          />
          <Msgline k="oak" />
        </AiRow>
        <AiRow label="Model" htmlFor="om">
          <ModelPick
            id="om"
            provider="openai"
            value={st.openaiModel}
            onChange={(v) => st.set('openaiModel', v)}
            enabled={!!o && ((o.signedIn && o.planUsage) || o.hasApiKey)}
          />
        </AiRow>
      </section>

      <section className={card} aria-labelledby="copilot-heading">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#cba6f7]/15 text-[#cba6f7]">
            <SquareTerminal size={19} aria-hidden />
          </div>
          <div>
            <h2 id="copilot-heading" className="text-[17px] font-semibold">
              GitHub Copilot
            </h2>
            <p className="text-[13px] text-sub">Connect your Copilot subscription</p>
          </div>
        </div>
        <AiRow
          label="Account"
          hint={
            <>
              Uses your Copilot subscription through the official Copilot SDK (technical preview), which runs a Copilot
              runtime bundled with the app. It is limited to this app's git tools — it cannot run commands or edit
              files. Requests may count against your Copilot plan.
            </>
          }
        >
          <div className="flex max-w-[560px] items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 text-[14px]">
              {!cop ? (
                'Checking…'
              ) : cop.authenticated ? (
                <>
                  Signed in
                  {cop.login ? (
                    <>
                      {' '}
                      as <b>{cop.login}</b>
                    </>
                  ) : (
                    ''
                  )}
                  {cop.authType ? <span className="text-sub"> ({cop.authType})</span> : ''}
                </>
              ) : (
                <span className="text-[#f9e2af]">{cop.available ? 'Not signed in' : 'Runtime unavailable'}</span>
              )}
            </span>
            {copSigning ? (
              <button
                onClick={() => {
                  copLoginActive.current = false;
                  void ai.copilotCancelLogin();
                }}
                className="min-h-[38px] rounded-md border border-surface px-3 hover:bg-surface/60"
              >
                Cancel
              </button>
            ) : (
              !cop?.authenticated && (
                <button
                  disabled={!ai || !cop?.available}
                  onClick={signInCopilot}
                  className="min-h-[38px] rounded-md bg-[#4cc2ff] px-4 font-medium text-crust disabled:opacity-40"
                >
                  Sign in with GitHub
                </button>
              )
            )}
            <button
              onClick={loadCop}
              className="min-h-[38px] rounded-md border border-surface px-3 hover:bg-surface/60"
            >
              Recheck
            </button>
          </div>
          {copSigning && (
            <p role="status" className="mt-2 text-[13px] text-sub">
              Complete sign-in in your browser, then return here…
            </p>
          )}
          <Msgline k="copilot" />
          {cop && !cop.authenticated && (
            <div className="mt-2 max-w-[560px] text-[13px] text-sub">
              {cop.message && <p className="mb-2 break-words">{cop.message}</p>}
              Sign in once in the built-in terminal (⌃`) with either command, then press Recheck:
              {['gh auth login', 'npx @github/copilot login'].map((cmd) => (
                <div
                  key={cmd}
                  className="mt-1.5 flex items-center gap-2 rounded bg-crust px-3 py-1.5 font-mono text-[13px] text-text"
                >
                  <span className="flex-1">{cmd}</span>
                  <button onClick={() => copyCmd(cmd)} className="text-[12px] text-sub underline hover:text-text">
                    Copy
                  </button>
                </div>
              ))}
            </div>
          )}
        </AiRow>
        <AiRow
          label="GitHub token"
          htmlFor="ght"
          hint="Optional: your own GitHub token with Copilot access, instead of a CLI login. Stored encrypted, never shown again."
        >
          <SecretField
            id="ght"
            saved={!!cop?.hasToken}
            placeholder="github_pat_… or ghp_…"
            onSave={setKey('copilot', 'ght')}
            onRemove={() => setKey('copilot', 'ght')(null)}
          />
          <Msgline k="ght" />
        </AiRow>
        <AiRow label="Model" htmlFor="cm">
          <ModelPick
            id="cm"
            provider="copilot"
            value={st.copilotModel}
            onChange={(v) => st.set('copilotModel', v)}
            enabled={!!cop?.authenticated}
          />
        </AiRow>
      </section>

      <section className="flex gap-3 rounded-xl border border-[#4cc2ff]/20 bg-[#4cc2ff]/5 p-5">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-[#4cc2ff]" aria-hidden />
        <div>
          <h2 className="font-semibold">Your data, your choice</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-sub">
            Nothing is sent until you ask. Chat sends your messages and the repository details its tools read, such as
            branch names, commit subjects, authors and changed file names. Auto-resolve sends conflicted regions with
            about 25 lines of context. Data goes only to your chosen provider.
          </p>
        </div>
      </section>
    </div>
  );
}

export function SettingsPage({ onExit, initial = 'general' }: { onExit: () => void; initial?: Section }) {
  const [section, setSection] = useState<Section>(initial);
  const st = useSettings();
  const { repoPath, recentRepos } = useRepo();
  const repoName = repoPath?.split(/[\\/]/).filter(Boolean).pop();
  const set =
    <K extends keyof S>(k: K) =>
    (v: S[K]) =>
      st.set(k, v);

  useEffect(() => setSection(initial), [initial]);

  useEffect(() => {
    const h = (e: KeyboardEvent) =>
      e.key === 'Escape' &&
      !(e.target instanceof HTMLInputElement) &&
      !document.querySelector('dialog[open]') &&
      onExit();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onExit]);

  const nav = (id: Section, label: string, I: typeof Gear) => (
    <button
      key={id}
      onClick={() => setSection(id)}
      aria-current={section === id ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={`flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-[14px] ${section === id ? 'bg-[#4cc2ff]/15 font-medium text-text' : 'text-sub hover:bg-surface/50 hover:text-text'}`}
    >
      <I size={19} className="shrink-0" aria-hidden /> <span className="hidden sm:inline">{label}</span>
    </button>
  );

  const flow = flowFor(repoPath);
  const flowRow = (k: keyof FlowConfig, label: string, hint: string) => (
    <Row key={k} label={label} htmlFor={`flow-${k}`} hint={hint}>
      <input
        id={`flow-${k}`}
        value={flow[k]}
        onChange={(e) => repoPath && st.setFlow(repoPath, { [k]: e.target.value })}
        placeholder={FLOW_DEFAULTS[k]}
        className={input}
      />
    </Row>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="glass-toolbar flex min-h-[68px] shrink-0 items-center gap-4 border-b border-surface px-4 sm:px-7">
        <button
          type="button"
          autoFocus
          onClick={onExit}
          className="flex min-h-[40px] items-center gap-2 rounded-lg border border-surface/80 bg-mantle/60 px-3 text-sm font-medium hover:bg-surface/60"
        >
          <Undo2 size={17} aria-hidden /> Back to workspace
        </button>
        <div className="h-7 w-px bg-surface" aria-hidden />
        <div>
          <div className="text-base font-semibold">Settings</div>
          <div className="text-xs text-sub">Changes save automatically</div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Preferences"
          className="glass-panel flex w-14 shrink-0 flex-col overflow-y-auto border-r border-surface bg-mantle px-1.5 py-5 sm:w-[240px] sm:px-3"
        >
          <div className="hidden px-3 pb-2 pt-1 text-[12px] font-medium text-sub sm:block">Preferences</div>
          {nav('general', 'General', Gear)}
          {nav('appearance', 'Appearance', Palette)}
          {nav('about', 'Application / About', Info)}
          {nav('profiles', 'Profiles', UserRound)}
          {nav('terminal', 'In-App Terminal', SquareTerminal)}
          {nav('conflicts', 'Conflicts', GitMerge)}
          {nav('ai', 'AI Assistant', Sparkles)}
          <div className="hidden px-3 pb-1 pt-6 text-[12px] font-medium text-sub sm:block">Repository settings</div>
          <div className="hidden truncate px-3 pb-2 text-[13px] sm:block" title={repoPath ?? undefined}>
            {repoName ? (
              <>
                Repo: <span className="font-medium">{repoName}</span>
              </>
            ) : (
              <span className="text-sub">Open a repository first</span>
            )}
          </div>
          {repoName && nav('gitflow', 'Gitflow', Workflow)}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-5 py-7 sm:px-10 lg:px-14">
          <div className="mx-auto w-full max-w-4xl">
            {section === 'about' && <ApplicationAbout />}
            {section === 'general' && (
              <>
                <h1 className="text-[28px] font-semibold">General</h1>
                <p className="mb-5 mt-1 text-sm text-sub">
                  Manage updates, repository history, and your workspace. Changes save automatically.
                </p>
                <Row
                  label="Check for updates automatically"
                  htmlFor="auto-update"
                  hint="Check for a new stable release when GITVerse starts."
                >
                  <Check id="auto-update" checked={st.autoCheckUpdates} onChange={set('autoCheckUpdates')} />
                </Row>
                <Row
                  label="Auto-Fetch Interval"
                  htmlFor="af"
                  hint="In minutes, between 0 and 60 (0 disables auto-fetch). Fetches from every remote in the background."
                  warn="If a repository has many remotes, frequent fetching may impact performance."
                >
                  <Num id="af" value={st.autoFetchMinutes} min={0} max={60} onCommit={set('autoFetchMinutes')} />
                </Row>
                <Row
                  label="Auto-Prune"
                  htmlFor="ap"
                  hint="Remove remote-tracking branches that no longer exist on the remote whenever you fetch."
                >
                  <Check id="ap" checked={st.autoPrune} onChange={set('autoPrune')} />
                </Row>
                <Row
                  label="Show All Commits in Graph"
                  htmlFor="sa"
                  warn="Loads the entire history at once. Enabling this may adversely affect performance on large repositories."
                >
                  <Check id="sa" checked={st.showAll} onChange={set('showAll')} />
                </Row>
                <Row
                  label="Initial Commits in Graph"
                  htmlFor="ic"
                  hint="Minimum 100. When lazy loading is on, more commits are loaded as you scroll to the end of the graph."
                  warn="Increasing this value may adversely affect performance."
                >
                  <Num id="ic" value={st.initialCommits} min={100} max={100000} onCommit={set('initialCommits')} />
                </Row>
                <Row
                  label="Lazy Load Commits in Graph"
                  htmlFor="ll"
                  hint="Load older commits page by page as you scroll. When off, only the initial commits are shown."
                >
                  <Check id="ll" checked={st.lazyLoad && !st.showAll} onChange={set('lazyLoad')} />
                </Row>
                <Row
                  label="Remember tabs"
                  htmlFor="rt"
                  hint="Reopen the repositories that were open when you last quit."
                >
                  <Check id="rt" checked={st.rememberTabs} onChange={set('rememberTabs')} />
                </Row>
                <Row label="Forget remembered repositories">
                  <button
                    disabled={!recentRepos.length}
                    onClick={async () => {
                      if (
                        await askConfirm(
                          'Forget repositories',
                          'Close every repository tab and clear the remembered list. Nothing on disk is deleted.',
                          { label: 'Forget', danger: true },
                        )
                      )
                        recentRepos.slice().forEach((r) => useRepo.getState().closeRepo(r));
                    }}
                    className="min-h-[36px] rounded-md border border-[#f38ba8]/60 px-4 text-[#f38ba8] hover:bg-[#f38ba8]/15 disabled:opacity-40"
                  >
                    Forget All
                  </button>
                </Row>
                <Row
                  label="Restore general settings"
                  hint="Git Flow settings, profiles, repository groups, and remembered tabs are kept."
                >
                  <button
                    onClick={async () => {
                      if (
                        await askConfirm(
                          'Restore general settings',
                          'Appearance, fetch, history, and terminal settings will return to their defaults. Git Flow settings, profiles, repository groups, and remembered tabs will be kept.',
                          {
                            label: 'Reset',
                            danger: true,
                          },
                        )
                      )
                        st.reset();
                    }}
                    className="min-h-[36px] rounded-md border border-surface px-4 hover:bg-surface/60"
                  >
                    Restore defaults
                  </button>
                </Row>
              </>
            )}

            {section === 'appearance' && (
              <>
                <h1 className="mb-2 text-[28px] font-semibold">Appearance</h1>
                <p className="mb-6 text-sm text-sub">Choose a theme for GITVerse. Changes apply immediately.</p>
                <div role="group" aria-label="Theme" className="grid max-w-[700px] grid-cols-1 gap-3 sm:grid-cols-3">
                  {(
                    [
                      { id: 'light', name: 'Light', colors: ['#ffffff', '#f5f7fa', '#d7dce4'] },
                      { id: 'dark', name: 'Dark', colors: ['#11111b', '#181825', '#313244'] },
                      { id: 'midnight', name: 'Midnight', colors: ['#081120', '#0c182a', '#293d54'] },
                      { id: 'graphite', name: 'Graphite', colors: ['#161618', '#1e1e21', '#444449'] },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={st.theme === option.id}
                      onClick={() => st.set('theme', option.id)}
                      className={`rounded-lg border p-3 text-left transition-colors ${st.theme === option.id ? 'border-[#4cc2ff] bg-[#4cc2ff]/10' : 'border-surface hover:bg-surface/50'}`}
                    >
                      <span
                        className="mb-3 flex h-16 overflow-hidden rounded-md border border-white/10"
                        style={{ background: option.colors[0] }}
                      >
                        <span className="w-1/3" style={{ background: option.colors[1] }} />
                        <span className="m-2 h-3 flex-1 rounded" style={{ background: option.colors[2] }} />
                      </span>
                      <span className="font-medium">{option.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {section === 'terminal' && (
              <>
                <h1 className="mb-4 text-[28px] font-semibold">In-App Terminal</h1>
                <Row
                  label="Shell"
                  htmlFor="sh"
                  hint="Full path to the shell to start in new terminals. Leave empty to use your system default."
                >
                  <input
                    id="sh"
                    value={st.termShell}
                    onChange={(e) => st.set('termShell', e.target.value)}
                    placeholder="/bin/zsh"
                    className={input}
                  />
                </Row>
                <Row
                  label="Font family"
                  htmlFor="ff"
                  hint={
                    <>
                      Leave empty to use a Nerd Font automatically (MesloLGS NF, Hack, FiraCode, JetBrains Mono…), which
                      oh-my-zsh / powerlevel10k / starship prompts need for their icons. Applies to open terminals
                      immediately.
                    </>
                  }
                >
                  <input
                    id="ff"
                    value={st.termFontFamily}
                    onChange={(e) => st.set('termFontFamily', e.target.value)}
                    placeholder="MesloLGS NF"
                    className={input}
                  />
                </Row>
                <Row label="Font size" htmlFor="fs" hint="Between 10 and 24. Applies to open terminals immediately.">
                  <Num id="fs" value={st.termFontSize} min={10} max={24} onCommit={set('termFontSize')} />
                </Row>
                <Row
                  label="Scrollback lines"
                  htmlFor="sb"
                  hint="How many lines each terminal remembers. Applies to new terminals."
                >
                  <Num id="sb" value={st.termScrollback} min={500} max={100000} onCommit={set('termScrollback')} />
                </Row>
                <Row label="Blinking cursor" htmlFor="cb">
                  <Check id="cb" checked={st.termCursorBlink} onChange={set('termCursorBlink')} />
                </Row>
              </>
            )}

            {section === 'conflicts' && (
              <>
                <h1 className="mb-4 text-[28px] font-semibold">Conflicts</h1>
                <Row
                  label="Auto-scroll to conflicts"
                  htmlFor="cs"
                  hint="When a conflicted file opens in the merge tool, and when you move between conflicts, scroll every pane so the conflict you are working on is in view."
                >
                  <Check id="cs" checked={st.conflictAutoScroll} onChange={set('conflictAutoScroll')} />
                </Row>
              </>
            )}

            {section === 'ai' && <AiSettings />}
            {section === 'profiles' && <ProfileSettings key={repoPath ?? ''} repo={repoPath} />}

            {section === 'gitflow' && repoPath && (
              <>
                <h1 className="mb-1 text-[28px] font-semibold">Gitflow</h1>
                <p className="mb-4 text-[14px] text-sub">
                  Used by the Branch button for <span className="font-medium text-text">{repoName}</span>. Prefixes
                  include the trailing slash.
                </p>
                {flowRow('develop', 'Development branch', 'Where feature, bugfix and release branches start.')}
                {flowRow('main', 'Production branch', 'Where hotfix and support branches start.')}
                {flowRow('feature', 'Feature prefix', 'e.g. feature/')}
                {flowRow('bugfix', 'Bugfix prefix', 'e.g. bugfix/')}
                {flowRow('release', 'Release prefix', 'e.g. release/')}
                {flowRow('hotfix', 'Hotfix prefix', 'e.g. hotfix/')}
                {flowRow('support', 'Support prefix', 'e.g. support/')}
                <Row label="Restore defaults">
                  <button
                    onClick={() => st.setFlow(repoPath, FLOW_DEFAULTS)}
                    className="min-h-[36px] rounded-md border border-surface px-4 hover:bg-surface/60"
                  >
                    Reset Gitflow settings
                  </button>
                </Row>
              </>
            )}
            <div className="h-10" aria-hidden />
          </div>
        </main>
      </div>
    </div>
  );
}

export { DEFAULTS };
