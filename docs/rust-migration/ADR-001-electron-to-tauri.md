# ADR-001: ย้าย GITVerse by PRAPAWITY จาก Electron ไป Tauri 2 (Rust backend, React UI เดิม)

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Maintainers GITVerse by PRAPAWITY

## Context

GITVerse by PRAPAWITY เป็น Electron 45 + React 19 + TypeScript + Zustand ปัจจุบัน:

| ส่วน                                                                                        | ไฟล์                             | ขนาด                           |
| ------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Git operations (48 exported functions, ผ่าน `git` CLI, register อัตโนมัติเป็น `git:<name>`) | `electron/git/*.ts`              | ~1,600 LOC                     |
| Main / IPC / dialogs / updater                                                              | `electron/main.ts`, `preload.ts` | ~590 LOC, 45 bridge methods    |
| AI providers (Claude, OpenAI + sign-in, Copilot SDK)                                        | `electron/ai/*`                  | ~1,350 LOC                     |
| Terminal (`node-pty`)                                                                       | `electron/terminal.ts`           | ~200 LOC                       |
| Repo scan, state, updates                                                                   | `electron/*.ts`                  | ~275 LOC                       |
| Renderer UI                                                                                 | `src/`                           | ~12,000 LOC (ไม่ต้องเขียนใหม่) |

แรงจูงใจ: installer ขนาดใหญ่ (Chromium + Node), RAM สูง, native module (`node-pty`) ต้อง rebuild ทุกครั้งที่อัปเกรด Electron

## Decision

ใช้ **Tauri 2** เป็น shell ใหม่ เขียน backend ใหม่เป็น Rust และใช้ React UI เดิม โดยย้ายแบบ **strangler** ผ่าน abstraction `window.gitApi` ตัวเดิม ซึ่งทำให้ Electron กับ Tauri build อยู่ด้วยกันได้ระหว่างย้าย

## Options Considered

### A: Tauri 2 + React เดิม (เลือก)

| Dimension        | Assessment                         |
| ---------------- | ---------------------------------- |
| Complexity       | Medium–High (backend ~4k LOC ใหม่) |
| Cost             | ~8–12 สัปดาห์ สำหรับ 1–2 คน        |
| Footprint        | installer ~10–15MB, RAM ลดลงชัดเจน |
| Team familiarity | ต้องเรียน Rust                     |

**Pros:** เก็บ UI ทั้งหมด, security model (capabilities) เข้มกว่า, ไม่มี native-module rebuild
**Cons:** WebView ต่างกันในแต่ละ OS (WebView2 / WKWebView / WebKitGTK), Copilot SDK ไม่มีใน Rust

### B: Electron + Rust native module (napi-rs)

| Complexity | Low–Medium | Cost | 2–4 สัปดาห์ต่อ module | Footprint | ไม่เปลี่ยน |
**Pros:** เสี่ยงต่ำ ค่อยๆ ทำได้ **Cons:** ไม่แก้ปัญหาขนาด/RAM

### C: Rust native UI (egui/Iced/Slint)

**Cons:** ทิ้ง UI 12k LOC, diff/merge/graph ต้องเขียนใหม่หมด — ตัดทิ้ง

## Trade-off Analysis

- จุดที่ได้ผลจริงคือขนาดและ RAM ซึ่งทาง B ไม่ได้ให้ ดังนั้นถ้าเป้าหมายคือ footprint ต้องเป็น A
- ความเสี่ยงหลักของ A อยู่ที่ **AI/Copilot** กับ **WebView ข้าม OS** ไม่ใช่ที่ git (git.ts เรียก CLI อยู่แล้ว ย้ายแบบ 1:1 ได้)
- Copilot: ใช้ **Node sidecar** (Tauri `externalBin`) ชั่วคราว แทนการเขียน JSON-RPC client เอง — ทำให้ไม่บล็อก release แรก

## Consequences

- ง่ายขึ้น: distribution, auto-update แบบเซ็นด้วย key, permission แบบ capability-based
- ยากขึ้น: ต้องทดสอบ UI บน 3 WebView, debugging ข้ามภาษา, contributor ต้องรู้ Rust
- ต้อง revisit: เอา Node sidecar ของ Copilot ออก, พิจารณา `gix` แทน CLI สำหรับ read-path ที่ช้า (log/graph)

## Action Items

1. [ ] ทำ Phase 0 ใน `migration-plan.md` (hardening ฝั่ง TS ก่อนย้าย)
2. [ ] Spike 3 วัน: Tauri shell + `repo:open` + `git:status` ทำงานจริงบน Windows/macOS
3. [ ] ตัดสินใจ Accept/Reject ADR หลัง spike
