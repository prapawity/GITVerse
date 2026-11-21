import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The renderer bridge reaches git, files and a terminal, so only the app's own top-level page may
// call it. This module must be imported before anything registers an IPC handler: it wraps
// ipcMain.handle / ipcMain.on so every handler checks its sender.

export function isAppUrl(url: string): boolean {
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) return url.startsWith(new URL(dev).origin + '/');
  return url.startsWith(pathToFileURL(path.join(__dirname, '../../dist/')).href);
}

function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return !!frame && frame.parent === null && isAppUrl(frame.url);
}

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error(`Blocked IPC "${channel}" from an untrusted page`);
    return listener(e, ...args);
  });

const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) =>
  on(channel, (e, ...args) => {
    if (!trusted(e)) {
      e.returnValue = undefined;
      return;
    }
    listener(e, ...args);
  });
