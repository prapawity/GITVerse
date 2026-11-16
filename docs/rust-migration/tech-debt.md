# Tech Debt Audit — ก่อนย้ายไป Rust

Priority = (Impact + Risk) × (6 − Effort)

| # | Item | Type | I | R | E | Score |
|---|---|---|---|---|---|---|
| 1 | IPC contract ไม่มี schema เดียว — `preload.ts` (45 methods) + `src/shared/types.ts` + handler sync กันด้วยมือ, git handlers register แบบ `any[]` (main.ts:106) | Architecture | 5 | 5 | 2 | **40** |
| 2 | Renderer อ้าง `window.gitApi` ตรงๆ หลายจุด ไม่มี platform adapter | Architecture | 4 | 4 | 2 | **32** |
| 3 | `git.ts` 1,458 LOC ไฟล์เดียว รวม exec + parsing + business logic | Code | 4 | 4 | 3 | **24** |
| 4 | ไม่มี golden-output test ของ parser (log/status/stash) ที่ Rust จะต้องเทียบ | Test | 4 | 5 | 2 | **36** |
| 5 | Secrets ผูกกับ Electron `safeStorage` — ย้ายข้าม runtime ไม่ได้ | Architecture | 3 | 4 | 2 | **28** |
| 6 | `App.tsx` 1,398 LOC และ `Settings.tsx` 1,020 LOC | Code | 3 | 2 | 3 | 15 |
| 7 | Copilot ผูกกับ Node SDK (`@github/copilot-sdk`) | Dependency | 3 | 4 | 4 | 14 |
| 8 | Smoke test (`smoke-electron.cjs`) ผูกกับ Electron, ไม่มี E2E ที่ runtime-agnostic | Test | 3 | 4 | 3 | 21 |
| 9 | `release/` มีโฟลเดอร์ QA/review build เก่ากองอยู่ในรีโป, `dist*` อยู่ใน working tree | Infra | 1 | 1 | 1 | 10 |
| 10 | Updater logic ผูก `electron-updater` + dialog ใน `main.ts` ปนกับ IPC | Code | 2 | 3 | 2 | 20 |

## Remediation plan (ทำควบคู่กับ feature)

**Sprint 1 — เตรียมสะพาน (ทำใน TS ก่อน, ได้ประโยชน์แม้ไม่ย้าย)**
- #1 + #2: สร้าง `src/platform/api.ts` (interface) + `electron.ts` adapter; ให้ทุก store เรียกผ่าน adapter
- #4: เก็บ fixture output จริงของ `git log/status/stash/reflog` → test ฝั่ง TS ตอนนี้ แล้วใช้ fixture ชุดเดิมกับ Rust

**Sprint 2**
- #3: แยก `git.ts` เป็น `runner.ts`, `parsers/*.ts`, `ops/*.ts` (โครงเดียวกับ Rust module ที่จะเขียน)
- #10, #5: แยก updater/secrets ออกเป็น service ที่มี interface

**ระหว่าง/หลังย้าย**
- #8: เขียน E2E ด้วย WebDriver (`tauri-driver`) หรือ Playwright บน preview
- #6, #7, #9: ทำตามโอกาส
