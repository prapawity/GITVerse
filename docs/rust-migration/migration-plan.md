# Migration Plan: Electron → Tauri 2

อ่านคู่กับ [ADR-001](ADR-001-electron-to-tauri.md), [system-design](system-design.md), [tech-debt](tech-debt.md)

## หลักการ

1. UI ไม่ต้องรู้ว่าอยู่บน runtime ไหน — ทุกอย่างผ่าน `src/platform/api.ts`
2. ย้ายทีละ domain; Electron build ยัง ship ได้ตลอด จนกว่า Tauri จะครบ parity
3. Test ชุดเดียวกัน (fixture) ต้องผ่านทั้ง TS และ Rust ก่อนจะตัด TS ทิ้ง

## Phases

| Phase       | งาน                                                                                                                     | ออกเมื่อ (Exit criteria)                                    | ประมาณ        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| 0 Prep      | Tech-debt #1 #2 #4 (adapter + fixtures)                                                                                 | stores ไม่เรียก `window.gitApi` ตรง; fixture tests ผ่าน     | 1–1.5 สัปดาห์ |
| 1 Shell     | `npm create tauri-app` เข้าโปรเจกต์ (`src-tauri/`), ใช้ Vite เดิม, adapter `tauri.ts`, `state`, `app:*` (dialog/opener) | แอปเปิดได้, เลือก repo ได้ บน Win/macOS/Linux               | 1 สัปดาห์     |
| 2 Git read  | GitRunner + status/log/diff/branches/refs/stash list/reflog + repo scan                                                 | fixture parity 100%, graph แสดงเหมือน Electron              | 2 สัปดาห์     |
| 3 Git write | commit/stage/discard/merge/rebase/cherry-pick/squash/stash/tag/push/clone + token/SSH                                   | test discard/stash/history เดิม port แล้วผ่าน               | 2 สัปดาห์     |
| 4 Terminal  | portable-pty                                                                                                            | `terminal-pty-smoke` เวอร์ชัน Rust ผ่านทั้ง 3 OS            | 0.5 สัปดาห์   |
| 5 AI        | Claude, OpenAI (+OAuth), keyring, tool loop; Copilot sidecar                                                            | streaming + tool call + abort ทำงาน, secret อยู่ใน keychain | 2 สัปดาห์     |
| 6 Release   | updater + signing (Apple notarize, Windows code sign) + CI matrix ใหม่ + THIRD_PARTY_NOTICES (cargo-about)              | ติดตั้ง/อัปเดตอัตโนมัติจาก beta → beta ได้                  | 1 สัปดาห์     |
| 7 Cutover   | beta คู่ขนาน 2–4 สัปดาห์ แล้วลบ `electron/`, deps Electron                                                              | ไม่มี P1 bug เปิดอยู่                                       | —             |

**รวมประมาณ 9–11 สัปดาห์** (1 คน full-time, มีพื้น Rust)

## Mapping

| Electron                                | Tauri / Rust                                 |
| --------------------------------------- | -------------------------------------------- |
| `ipcMain.handle('git:x')`               | `#[tauri::command] git_x` + `tauri-specta`   |
| `webContents.send` (ai:delta, term)     | `tauri::ipc::Channel<T>`                     |
| `child_process`                         | `tokio::process::Command`                    |
| `node-pty`                              | `portable-pty`                               |
| `safeStorage`                           | `keyring`                                    |
| `dialog`, `shell.openPath/openExternal` | `tauri-plugin-dialog`, `tauri-plugin-opener` |
| `electron-updater`                      | `tauri-plugin-updater`                       |
| `app.getPath('userData')`               | `app.path().app_data_dir()`                  |
| `@anthropic-ai/sdk`, OpenAI             | `reqwest` + SSE                              |
| `@github/copilot-sdk`                   | Node sidecar (ชั่วคราว)                      |
| `electron-builder.yml`                  | `tauri.conf.json` bundle                     |

## ความเสี่ยงและทางรับมือ

| Risk                                      | Mitigation                                                            |
| ----------------------------------------- | --------------------------------------------------------------------- |
| CSS/JS ต่างกันใน WKWebView/WebKitGTK      | ทดสอบ UI ทุก PR บน 3 OS ใน CI; หลีกเลี่ยง API เฉพาะ Chromium          |
| ผู้ใช้เดิมเสีย API key/sign-in            | แจ้งใน release notes + หน้าจอ re-auth ครั้งแรก                        |
| ผู้ใช้ Electron ไม่ได้รับ update ไป Tauri | ออก Electron เวอร์ชันสุดท้ายที่ชี้ไปดาวน์โหลด Tauri installer         |
| Copilot sidecar เพิ่มขนาด                 | bundle Node SEA เฉพาะเมื่อเปิดใช้ Copilot หรือดาวน์โหลดตอนใช้ครั้งแรก |
| ทีมไม่คุ้น Rust                           | Phase 2 เป็นงาน pure parsing — เหมาะเป็นจุดเริ่มเรียน                 |

## Rollback

จนถึง Phase 7 Electron build ยังอยู่ใน CI — ถ้า Tauri beta มีปัญหาร้ายแรง แค่หยุด publish Tauri channel; ข้อมูลผู้ใช้ (state JSON) อ่านได้ทั้งสองฝั่ง

## Phase 0 — สถานะ (2026-11-16)

- [x] `src/platform/api.ts` — `PlatformApi` interface + `platformApi()` (optional) / `desktopApi()` (throw ถ้าไม่มี bridge); ทุกไฟล์ใน `src/` เลิกใช้ `(window as any).gitApi` แล้ว
- [x] `src/shared/gitMethods.ts` — รายชื่อ git method 68 ตัวเป็น source of truth เดียว; `preload.ts` ใช้ list นี้
- [x] `src/shared/gitMethods.test.ts` — contract test: list ต้องตรงกับ `handlers` ใน `electron/main.ts`
- [x] `electron/git/contract.golden.test.ts` + `fixtures/git-contract/*.json` — golden output ของ log/status/refs/reflog/commitDetail/fileChangeCounts/fileBlame/fileHistory/opState จาก repo ที่ deterministic (Rust ต้องได้ JSON เดียวกัน). อัปเดต: `UPDATE_FIXTURES=1 npm test`
- [ ] ระบุ type ของ git method ทีละตัว (ตอนนี้ยังเป็น `AnyAsync`) — จะได้จาก `tauri-specta` ใน Phase 1
- [ ] เพิ่ม golden ของ diff (`commitFileDiff`, `workingFileDiff`) และ stash list

## Phase 1 — สถานะ (2026-11-16)

- [x] `src-tauri/` Cargo workspace: แอป Tauri 2 (`gitverse`) + `core/` (`gitverse-core`, ไม่พึ่ง Tauri → `cargo test` ได้ทุกที่)
- [x] `core`: `GitRunner` (tokio, timeout, cancel, `GIT_TERMINAL_PROMPT=0`, `CREATE_NO_WINDOW` บน Windows, identity แบบเดียวกับ git.ts), `AppError` → `{kind,message}`, `state` (ไฟล์ `gitverse-state.json` เดียวกับ Electron)
- [x] `git:status` ใน Rust ผ่าน golden fixture เดียวกับ TS (`core/tests/golden_contract.rs`)
- [x] Commands: `state_load/state_save`, `repo_open` (dialog), `set_identity`, `git_call(method,args)` (dispatcher แทน `git:<name>`), `ported_git_methods`
- [x] Data dir = `<appData>/GITVerse` เหมือน Electron → repo/ settings ใช้ร่วมกัน
- [x] TS: `src/platform/tauri.ts` + `initPlatform()`; `main.tsx` init bridge ก่อน import stores; method ที่ยังไม่ port reject พร้อมข้อความชัดเจน; updates ทำตัวเป็น development build
- [x] `vite.config.ts` ข้าม electron plugin เมื่อรันจาก Tauri CLI; scripts `dev:tauri`, `build:tauri`, `test:rust`
- [ ] ทดสอบ `npm run dev:tauri` บน Windows/macOS
- [ ] Drag-and-drop โฟลเดอร์ (Tauri ใช้ drag-drop event แทน `File.path`)

## Phase 2 — สถานะ (2026-11-16)

- [x] Read-side ทั้งหมดใน Rust: `log`, `refs` (+stashes), `reflog`, `historyPosition`, `commitDetail`, `commitFileDiff`, `workingFileDiff`, `fileChangeCounts`, `fileBlame`, `fileHistory`, `opState` (+ `status` จาก Phase 1)
- [x] Golden fixtures เพิ่ม `historyPosition`, `commitFileDiff`, `workingFileDiff` (staged / unstaged / deleted / untracked) — Rust ตรงกับ TS ทั้ง 12 fixtures บน Linux และ Windows
- [x] `GitRunner`: `ok_codes` (เช่น `diff --no-index` exit 1), `base_env` (แยก test จาก config ผู้ใช้), `no_identity`
- [x] แอป Tauri แสดง graph, branches, remotes, tags, working changes และ diff ได้แล้ว (ทดสอบบน Windows)
- [ ] Read-side ที่ยังเหลือ: `stashDetail`, `stashFileDiff`, `stashFileAt`, `fileAt`, `fileBlobAt`, `workingFileBlob`, `readWorkFile`, `pushInfo`, `commitIdentity`, `remoteUrl`, `inspectWorkspace`, `indexUndoState`, `agentCheckpoints`, `rebasePreview`, `windowsUnsupportedPathsForRef`

## Phase 3 batch A — สถานะ (2026-11-16)

- [x] Write-side ใน Rust (`core/src/git/write.rs`, `stash.rs`, `windows.rs`): stage/unstage, commit (amend/signoff/gpg), checkout, createBranch, branchAt, deleteBranch (+remote), stash/stashPop/stashAction/stashRename/stashDetail/stashDiff, reset, cherryPick, revert, rebaseOnto, merge, opContinue/opAbort/opSkip, resolveFile, tags, fileAt, formatPatch, remoteUrl, commit identity, fetch/pull/push, readWorkFile/writeWorkFile, windowsUnsupportedPathsForRef
- [x] Windows path preflight (`ensureTargetTreeSupported`, sparse rules) ported พร้อม unit test
- [x] Golden **write scenarios**: 48 สถานการณ์ (`electron/git/contract.write.test.ts` ↔ `core/tests/golden_write.rs`) บันทึกผลลัพธ์/error + สถานะ repo หลังทำ — TS และ Rust ตรงกันทั้ง Linux และ Windows
- [x] พบและแก้ bug ใน TS `stashRename`: rename stash ล่าสุดทำให้ stash หาย (หรือลบ stash อื่น) เพราะ `git stash store` ของ hash เดิมไม่เพิ่ม reflog
- [x] Batch B: ดูหัวข้อถัดไป

## Phase 3 batch B — สถานะ (2026-11-16)

- [x] Rust: `checkoutRemote` (+ Windows sparse, fast-forward, worktree guard), `clone` (progress event `repo:cloneProgress`), `pushInfo`/`pushBranch` (system / SSH key / HTTPS token ผ่าน askpass), `stagedForCommitMessage`, stage/discard ทีละ hunk, `discardWorkingFiles`, undo/redo ของ index (`trackedStage`, `indexUndoState`, `moveIndexHistory`), `squashCommits`, `cherryPickMany`, `rebasePreview`, `stashFileDiff`/`stashFileAt`, blobs (base64), `worktreeAdd`, `inspectWorkspace` (ซ่อน credential ใน URL), `agentCheckpoints`
- [x] Golden write scenarios รวม 88 (เพิ่ม 40) — TS และ Rust ตรงกันบน Linux และ Windows
- [x] พบและแก้ bug ใน TS `clone`: path แบบ Windows drive (`C:\repo`) ผ่านการตรวจ URL เพราะดูเหมือน SSH `host:path`
- [x] Git method ทุกตัวใน `GIT_METHODS` ย้ายมา Rust แล้ว
- [ ] HTTPS token ที่บันทึกไว้ (`push:setToken`/`tokenStatus`) — รอ Phase 5 (keychain)
- [ ] `inspectWorkspace` ต้องใช้ git ≥ 2.36 (`worktree list -z`) — เหมือนฝั่ง TS เดิม

## Phase 4 — สถานะ (2026-11-16)

- [x] `core/src/terminal.rs` ใช้ `portable-pty`: PTY จริงทุก OS (ConPTY บน Windows) แทน node-pty + Python bridge + pipe fallback เดิม
- [x] UTF-8 ที่ถูกตัดกลาง chunk ต่อกันถูกต้อง (ทดสอบด้วยภาษาไทย); shell ปิดเอง → ส่ง `term:exit` ครั้งเดียว; ปิดแอป → kill ทุก shell
- [x] ConPTY: ปิด PTY เมื่อ process จบ (ไม่งั้น reader ไม่จบ) และตอบ DSR `ESC[6n` ใน test เหมือน xterm.js
- [x] Commands `term_spawn/write/resize/kill` + events `term:data`/`term:exit`; adapter ใน `src/platform/tauri.ts`
- [x] `TerminalPanel`: Ctrl+V / Ctrl+Shift+V / Ctrl+C (เมื่อมี selection) ทำงานเองไม่พึ่งเมนูแอป และใช้ `event.code` จึงใช้ได้กับคีย์บอร์ดภาษาไทย

## Phase 5A — สถานะ (2026-11-16)

- [x] Secrets ใน OS credential store (`core/src/secrets.rs`, crate `keyring`): Keychain / Credential Manager / Secret Service แทน `safeStorage`; key name เดิม (`ai.apiKey`, `push.token.<sha256>`) — ค่าเดิมที่ Electron เข้ารหัสไว้อ่านไม่ได้ ผู้ใช้ต้องใส่ใหม่ 1 ครั้ง
- [x] Claude ใน Rust (`core/src/ai/claude.rs`): streaming turn (text / thinking / tool_use + signature), commit message, auto-resolve conflict ด้วย structured output, retry แบบ SDK, error message เดียวกับ TS; ทดสอบกับ mock server
- [x] `src/shared/aiSpec.json` สร้างจาก `aiTools.ts` (`scripts/ai-spec.ts`) — Rust ใช้ไฟล์นี้ จึงส่ง tools / system prompt / schema เหมือน TS; test ฝั่ง TS กันไม่ให้ไฟล์ล้าสมัย
- [x] HTTPS push token ที่บันทึกไว้ใช้ได้แล้วใน Tauri (`push:tokenStatus` / `push:setToken`)
- [x] `profile.dev` ใช้ `debug = "line-tables-only"` — `target/` จาก 15 GB เหลือ ~2 GB
- [ ] Phase 5B: OpenAI (API key + Sign in with ChatGPT)
- [ ] Phase 5C: Copilot (Node sidecar)

### Phase 5B — ChatGPT in Rust (done)

- `core/src/ai/openai.rs`: API key or "Sign in with ChatGPT" (OAuth PKCE, loopback on 1455–1457, nonce/aud checks), rotating refresh (`invalid_grant` drops the sign-in), plan-first credential choice, 10-minute model cache, Responses API streaming with function tools (`store:false`), commit message and strict JSON-schema conflict resolution. Error texts match `mapHttp()` in openai.ts.
- New commands: `ai_openai_sign_in` / `ai_openai_cancel` / `ai_openai_sign_out`; `ai_status`, `ai_set_key`, `ai_models`, `ai_turn`, `ai_commit_message`, `ai_resolve_conflict` handle `openai`.
- Tests: mock servers for streaming turns, refresh, `invalid_grant`, model filters, resolve, a truncated stream, and a full loopback sign-in.
- Next: 5C Copilot (Node sidecar).

### Phase 5C — Copilot through a Node sidecar (done)

- The Copilot SDK only runs on Node, so `electron/ai/copilotSidecar.ts` (built by `npm run build:sidecar` to `sidecar/copilot-sidecar.mjs`) wraps the same `copilot.ts` and speaks JSON lines on stdio. `copilot.ts` no longer imports Electron: token storage is injected (`configureCopilot`), and the shared helpers moved to `electron/ai/parse.ts`.
- `core/src/ai/copilot.rs` starts `node` on first use (GITVERSE_NODE / GITVERSE_COPILOT_SIDECAR override), hands over the keychain token with `setToken`, routes `ai:delta` / `ai:toolcall` events, sends `abort` on cancel and kills the sidecar on exit.
- Commands: `ai_copilot_status`, `ai_copilot_begin_login` / `advance` / `cancel` (only `https://github.com` sign-in URLs are opened), `ai_tool_result`, `ai_reset`; all AI commands now handle all three providers.
- Tests: a fake sidecar exercises the protocol (token handover, tool round trip, abort, errors); skipped where Node is absent.
- Open for Phase 6: shipping Node and `node_modules/@github/copilot*` with release builds (today the sidecar uses Node on PATH and the repo's node_modules).

### Phase 6A — folder scan, drag-and-drop, files and notices (done)

- `core/src/scan.rs` ports `repositoryScan.ts` (skips hidden/dependency folders, does not follow symlinks, worktrees count, invalid `.git` is skipped) with the same tests. Commands `repo_find_repositories` / `repo_cancel_scan` and the `repo:scanProgress` event.
- Drag-and-drop: Tauri's web view does not expose file paths on DOM drops, so `PlatformApi.onFileDrop` (Tauri only) feeds `App.tsx` from the native drag-drop event.
- `repo_open_file` (refuses paths outside the repository), `app_open_third_party_notices`; `app_open_runtime_notice` explains that the Tauri build uses the system web view.
- The generated `sidecar/` bundle is excluded from ESLint and Prettier.
- Still open: the updater (needs a signing key pair and an update feed), bundling Node + Copilot runtime, release/signing CI.
