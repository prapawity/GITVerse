# GITVerse Tauri — Backend System Design

## 1. Requirements

**Functional (ต้องเท่ากับ Electron ปัจจุบัน):** git ops 48 ตัว, repo scan + cancel, clone/push พร้อม token/SSH key, integrated terminal, AI (Claude / OpenAI sign-in / Copilot) พร้อม streaming + tool calls, persistent state, encrypted secrets, update check/install, เปิดไฟล์/URL/dialog

**Non-functional:** UI ไม่ค้างระหว่าง git ที่ยาว, ยกเลิกได้, secret ไม่ออกจาก backend, Windows/macOS/Linux, installer < 20MB

**Constraints:** React UI ห้ามรู้ว่ารันบน Electron หรือ Tauri (คุยผ่าน `window.gitApi` เท่านั้น)

## 2. High-level

```
┌──────────────────────── WebView (React, เดิม) ────────────────────────┐
│ Zustand stores → window.gitApi  (src/platform/tauri.ts | electron.ts)  │
└───────────────┬──────────────────────────────────▲─────────────────────┘
        invoke("git_status", …)               emit("ai:delta"), Channel<T>
┌───────────────▼──────────────────────────────────┴─────────────────────┐
│ src-tauri (Rust, tokio)                                                │
│  commands/  git · repo · ai · term · updates · app · state             │
│  core/                                                                 │
│   git/      GitRunner (tokio::process, timeout, cancel, env, parsing)  │
│   scan/     walkdir + CancellationToken                                │
│   pty/      portable-pty sessions (HashMap<id, Session>)               │
│   ai/       Provider trait → claude.rs, openai.rs, copilot(sidecar)    │
│   secrets/  keyring crate (Keychain / Cred Manager / Secret Service)   │
│   state/    JSON ใน app_data_dir (serde)                               │
│  plugins: dialog, opener, updater, store, process, shell(sidecar)      │
└───────────────┬────────────────────────────────────────────────────────┘
                ▼
     system `git`, shell, HTTPS APIs, copilot-sidecar (Node, ชั่วคราว)
```

## 3. Deep dive

### 3.1 IPC contract
- ทุก `git:<name>` ปัจจุบัน map เป็น `#[tauri::command] async fn git_<snake>` ตัวต่อตัว
- Type ร่วม: สร้าง TS types จาก Rust ด้วย **`specta` / `tauri-specta`** เพื่อแทน `src/shared/types.ts` และกัน contract drift
- Streaming (`ai:delta`, `term` output, scan progress): ใช้ `tauri::ipc::Channel<T>` ต่อ request แทน global event — ผูกกับ request id และ cleanup เองเมื่อ drop
- Error: enum `AppError { Git{code,stderr}, Cancelled, Auth, Io, … }` serialize เป็น `{kind,message}` ฝั่ง TS แปลงกลับเป็น Error ให้ store เดิมใช้ต่อได้

### 3.2 GitRunner
```rust
pub struct GitRunner { bin: PathBuf }
impl GitRunner {
  pub async fn run(&self, repo:&Path, args:&[&str], opt: RunOpt) -> Result<Output, AppError>
  // RunOpt { stdin, timeout, cancel: CancellationToken, env (GIT_TERMINAL_PROMPT=0, LC_ALL=C), }
}
```
- Windows: ตั้ง `CREATE_NO_WINDOW` ไม่งั้นมี console กระพริบ
- Parser (log/status porcelain v2/reflog/stash) เป็น pure function → unit test ได้โดยไม่ต้องมี repo
- Lock ต่อ repo (`DashMap<PathBuf, Mutex>`) สำหรับ write ops กัน index.lock ชนกัน

### 3.3 Secrets
- `safeStorage` → `keyring` crate; migration ครั้งแรก: อ่านไฟล์ base64 เดิมไม่ได้ (เข้ารหัสด้วย Electron key) → ให้ผู้ใช้ sign-in/ใส่ key ใหม่ครั้งเดียว แจ้งใน release notes

### 3.4 AI
- `trait Provider { async fn turn(&self, req, tx: Channel<AiEvent>) -> Result<()> }`
- Claude/OpenAI: `reqwest` + SSE (`eventsource-stream`), tool-call loop ย้ายจาก `ai/index.ts`
- OpenAI sign-in (OAuth + PKCE, ปัจจุบันใช้ `jose`): `oauth2` crate + loopback server (`tiny_http`) + `opener`
- Copilot: Phase แรกเป็น Node sidecar ที่ห่อ `@github/copilot-sdk` คุยผ่าน stdio JSON-lines; ภายหลังค่อยพิจารณาเขียน native

### 3.5 Terminal
- `portable-pty` + thread อ่าน output → `Channel<Vec<u8>>`; `term_write/resize/kill` ใช้ session id; kill ทุก session ตอน window close

### 3.6 Updates
- `tauri-plugin-updater` + `latest.json` บน GitHub Releases (เซ็นด้วย minisign key — เก็บ private key ใน GitHub secret)
- โค้ด semver compare/list releases เดิมย้ายเป็น Rust (`semver` crate) พร้อม test เดิม

## 4. Reliability & observability
- ทุก command มี timeout default + cancel; ไม่มี `unwrap()` ใน command path (clippy `unwrap_used = deny`)
- Log: `tracing` + `tauri-plugin-log` ลงไฟล์ใน app log dir, redact token/คีย์
- Crash: `std::panic::set_hook` เขียน log ก่อนปิด

## 5. Trade-offs ที่ต้อง revisit
| Decision | เมื่อไหร่ควร revisit |
|---|---|
| git CLI แทน `gix` | ถ้า log/graph ของ repo ใหญ่ (>100k commits) ช้า |
| Copilot sidecar | เมื่อมี Rust SDK หรือ protocol นิ่ง |
| JSON state file | ถ้า state ใหญ่/ต้อง query → SQLite (`tauri-plugin-sql`) |
| ไม่ใส่ Chromium | ถ้าเจอ bug WebKitGTK บน Linux หนัก ๆ |
