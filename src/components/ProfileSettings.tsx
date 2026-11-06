import { useState } from 'react';
import { Check, CheckCircle2, Plus, UserRound } from 'lucide-react';
import { useSettings, type IdentityProfile, type PushProfile } from '../store/settingsStore';
import { askConfirm } from './Dialogs';

const api = () => (window as any).gitApi;
const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-[#4cc2ff]';
const button = 'rounded-md border border-surface px-3 py-2 hover:bg-surface/60 disabled:opacity-40';
const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

export function ProfileSettings({ repo }: { repo: string | null }) {
  const store = useSettings();
  const identities = store.sharedIdentityProfiles;
  const profiles = repo ? store.pushProfiles?.[repo] ?? [] : [];
  const [identity, setIdentity] = useState<IdentityProfile | null>(null);
  const [profile, setProfile] = useState<PushProfile | null>(null);
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const clear = () => { setMessage(''); setError(''); };
  const createIdentity = () => { clear(); setIdentity({ id: crypto.randomUUID(), name: '', authorName: '', email: '' }); };
  const activate = async (p: IdentityProfile) => {
    setBusy(true); clear();
    try { await api().setActiveIdentity({ name: p.authorName, email: p.email }); store.setActiveIdentityProfile(p.id); setMessage(`“${p.name}” is active in GITVerse.`); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const saveIdentity = async () => {
    if (!identity) return;
    const value = { ...identity, name: identity.name.trim(), authorName: identity.authorName.trim(), email: identity.email.trim() };
    if (!value.name || !value.authorName || !/^[^\s@<>]+@[^\s@<>]+$/.test(value.email)) { setError('Enter a profile name, author name and valid email.'); return; }
    setBusy(true); clear();
    try {
      if (store.activeIdentityProfile === value.id) await api().setActiveIdentity({ name: value.authorName, email: value.email });
      store.setSharedIdentityProfiles([...identities.filter((p) => p.id !== value.id), value]);
      setIdentity(null); setMessage('Commit profile saved.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const deleteIdentity = async (p: IdentityProfile) => {
    if (!await askConfirm('Delete commit profile', `Delete “${p.name}”?`, { label: 'Delete', danger: true })) return;
    setBusy(true); clear();
    try {
      if (store.activeIdentityProfile === p.id) { await api().setActiveIdentity(null); store.setActiveIdentityProfile(''); }
      store.setSharedIdentityProfiles(identities.filter((x) => x.id !== p.id));
      if (identity?.id === p.id) setIdentity(null);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const editProfile = async (p: PushProfile) => {
    if (!repo) return;
    setProfile(p); setToken(''); setHasToken(false); clear();
    try { setHasToken(await api().pushProfiles.tokenStatus(repo, p.id)); } catch (e) { setError(errorText(e)); }
  };
  const saveProfile = async () => {
    if (!profile || !repo) return;
    const value = { ...profile, name: profile.name.trim(), username: profile.username.trim(), sshKey: profile.sshKey.trim() };
    if (!value.name || (value.kind === 'ssh' && !value.sshKey) || (value.kind === 'https' && (!value.username || (!hasToken && !token.trim())))) { setError('Complete the profile fields before saving.'); return; }
    setBusy(true); clear();
    try {
      if (token.trim()) await api().pushProfiles.setToken(repo, value.id, token);
      store.setPushProfiles(repo, [...profiles.filter((p) => p.id !== value.id), value]);
      setProfile(null); setToken(''); setMessage('Push authentication saved.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const deleteProfile = async (p: PushProfile) => {
    if (!repo) return;
    if (!await askConfirm('Delete push authentication', `Delete “${p.name}” and its saved token?`, { label: 'Delete', danger: true })) return;
    setBusy(true); clear();
    try {
      await api().pushProfiles.setToken(repo, p.id, null);
      store.setPushProfiles(repo, profiles.filter((x) => x.id !== p.id));
      if (store.selectedPushProfiles?.[repo] === p.id) store.selectPushProfile(repo, '');
      if (profile?.id === p.id) setProfile(null);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-[1080px] space-y-6">
      <div><h1 className="text-[28px] font-semibold">Profiles</h1><p className="mt-2 text-sm leading-relaxed text-sub">Manage the name and email used for future commits in GITVerse, and switch profiles from the top bar.</p></div>
      {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-[#f38ba8]/30 bg-[#f38ba8]/10 px-4 py-3 text-sm text-[#f38ba8]"><span aria-hidden>!</span><span className="whitespace-pre-wrap">{error}</span></p>}
      {message && <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-[#a6e3a1]/30 bg-[#a6e3a1]/10 px-4 py-3 text-sm text-[#a6e3a1]"><CheckCircle2 size={16} aria-hidden />{message}</p>}
      <section className="space-y-4">
        <div className="rounded-lg border border-surface bg-mantle px-5 py-4"><h2 className="text-lg font-semibold">My profiles</h2><p className="mt-1 text-sm leading-relaxed text-sub">The selected profile applies to Git commands run by GITVerse across repositories. Existing commits keep their original author.</p></div>
        <button disabled={busy} className="flex min-h-[44px] items-center gap-2 rounded-md border border-[#a6e3a1]/60 px-3 py-2 text-sm text-[#a6e3a1] hover:bg-[#a6e3a1]/10 disabled:opacity-50" onClick={createIdentity}><Plus size={15} aria-hidden /> Add a profile</button>
        {!identities.length && <p className="rounded-lg border border-dashed border-surface bg-mantle/50 px-4 py-5 text-sm text-sub">No commit profiles yet. Add one to switch author identities.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {identities.map((p) => {
            const active = store.activeIdentityProfile === p.id;
            return (
              <article key={p.id} className={`min-w-0 rounded-lg border p-4 transition-colors ${active ? 'border-[#4cc2ff]/60 bg-[#4cc2ff]/10' : 'border-surface bg-mantle'}`}>
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#cba6f7]/20 text-[#cba6f7]"><UserRound size={18} aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words font-semibold">{p.name}</h3>
                      {active && <span className="inline-flex items-center gap-1 rounded-full bg-[#4cc2ff]/15 px-2 py-0.5 text-xs font-medium text-[#4cc2ff]"><Check size={12} aria-hidden />Active</span>}
                    </div>
                    <p className="mt-1 break-words text-sm text-sub">{p.authorName}</p>
                    <p className="mt-0.5 break-all text-sm text-sub">{p.email}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-surface/70 pt-3">
                  <button disabled={busy || active} onClick={() => void activate(p)} aria-pressed={active} className="min-h-[40px] rounded-md bg-[#4cc2ff] px-3 text-sm font-medium text-crust disabled:cursor-default disabled:opacity-50">{active ? 'Currently active' : 'Use this profile'}</button>
                  <div className="flex gap-2">
                    <button disabled={busy} className={`${button} min-h-[40px] disabled:opacity-50`} onClick={() => { clear(); setIdentity(p); }}>Edit</button>
                    <button disabled={busy} className={`${button} min-h-[40px] text-[#f38ba8] disabled:opacity-50`} onClick={() => void deleteIdentity(p)}>Delete</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {identity && <div className="space-y-4 rounded-lg border border-surface bg-mantle p-4 sm:p-5">
          <div><h3 className="font-semibold">{identities.some((p) => p.id === identity.id) ? 'Edit commit profile' : 'Add commit profile'}</h3><p className="mt-1 text-sm text-sub">These details will be used as the author on future commits.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">Profile label<input value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} className={`${field} mt-1`} /></label>
          <label className="block text-sm">Commit author name<input value={identity.authorName} onChange={(e) => setIdentity({ ...identity, authorName: e.target.value })} className={`${field} mt-1`} /></label>
          <label className="block text-sm sm:col-span-2">Commit author email<input type="email" autoComplete="email" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} className={`${field} mt-1`} /></label>
          </div>
          <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={saveIdentity} className="min-h-[40px] rounded-md bg-[#4cc2ff] px-4 font-medium text-crust disabled:opacity-40">{busy ? 'Saving…' : 'Save profile'}</button><button disabled={busy} className={`${button} min-h-[40px]`} onClick={() => setIdentity(null)}>Cancel</button></div>
        </div>}
      </section>
      {repo && <section className="space-y-3 rounded-xl border border-surface bg-mantle p-5">
        <div><h2 className="font-semibold">Push authentication</h2><p className="mt-1 break-all text-sm text-sub">Credentials for {repo}. This does not change commit authors.</p></div>
        <label className="block text-sm">Active authentication<select className={`${field} mt-1`} value={store.selectedPushProfiles?.[repo] ?? ''} onChange={(e) => store.selectPushProfile(repo, e.target.value)}><option value="">Git system credentials</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {profiles.map((p) => <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-surface px-3 py-2"><div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-sub">{p.kind === 'https' ? 'HTTPS credentials' : p.kind === 'ssh' ? 'SSH private key' : 'Git system credentials'}</div></div><button className={button} onClick={() => void editProfile(p)}>Edit</button><button disabled={busy} className={`${button} text-[#f38ba8]`} onClick={() => void deleteProfile(p)}>Delete</button></div>)}
        <button className={button} onClick={() => { clear(); setToken(''); setHasToken(false); setProfile({ id: crypto.randomUUID(), name: '', kind: 'system', username: '', sshKey: '' }); }}>Add push authentication</button>
        {profile && <div className="space-y-3 rounded-lg border border-surface p-3">
          <label className="block text-sm">Profile label<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} className={`${field} mt-1`} /></label>
          <label className="block text-sm">Authentication<select value={profile.kind} onChange={(e) => setProfile({ ...profile, kind: e.target.value as PushProfile['kind'] })} className={`${field} mt-1`}><option value="system">Git system credentials</option><option value="ssh">SSH private key</option><option value="https">HTTPS username and password or token</option></select></label>
          {profile.kind === 'ssh' && <label className="block text-sm">SSH private key<div className="mt-1 flex gap-2"><input value={profile.sshKey} onChange={(e) => setProfile({ ...profile, sshKey: e.target.value })} className={field} /><button className={button} onClick={async () => { try { const path = await api().pushProfiles.chooseKey(); if (path) setProfile({ ...profile, sshKey: path }); } catch (e) { setError(errorText(e)); } }}>Browse</button></div><span className="mt-1 block text-xs text-sub">Use an SSH remote and unlock passphrase-protected keys with your SSH agent.</span></label>}
          {profile.kind === 'https' && <><label className="block text-sm">Username<input autoComplete="username" value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} className={`${field} mt-1`} /></label><label className="block text-sm">Password or access token<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={hasToken ? 'Saved — leave blank to keep' : 'Password or access token'} className={`${field} mt-1`} /></label><p className="text-xs text-sub">Encrypted on this device. Your provider may require an access token instead of a password.</p></>}
          <div className="flex gap-2"><button disabled={busy} onClick={saveProfile} className="rounded-md bg-[#4cc2ff] px-3 py-2 font-medium text-crust disabled:opacity-40">Save</button><button className={button} onClick={() => { setProfile(null); setToken(''); }}>Cancel</button></div>
        </div>}
      </section>}
    </div>
  );
}
