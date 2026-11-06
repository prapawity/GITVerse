/** Provider-neutral shapes shared by the renderer (UI + agent loop) and the main process (provider adapters). */
export type Provider = 'claude' | 'openai' | 'copilot';

export const PROVIDERS: { id: Provider; label: string; sub: string }[] = [
  { id: 'claude', label: 'Claude', sub: 'Anthropic' },
  { id: 'openai', label: 'ChatGPT', sub: 'OpenAI' },
  { id: 'copilot', label: 'Copilot', sub: 'GitHub' },
];
export const providerLabel = (p: Provider) => PROVIDERS.find((x) => x.id === p)!.label;

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
export interface ToolResult { id: string; text: string; isError: boolean }

/** The conversation as the app keeps it. `native` is a provider's own representation of one of its replies
 *  (Claude: content blocks incl. thinking) and is replayed unchanged only to that same provider (`by`). */
export type NMsg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[]; native?: unknown; by?: Provider }
  | { role: 'tool'; results: ToolResult[] };

export interface AiErr { kind: 'auth' | 'rate' | 'usage' | 'network' | 'api' | 'refusal' | 'other'; message: string }
export type MessageResult = { ok: true; text: string } | { ok: false; error: AiErr };

export type TurnResult =
  | { ok: true; text: string; calls: ToolCall[]; native?: unknown; stop: 'end' | 'tool' | 'refusal' | 'max'; model?: string }
  | { ok: false; aborted: true }
  | { ok: false; error: AiErr };

export interface TurnRequest {
  reqId: number;
  provider: Provider;
  convId: number; // stateful providers (Copilot) keep one session per conversation
  model?: string;
  messages: NMsg[];
}

/** Sent to the main process by renderers to answer a tool call that a stateful provider made on its own. */
export interface BridgedCall { reqId: number; callId: string; name: string; input: Record<string, unknown> }

export type ResolveResult =
  | { ok: true; resolutions: { index: number; resolved: string; explanation: string }[] }
  | { ok: false; error: AiErr };
