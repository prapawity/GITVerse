import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { storage } from '../lib/storage';

export interface Settings {
  theme: 'dark' | 'midnight' | 'graphite' | 'light';
  autoFetchMinutes: number; // 0 disables
  autoPrune: boolean;
  initialCommits: number;
  lazyLoad: boolean;
  showAll: boolean;
  rememberTabs: boolean;
  termShell: string; // '' = system default
  termFontFamily: string; // '' = Nerd Font fallback list
  termFontSize: number;
  termCursorBlink: boolean;
  termScrollback: number;
  conflictAutoScroll: boolean;
  aiProvider: 'claude' | 'openai' | 'copilot';
  openaiModel: string; // '' = first model the account offers
  copilotModel: string; // '' = Copilot's default
}

export interface FlowConfig {
  feature: string;
  bugfix: string;
  release: string;
  hotfix: string;
  support: string; // prefixes, e.g. "feature/"
  develop: string;
  main: string; // long-lived branch names
}

export interface PushProfile {
  id: string;
  name: string;
  kind: 'system' | 'ssh' | 'https';
  username: string;
  sshKey: string;
}
export interface IdentityProfile {
  id: string;
  name: string;
  authorName: string;
  email: string;
}

export const DEFAULTS: Settings = {
  theme: 'dark',
  autoFetchMinutes: 1,
  autoPrune: true,
  initialCommits: 400,
  lazyLoad: true,
  showAll: false,
  rememberTabs: true,
  termShell: '',
  termFontFamily: '',
  termFontSize: 13,
  termCursorBlink: true,
  termScrollback: 5000,
  conflictAutoScroll: true,
  aiProvider: 'claude',
  openaiModel: '',
  copilotModel: '',
};
// Nerd Fonts first so powerline / oh-my-zsh prompt glyphs (agnoster, powerlevel10k, starship) render instead of boxes
export const TERM_FONT_FALLBACK =
  '"MesloLGS NF", "MesloLGS Nerd Font", "MesloLGM Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", "SauceCodePro Nerd Font", Menlo, "SF Mono", Consolas, monospace';
export const termFont = (custom: string) =>
  custom.trim() ? `${custom.trim()}, ${TERM_FONT_FALLBACK}` : TERM_FONT_FALLBACK;

export const FLOW_DEFAULTS: FlowConfig = {
  feature: 'feature/',
  bugfix: 'bugfix/',
  release: 'release/',
  hotfix: 'hotfix/',
  support: 'support/',
  develop: 'develop',
  main: 'main',
};

interface Store extends Settings {
  flow: Record<string, Partial<FlowConfig>>; // per repository path
  pushProfiles: Record<string, PushProfile[]>;
  selectedPushProfiles: Record<string, string>;
  identityProfiles: Record<string, IdentityProfile[]>;
  selectedIdentityProfiles: Record<string, string>;
  sharedIdentityProfiles: IdentityProfile[];
  activeIdentityProfile: string;
  repoGroups: Record<string, string>;
  repoGroupRoots: Record<string, string>;
  setRepoGroup: (repo: string, group: string) => void;
  setRepoGroupRoot: (group: string, root: string) => void;
  deleteRepoGroup: (group: string) => void;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  setFlow: (repo: string, patch: Partial<FlowConfig>) => void;
  setPushProfiles: (repo: string, profiles: PushProfile[]) => void;
  selectPushProfile: (repo: string, id: string) => void;
  setIdentityProfiles: (repo: string, profiles: IdentityProfile[]) => void;
  selectIdentityProfile: (repo: string, id: string) => void;
  setSharedIdentityProfiles: (profiles: IdentityProfile[]) => void;
  setActiveIdentityProfile: (id: string) => void;
  reset: () => void;
}

export const useSettings = create<Store>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      flow: {},
      pushProfiles: {},
      selectedPushProfiles: {},
      identityProfiles: {},
      selectedIdentityProfiles: {},
      sharedIdentityProfiles: [],
      activeIdentityProfile: '',
      repoGroups: {},
      repoGroupRoots: {},
      setRepoGroup: (repo, group) => set((s) => ({ repoGroups: { ...s.repoGroups, [repo]: group } })),
      setRepoGroupRoot: (group, root) => set((s) => ({ repoGroupRoots: { ...s.repoGroupRoots, [group]: root } })),
      deleteRepoGroup: (group) =>
        set((s) => {
          const repoGroups = Object.fromEntries(Object.entries(s.repoGroups).filter(([, name]) => name !== group));
          const { [group]: _removed, ...repoGroupRoots } = s.repoGroupRoots;
          return { repoGroups, repoGroupRoots };
        }),
      set: (k, v) => set({ [k]: v } as Partial<Store>),
      setFlow: (repo, patch) => set((s) => ({ flow: { ...s.flow, [repo]: { ...s.flow[repo], ...patch } } })),
      setPushProfiles: (repo, profiles) => set((s) => ({ pushProfiles: { ...s.pushProfiles, [repo]: profiles } })),
      selectPushProfile: (repo, id) =>
        set((s) => ({ selectedPushProfiles: { ...s.selectedPushProfiles, [repo]: id } })),
      setIdentityProfiles: (repo, profiles) =>
        set((s) => ({ identityProfiles: { ...s.identityProfiles, [repo]: profiles } })),
      selectIdentityProfile: (repo, id) =>
        set((s) => ({ selectedIdentityProfiles: { ...s.selectedIdentityProfiles, [repo]: id } })),
      setSharedIdentityProfiles: (profiles) => set({ sharedIdentityProfiles: profiles }),
      setActiveIdentityProfile: (id) => set({ activeIdentityProfile: id }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'gitverse.settings',
      storage: createJSONStorage(() => storage),
      merge: (persisted, current) => {
        const saved = persisted as Partial<Store> | undefined;
        const legacy = Object.values(saved?.identityProfiles ?? {}).flat();
        const profiles = saved?.sharedIdentityProfiles ?? [...new Map(legacy.map((p) => [p.id, p])).values()];
        return { ...current, ...saved, sharedIdentityProfiles: profiles };
      },
    },
  ),
);

export const flowFor = (repo: string | null): FlowConfig => ({
  ...FLOW_DEFAULTS,
  ...(repo ? useSettings.getState().flow[repo] : {}),
});

/** Clamp user-typed numbers instead of trusting them. */
export const clamp = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
