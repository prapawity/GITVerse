import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { useSettings } from '../store/settingsStore';
import { useRepo } from '../store/repoStore';

export function ProfilePicker({ onManage }: { onManage: () => void }) {
  const profiles = useSettings((s) => s.sharedIdentityProfiles);
  const active = useSettings((s) => s.activeIdentityProfile);
  const selectProfile = useSettings((s) => s.setActiveIdentityProfile);
  const [busy, setBusy] = useState(false);
  const select = async (id: string) => {
    if (id === '__manage') {
      onManage();
      return;
    }
    const profile = profiles.find((p) => p.id === id);
    if (id && !profile) return;
    setBusy(true);
    try {
      await (window as any).gitApi.setActiveIdentity(
        profile ? { name: profile.authorName, email: profile.email } : null,
      );
      selectProfile(id);
      if (profile)
        useRepo.getState().notify('success', `Commit identity set to ${profile.authorName} <${profile.email}>`);
    } catch (e: any) {
      useRepo
        .getState()
        .notify(
          'error',
          'Could not change commit identity',
          String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-auto flex min-w-0 items-center gap-1 rounded-md px-2 text-sub hover:bg-surface/50">
      <UserRound size={16} aria-hidden />
      <select
        aria-label="Commit identity profile"
        title={profiles.find((p) => p.id === active)?.email}
        value={profiles.some((p) => p.id === active) ? active : ''}
        disabled={busy}
        onChange={(e) => void select(e.target.value)}
        className="max-w-[320px] cursor-pointer truncate bg-transparent py-2 text-sm text-text outline-none disabled:opacity-50"
      >
        <option value="" className="bg-mantle">
          Current Git identity
        </option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id} className="bg-mantle">
            {p.name} · {p.email}
          </option>
        ))}
        <option value="__manage" className="bg-mantle">
          Manage profiles…
        </option>
      </select>
    </div>
  );
}
