import { ipcMain, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Integrated terminal backend.
 * Prefers node-pty (real PTY with resize) when it is installed and rebuilt for Electron;
 * otherwise falls back to a small Python PTY bridge (no native modules needed).
 */
interface Term {
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
}

// Reads stdin, forwards it to the PTY, and treats ESC ] GV ; cols ; rows BEL as a resize request.
const PTY_BRIDGE = String.raw`
import os, pty, sys, select, fcntl, termios, struct
cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-l'])
def size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
size(cols, rows)
MARK = b'\x1b]GV;'
inp = sys.stdin.buffer.fileno()
buf = b''
while True:
    r, _, _ = select.select([fd, inp], [], [])
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    if inp in r:
        data = os.read(inp, 65536)
        if not data:
            break
        buf += data
        while True:
            i = buf.find(MARK)
            j = buf.find(b'\x07', i) if i >= 0 else -1
            if i < 0 or j < 0:
                break
            try:
                c, rr = buf[i + len(MARK):j].split(b';')
                size(int(c), int(rr))
            except Exception:
                pass
            buf = buf[:i] + buf[j + 1:]
        if buf.find(MARK) < 0:
            os.write(fd, buf); buf = b''
try:
    _, st = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
except ChildProcessError:
    sys.exit(0)
`;

let pty: any = null;
try {
  // optional dependency; kept external from the bundle
  pty = require('node-pty');
} catch {
  /* fallback below */
}

const terms = new Map<number, Term>();
let seq = 0;

function shellPath(custom?: string) {
  if (custom && existsSync(custom)) return custom;
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  const s = process.env.SHELL;
  return s && existsSync(s) ? s : existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

function start(sender: WebContents, cwd: string, cols: number, rows: number, customShell?: string): number {
  const id = ++seq;
  const send = (ch: string, ...a: unknown[]) => {
    if (!sender.isDestroyed()) sender.send(ch, id, ...a);
  };
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLUMNS: String(cols),
    LINES: String(rows),
  } as Record<string, string>;
  const shell = shellPath(customShell);

  if (pty) {
    const p = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    p.onData((d: string) => send('term:data', d));
    p.onExit(({ exitCode }: { exitCode: number }) => {
      terms.delete(id);
      send('term:exit', exitCode);
    });
    terms.set(id, { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill() });
    return id;
  }

  if (process.platform === 'win32') {
    // no PTY without node-pty on Windows: plain pipes still run commands, without line editing
    const p = spawn(shell, [], { cwd, env });
    p.stdout.on('data', (d: Buffer) => send('term:data', d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => send('term:data', d.toString('utf8')));
    p.on('exit', (code) => {
      terms.delete(id);
      send('term:exit', code ?? 0);
    });
    terms.set(id, { write: (d) => p.stdin.write(d), resize: () => {}, kill: () => p.kill() });
    return id;
  }

  // macOS/Linux: a tiny Python PTY bridge gives the shell a real terminal (colours, line editing,
  // full-screen tools) and supports resize through an in-band control sequence.
  const p = spawn('python3', ['-c', PTY_BRIDGE, String(cols), String(rows), shell], { cwd, env });
  p.stdout.on('data', (d: Buffer) => send('term:data', d.toString('utf8')));
  p.stderr.on('data', (d: Buffer) => send('term:data', d.toString('utf8')));
  p.on('exit', (code) => {
    terms.delete(id);
    send('term:exit', code ?? 0);
  });
  p.on('error', (e) =>
    send('term:data', `\r\n[GITVerse] could not start terminal (python3 is required): ${e.message}\r\n`),
  );
  terms.set(id, {
    write: (d) => p.stdin.write(d),
    resize: (c, r) => p.stdin.write(`\x1b]GV;${c};${r}\x07`),
    kill: () => p.kill(),
  });
  return id;
}

export function registerTerminal() {
  ipcMain.handle('term:spawn', (e, cwd: string, cols: number, rows: number, shell?: string) =>
    start(
      e.sender,
      cwd && existsSync(cwd) ? cwd : process.env.HOME || '/',
      Math.max(20, cols | 0),
      Math.max(5, rows | 0),
      shell,
    ),
  );
  ipcMain.handle('term:write', (_e, id: number, data: string) => terms.get(id)?.write(data));
  ipcMain.handle('term:resize', (_e, id: number, c: number, r: number) =>
    terms.get(id)?.resize(Math.max(20, c | 0), Math.max(5, r | 0)),
  );
  ipcMain.handle('term:kill', (_e, id: number) => {
    terms.get(id)?.kill();
    terms.delete(id);
  });
}
