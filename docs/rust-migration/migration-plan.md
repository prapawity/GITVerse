# Migration Plan: Electron → Tauri 2

อ่านคู่กับ [ADR-001](ADR-001-electron-to-tauri.md), [system-design](system-design.md), [tech-debt](tech-debt.md)

## หลักการ
1. UI ไม่ต้องรู้ว่าอยู่บน runtime ไหน — ทุกอย่างผ่าน `src/platform/api.ts`
2. ย้ายทีละ domain; Electron build ยัง ship ได้ตลอด จนกว่า Tauri จะครบ parity
3. Test ชุดเดียวกัน (fixture) ต้องผ่านทั้ง TS และ Rust ก่อนจะตัด TS ทิ้ง

## Phases

| Phase | งาน | ออกเมื่อ (Exit criteria) | ประมาณ |
|---|---|---|---|
| 0 Prep | Tech-debt #1 #2 #4 (adapter + fixtures) | stores ไม่เรียก `window.gitApi` ตรง; fixture tests ผ่าน | 1–1.5 สัปดาห์ |
| 1 Shell | `npm create tauri-app` เข้าโปรเจกต์ (`src-tauri/`), ใช้ Vite เดิม, adapter `tauri.ts`, `state`, `app:*` (dialog/opener) | แอปเปิดได้, เลือก repo ได้ บน Win/macOS/Linux | 1 สัปดาห์ |
| 2 Git read | GitRunner + status/log/diff/branches/refs/stash list/reflog + repo scan | fixture parity 100%, graph แสดงเหมือน Electron | 2 สัปดาห์ |
| 3 Git write | commit/stage/discard/merge/rebase/cherry-pick/squash/stash/tag/push/clone + token/SSH | test discard/stash/history เดิม port แล้วผ่าน | 2 สัปดาห์ |
| 4 Terminal | portable-pty | `terminal-pty-smoke` เวอร์ชัน Rust ผ่านทั้ง 3 OS | 0.5 สัปดาห์ |
| 5 AI | Claude, OpenAI (+OAuth), keyring, tool loop; Copilot sidecar | streaming + tool call + abort ทำงาน, secret อยู่ใน keychain | 2 สัปดาห์ |
| 6 Release | updater + signing (Apple notarize, Windows code sign) + CI matrix ใหม่ + THIRD_PARTY_NOTICES (cargo-about) | ติดตั้ง/อัปเดตอัตโนมัติจาก beta → beta ได้ | 1 สัปดาห์ |
| 7 Cutover | beta คู่ขนาน 2–4 สัปดาห์ แล้วลบ `electron/`, deps Electron | ไม่มี P1 bug เปิดอยู่ | — |

**รวมประมาณ 9–11 สัปดาห์** (1 คน full-time, มีพื้น Rust)

## Mapping

| Electron | Tauri / Rust |
|---|---|
| `ipcMain.handle('git:x')` | `#[tauri::command] git_x` + `tauri-specta` |
| `webContents.send` (ai:delta, term) | `tauri::ipc::Channel<T>` |
| `child_process` | `tokio::process::Command` |
| `node-pty` | `portable-pty` |
| `safeStorage` | `keyring` |
| `dialog`, `shell.openPath/openExternal` | `tauri-plugin-dialog`, `tauri-plugin-opener` |
| `electron-updater` | `tauri-plugin-updater` |
| `app.getPath('userData')` | `app.path().app_data_dir()` |
| `@anthropic-ai/sdk`, OpenAI | `reqwest` + SSE |
| `@github/copilot-sdk` | Node sidecar (ชั่วคราว) |
| `electron-builder.yml` | `tauri.conf.json` bundle |

## ความเสี่ยงและทางรับมือ

| Risk | Mitigation |
|---|---|
| CSS/JS ต่างกันใน WKWebView/WebKitGTK | ทดสอบ UI ทุก PR บน 3 OS ใน CI; หลีกเลี่ยง API เฉพาะ Chromium |
| ผู้ใช้เดิมเสีย API key/sign-in | แจ้งใน release notes + หน้าจอ re-auth ครั้งแรก |
| ผู้ใช้ Electron ไม่ได้รับ update ไป Tauri | ออก Electron เวอร์ชันสุดท้ายที่ชี้ไปดาวน์โหลด Tauri installer |
| Copilot sidecar เพิ่มขนาด | bundle Node SEA เฉพาะเมื่อเปิดใช้ Copilot หรือดาวน์โหลดตอนใช้ครั้งแรก |
| ทีมไม่คุ้น Rust | Phase 2 เป็นงาน pure parsing — เหมาะเป็นจุดเริ่มเรียน |

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
