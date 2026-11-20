// "Open in…": editors and IDEs found on this computer.
import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';

interface Editor {
  id: string;
  name: string;
  /** macOS application names to try with `open -a` */
  apps: string[];
  /** command-line launchers on PATH (Windows / Linux, and macOS fallback) */
  cli: string[];
}

const EDITORS: Editor[] = [
  { id: 'vscode', name: 'Visual Studio Code', apps: ['Visual Studio Code'], cli: ['code'] },
  { id: 'cursor', name: 'Cursor', apps: ['Cursor'], cli: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', apps: ['Windsurf'], cli: ['windsurf'] },
  { id: 'zed', name: 'Zed', apps: ['Zed'], cli: ['zed'] },
  {
    id: 'idea',
    name: 'IntelliJ IDEA',
    apps: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'],
    cli: ['idea'],
  },
  { id: 'webstorm', name: 'WebStorm', apps: ['WebStorm'], cli: ['webstorm'] },
  { id: 'android-studio', name: 'Android Studio', apps: ['Android Studio'], cli: ['studio'] },
  { id: 'xcode', name: 'Xcode', apps: ['Xcode'], cli: [] },
  { id: 'sublime', name: 'Sublime Text', apps: ['Sublime Text'], cli: ['subl'] },
  { id: 'fleet', name: 'Fleet', apps: ['Fleet'], cli: ['fleet'] },
];

const SEARCH = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const onPath = (name: string) => {
  const exe = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of SEARCH) for (const e of exe) if (dir && existsSync(path.join(dir, e))) return path.join(dir, e);
  return null;
};
const macApp = (name: string) =>
  ['/Applications', path.join(process.env.HOME ?? '', 'Applications')]
    .map((dir) => path.join(dir, `${name}.app`))
    .find((p) => existsSync(p)) ?? null;

function locate(editor: Editor): { mac?: string; cli?: string } | null {
  if (process.platform === 'darwin') {
    const app = editor.apps.map(macApp).find(Boolean);
    if (app) return { mac: app };
  }
  const cli = editor.cli.map(onPath).find(Boolean);
  return cli ? { cli } : null;
}

export function registerEditors() {
  ipcMain.handle('app:editors', () => EDITORS.filter((e) => locate(e)).map(({ id, name }) => ({ id, name })));
  ipcMain.handle('app:openIn', (_e, id: string, target: string) => {
    const editor = EDITORS.find((e) => e.id === id);
    if (!editor) throw new Error('Unknown editor.');
    if (typeof target !== 'string' || !path.isAbsolute(target) || !existsSync(target))
      throw new Error('That file or folder does not exist.');
    statSync(target);
    const where = locate(editor);
    if (!where) throw new Error(`${editor.name} was not found on this computer.`);
    if (where.mac)
      return new Promise<void>((resolve, reject) =>
        execFile('open', ['-a', where.mac!, target], (error) => (error ? reject(error) : resolve())),
      );
    const child = spawn(where.cli!, [target], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32', // .cmd launchers need a shell on Windows
    });
    child.on('error', () => {});
    child.unref();
  });
  ipcMain.handle('app:setZoom', (event, factor: number) => {
    if (typeof factor !== 'number' || !Number.isFinite(factor)) throw new Error('Invalid zoom.');
    BrowserWindow.fromWebContents(event.sender)?.webContents.setZoomFactor(Math.min(3, Math.max(0.5, factor)));
  });
}
