export type AppUpdateCheck =
  | { kind: 'development'; currentVersion: string }
  | { kind: 'current'; currentVersion: string }
  | { kind: 'optional'; currentVersion: string; version: string; url: string }
  | { kind: 'error'; currentVersion: string; message: string };
