import './mock';
import { useRepo } from '../src/store/repoStore';
import { useSettings } from '../src/store/settingsStore';
if (new URLSearchParams(location.search).get('pagesize')) {
  useSettings.setState({ initialCommits: Number(new URLSearchParams(location.search).get('pagesize')) });
  setTimeout(() => {
    document.title = `commits=${useRepo.getState().commits.length} hasMore=${useRepo.getState().hasMore}`;
  }, 2500);
}
import '../src/main';

const MD = [
  '# Playwright Coverage Checklist',
  '',
  'Checklist สำหรับ **browser-level** confidence of `MiniApp`',
  '',
  '## Bill Payment',
  '',
  '- [x] Mpay landing happy path',
  '- [ ] Change card flow from shared card list',
  '',
  '```ts',
  'const a = 1;',
  '```',
].join('\n');
Object.assign((window as any).gitApi, {
  remoteUrl: async () => 'git@github.com:acme/miniapp.git',
  fileAt: async () => MD,
  fileHistory: async () => [
    {
      hash: '0000abcdef',
      author: 'Alex Example',
      date: new Date(Date.now() - 3600e3 * 20).toISOString(),
      subject: '[DEMO-18562] Update checklist',
    },
    {
      hash: '0003abcdef',
      author: 'Sam Example',
      date: new Date(Date.now() - 86400e3 * 9).toISOString(),
      subject: 'Add playwright docs',
    },
  ],
  fileBlame: async () =>
    MD.split('\n').map((_, i) => ({
      hash: (i < 6 ? '0000abcdef' : '0003abcdef').padEnd(40, '0'),
      author: i < 6 ? 'Alex Example' : 'Sam Example',
      time: Date.now() - (i < 6 ? 20 : 220) * 3600e3,
    })),
});

// ?slow=ms[&only=a,b] delays mock git calls so loading states can be screenshotted
{
  const api = (window as any).gitApi;
  Object.assign(api, { fetch: async () => {}, pull: async () => {}, push: async () => {}, stash: async () => {} });
  const slow = Number(new URLSearchParams(location.search).get('slow') ?? 0);
  const only = new URLSearchParams(location.search).get('only')?.split(',');
  if (slow)
    for (const k of Object.keys(api))
      if (!only || only.includes(k)) {
        const f = api[k];
        api[k] = (...a: unknown[]) => new Promise((r) => setTimeout(r, slow)).then(() => f(...a));
      }
}
if (new URLSearchParams(location.search).get('conflict'))
  Object.assign((window as any).gitApi, {
    opState: async () => ({
      kind: 'rebase',
      step: '1/1',
      head: 'sq17/test',
      onto: '78fd4b6',
      message: 'test',
      files: [
        'lib/config/mini_app_config.dart',
        'lib/src/webview/channels/js_channels.dart',
        'lib/src/webview/web_view_stack.dart',
      ],
      resolved: [
        { status: 'M', path: 'lib/miniappdevicesdk.dart' },
        { status: 'M', path: 'lib/src/services/dio_client.dart' },
        { status: 'A', path: 'lib/src/services/miniapp_api_client.dart' },
      ],
    }),
    readWorkFile: async () => {
      const out: string[] = [];
      for (let c = 1; c <= 4; c++) {
        for (let i = 0; i < 45; i++) out.push(`  final int line${c}_${i} = ${i};`);
        out.push(
          '<<<<<<< HEAD',
          `  static const baseUrl${c} = 'https://gateway.dev';`,
          '=======',
          `  static const baseUrl${c} = 'https://gateway.sit';`,
          `  static const timeout${c} = 30;`,
          '>>>>>>> 9414a9d (test)',
        );
      }
      out.push('}');
      return out.join('\n');
    },
  });
// a tiny fake shell so the terminal can be screenshotted outside Electron
Object.assign((window as any).gitApi, {
  term: (() => {
    let cb: any = null;
    let line = '';
    return {
      spawn: async () => {
        setTimeout(
          () =>
            cb?.(
              1,
              '\x1b[32m11446085@mac\x1b[0m \x1b[34m~/projects/miniapp-sdk\x1b[0m \x1b[33m(78fd4b6 REBASE 1/1)\x1b[0m $ ',
            ),
          50,
        );
        return 1;
      },
      write: async (_: number, d: string) => {
        if (d === '\r') {
          cb?.(1, '\r\n' + (line === 'git status' ? 'interactive rebase in progress; onto 78fd4b6\r\n' : '') + '$ ');
          line = '';
        } else {
          line += d;
          cb?.(1, d);
        }
      },
      resize: async () => {},
      kill: async () => {},
      onData: (f: any) => {
        cb = f;
        return () => {};
      },
      onExit: () => () => {},
    };
  })(),
});
useRepo
  .getState()
  .openRepo('/Users/me/projects/demo-project')
  .then(() => {
    if (!new URLSearchParams(location.search).get('conflict'))
      useRepo.getState().select('0000abcdef0123456789abcdef0123456789abcd');
  });
const q = new URLSearchParams(location.search);
const btn = (t: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(t)) as HTMLElement | undefined;
if (q.get('menu'))
  setTimeout(() => {
    const el = document.querySelector('canvas')!.parentElement as HTMLElement;
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: 500, clientY: 200, bubbles: true }));
    if (q.get('menu') === 'reset') setTimeout(() => btn('Reset')?.click(), 200);
  }, 800);
if (q.get('md'))
  setTimeout(() => {
    (document.querySelector('[title*="readme.md"]') as HTMLElement)?.click();
    setTimeout(() => {
      btn('File View')?.click();
      if (q.get('md') === 'code' || q.get('md') === 'blame') setTimeout(() => btn('Code')?.click(), 150);
      if (q.get('md') === 'blame') setTimeout(() => btn('Blame')?.click(), 300);
      if (q.get('md') === 'hist') setTimeout(() => btn('History')?.click(), 200);
    }, 250);
  }, 800);

if (q.get('lazy')) {
  setTimeout(() => {
    document.title = `before pages=${(window as any).__pages} commits=${useRepo.getState().commits.length}`;
  }, 1200);
  let n = 0;
  const t = setInterval(() => {
    const el = document.querySelector('canvas')!.parentElement as HTMLElement;
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
    if (++n === 12) {
      clearInterval(t);
      document.title = `after pages=${(window as any).__pages} commits=${useRepo.getState().commits.length} hasMore=${useRepo.getState().hasMore}`;
    }
  }, 400);
}
if (q.get('hscroll'))
  setTimeout(() => {
    const el = document.querySelector('canvas')!.parentElement as HTMLElement;
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 420, clientX: 800, clientY: 300, bubbles: true }));
  }, 1000);
if (q.get('probe'))
  setTimeout(() => {
    document.title = `initial pages=${(window as any).__pages} commits=${useRepo.getState().commits.length} hasMore=${useRepo.getState().hasMore}`;
  }, 2500);
const LONGDIFF = [
  'diff --git a/f b/f',
  '--- a/f',
  '+++ b/f',
  '@@ -1,4 +1,5 @@',
  ' const short = 1;',
  "-const old = 'x';",
  "+const added = '" + 'abcdefghij'.repeat(18) + "';",
  '+const tail = 2;',
  ' const end = 3;',
].join('\n');
if (q.get('diff')) {
  (window as any).gitApi.commitFileDiff = async () => LONGDIFF;
  setTimeout(() => {
    (document.querySelector('[title*="messages.properties"]') as HTMLElement)?.click();
    if (q.get('split')) setTimeout(() => btn('Split')?.click(), 300);
    if (q.get('scrollx'))
      setTimeout(() => {
        const p = document.querySelector('[aria-label="Before"]') as HTMLElement;
        if (p) p.scrollLeft = 300;
      }, 700);
  }, 900);
}

if (q.get('click')) setTimeout(() => btn(q.get('click')!)?.click(), 1200);

if (q.get('hoverref'))
  setTimeout(() => {
    const el = document.querySelector('canvas')!.parentElement as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 60, clientY: r.top + 14, bubbles: true }));
  }, 1000);

if (q.get('conflict'))
  Object.assign((window as any).gitApi, {
    opState: async () => ({
      kind: 'rebase',
      step: '1/3',
      files: ['src/features/card-control/BottomSheetCardControl.tsx', 'docs/playwright-coverage-checklist.md'],
    }),
  });

if (q.get('term'))
  setTimeout(() => {
    btn('Terminal')?.click();
    setTimeout(() => {
      const t = (window as any).gitApi.term;
      'git status'.split('').forEach((c: string) => t.write(1, c));
      t.write(1, '\r');
    }, 600);
  }, 1300);
if (q.get('merge'))
  setTimeout(() => (document.querySelector('[title^="Resolve lib/config"]') as HTMLElement)?.click(), 1300);
if (q.get('pickb'))
  setTimeout(() => (document.querySelector('[aria-label="Use B for conflict 1"]') as HTMLElement)?.click(), 2000);

if (q.get('goto'))
  setTimeout(() => {
    const n = Number(q.get('goto'));
    for (let i = 0; i < n; i++) (document.querySelector('[aria-label="Next conflict"]') as HTMLElement)?.click();
    setTimeout(() => {
      const tops = [...document.querySelectorAll('[data-pane]')].map((e) => Math.round((e as HTMLElement).scrollTop));
      const ta = document.querySelector('textarea[aria-label="Merged output"]') as HTMLTextAreaElement;
      document.title = `focus=${n + 1} paneScroll=${tops.join(',')} outputScroll=${Math.round(ta?.scrollTop ?? -1)}`;
    }, 1500);
  }, 2400);
if (q.get('settings'))
  setTimeout(() => (document.querySelector('[aria-label="Preferences"]') as HTMLElement)?.click(), 1200);

if (q.get('picks'))
  setTimeout(() => {
    for (const l of ['Use A for conflict 1', 'Use B for conflict 1', 'Use B for conflict 2'])
      (document.querySelector(`[aria-label="${l}"]`) as HTMLElement)?.click();
  }, 2300);

// bigger, nested ref set so the sidebar tree has something to show
Object.assign((window as any).gitApi, {
  refs: async () => ({
    local: [
      'develop',
      'main',
      'feature/no-api-local-development',
      'feature/workspace/sp4/dev',
      'feature/workspace/sp5/dev',
      'feature/workspace/sp5/develop',
      'sq17/test',
      'sq17/test2',
      'improvement/analytic',
      'improvement/debug/flagsmith',
    ].map((name) => ({ name, current: name === 'sq17/test2' })),
    remote: [
      'origin/develop',
      'origin/main',
      'origin/release',
      'origin/feature/no-api-local-development',
      'origin/feature/DEMO-17375',
      'origin/feature/sq7/no-api-local-development',
      'origin/sq1/chore/appinapp',
      'origin/sq1/DEMO-4671/sample-library',
      'upstream/main',
    ].map((name) => ({ name })),
    tags: ['v1.0.0', 'v1.1.0', 'release/2026.10', 'release/2026.11'].map((name) => ({ name })),
    stashes: [{ id: 'stash@{0}', message: 'WIP on sq17/test2: 78fd4b6 test' }],
  }),
});
if (q.get('tree'))
  setTimeout(() => {
    const click = (t: string) =>
      (
        [...document.querySelectorAll('[role="treeitem"],button')].find((b) => b.textContent?.trim().startsWith(t)) as
          HTMLElement | undefined
      )?.click();
    click('Remote');
    setTimeout(() => {
      click('origin');
      click('sq1');
    }, 150);
  }, 1300);
if (q.get('fail'))
  (window as any).gitApi[q.get('fail')!] = async () => {
    throw new Error(
      "Error invoking remote method 'git:" +
        q.get('fail') +
        "': Error: error: Your local changes to the following files would be overwritten by merge:\n\tlib/config/mini_app_config.dart\n\tlib/src/webview/web_view_stack.dart\nPlease commit your changes or stash them before you merge.\nAborting",
    );
  };
if (q.get('open'))
  setTimeout(
    () => (document.querySelector('[role="alert"] button[aria-expanded="false"]') as HTMLElement)?.click(),
    2200,
  );

if (q.get('hoverrow'))
  setTimeout(() => {
    const el = document.querySelector('canvas')!.parentElement as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: r.left + 60,
        clientY: r.top + 28 * Number(q.get('hoverrow')) + 14,
        bubbles: true,
      }),
    );
  }, 1100);

// scripted AI: loop providers (claude/openai) return tool calls; copilot runs tools itself through the bridge
const aiMock = () => {
  let onDelta: any = null;
  let onCall: any = null;
  const turns: Record<string, number> = {};
  (window as any).__sent = [];
  (window as any).__bridge = [];
  const api: any = (window as any).gitApi;
  api.ai = {
    status: async () => ({
      claude: { model: 'claude-opus-5-5', storedKey: true, envKey: false, canEncrypt: true },
      openai: {
        signedIn: true,
        account: 'me@example.com',
        planUsage: true,
        hasApiKey: false,
        signingIn: false,
        canEncrypt: true,
      },
    }),
    copilotStatus: async () => ({
      available: true,
      authenticated: false,
      login: null,
      authType: null,
      message: 'Not authenticated',
      hasToken: false,
      canEncrypt: true,
    }),
    models: async (p: string) => ({
      ok: true,
      value: p === 'openai' ? ['gpt-a', 'gpt-b'] : ['gpt-5', 'claude-sonnet-4.5'],
    }),
    setKey: async () => ({ ok: true }),
    openaiSignIn: async () => ({ ok: true, value: { account: 'me@example.com', planUsage: true } }),
    openaiCancel: async () => {},
    openaiSignOut: async () => {},
    reset: async () => {},
    abort: async () => {},
    onDelta: (cb: any) => {
      onDelta = cb;
      return () => {};
    },
    onToolCall: (cb: any) => {
      onCall = cb;
      return () => {};
    },
    toolResult: async (id: string, r: any) => {
      (window as any).__bridge.push({ id, ...r });
    },
    turn: async (req: any) => {
      (window as any).__sent.push(JSON.parse(JSON.stringify(req)));
      const n = (turns[req.provider] = (turns[req.provider] ?? 0) + 1);
      const say = (t: string) =>
        t.split(' ').forEach((w, i) => setTimeout(() => onDelta?.(req.reqId, (i ? ' ' : '') + w), 15 * i));
      await new Promise((r) => setTimeout(r, 150));
      if (req.provider === 'copilot') {
        say('ขอเช็กสถานะก่อนนะครับ');
        await new Promise((r) => setTimeout(r, 400));
        await onCall({ reqId: req.reqId, callId: 'c1', name: 'get_repo_status', input: {} });
        say('ไม่มีไฟล์ค้าง จะ push ให้ครับ');
        await new Promise((r) => setTimeout(r, 400));
        await onCall({ reqId: req.reqId, callId: 'c2', name: 'push', input: {} });
        say('Push เรียบร้อยแล้วครับ ✅');
        await new Promise((r) => setTimeout(r, 400));
        return { ok: true, text: '', calls: [], stop: 'end' };
      }
      if (n === 1) {
        say('ขอเช็กสถานะ repo ก่อนนะครับ');
        return {
          ok: true,
          text: 'ขอเช็กสถานะ repo ก่อนนะครับ',
          calls: [{ id: 'tu1', name: 'get_repo_status', input: {} }],
          native: req.provider === 'claude' ? [{ type: 'thinking', thinking: '', signature: 's' }] : undefined,
          stop: 'tool',
        };
      }
      if (n === 2) {
        say('จะ push ขึ้น origin ครับ');
        return {
          ok: true,
          text: 'จะ push ขึ้น origin ครับ',
          calls: [{ id: 'tu2', name: 'push', input: {} }],
          stop: 'tool',
        };
      }
      say('Push เรียบร้อยแล้วครับ ✅');
      return { ok: true, text: 'Push เรียบร้อยแล้วครับ ✅', calls: [], stop: 'end' };
    },
    resolveConflict: async (_p: string, _m: any, prompt: string, count: number) => {
      (window as any).__prompt = prompt;
      await new Promise((r) => setTimeout(r, 300));
      return {
        ok: true,
        resolutions: Array.from({ length: count }, (_, i) => ({
          index: i,
          resolved: `  static const baseUrl${i + 1} = 'https://gateway.sit';\n  static const timeout${i + 1} = 30;`,
          explanation: "Kept B's SIT URL and its new timeout; A only had the old dev URL.",
        })),
      };
    },
  };
};
if (q.get('ai') || q.get('aimerge') || q.get('aiset')) aiMock();
if (q.get('ai')) {
  const [prov, mode] = String(q.get('ai')).split(':');
  setTimeout(async () => {
    const { useSettings } = await import('../src/store/settingsStore');
    useSettings.getState().set('aiProvider', prov as any);
    btn('Ask AI')?.click();
    const { useAi } = await import('../src/store/aiStore');
    useAi.getState().send('push branch ให้หน่อย');
    if (mode === 'allow') setTimeout(() => useAi.getState().answer(true), prov === 'copilot' ? 1500 : 1300);
    setTimeout(() => {
      const sent = (window as any).__sent as any[];
      const last = sent[sent.length - 1];
      const kinds = (last?.messages ?? [])
        .map((m: any) => m.role + (m.calls?.length ? `+${m.calls.length}call` : '') + (m.native ? '+native' : ''))
        .join(' > ');
      document.title = `provider=${prov} turns=${sent.length} lastProvider=${last?.provider} bridge=${(window as any).__bridge.length} history=[${kinds}]`;
    }, 2500);
  }, 1300);
}
if (q.get('aiset'))
  setTimeout(() => {
    (document.querySelector('[aria-label="Preferences"]') as HTMLElement)?.click();
    setTimeout(() => btn('AI Assistant')?.click(), 200);
  }, 1200);

if (q.get('aimerge')) {
  setTimeout(() => btn('Auto-resolve with AI')?.click(), 2300);
  setTimeout(() => {
    const p = (window as any).__prompt as string;
    document.title = `regions=${(p.match(/<region index=/g) ?? []).length} hasA=${p.includes('<A>')} hasB=${p.includes('<B>')} ctx=${p.includes('<context_before>')}`;
  }, 3500);
}

// ?aiflow=1 : a rebase stopped on two conflicted files; the scripted AI resolves them through the app's real tool runner
if (q.get('aiflow')) {
  const api: any = (window as any).gitApi;
  const files: Record<string, string> = {
    'lib/a.dart': [
      'class A {',
      '<<<<<<< HEAD',
      '  final url = "dev";',
      '=======',
      '  final url = "sit";',
      '  final t = 30;',
      '>>>>>>> abc (test)',
      '  void run() {}',
      '<<<<<<< HEAD',
      '  int x = 1;',
      '=======',
      '  int x = 2;',
      '>>>>>>> abc (test)',
      '}',
    ].join('\n'),
    'lib/b.dart': [
      'void b() {',
      '<<<<<<< HEAD',
      '  print("old");',
      '=======',
      '  print("new");',
      '>>>>>>> abc (test)',
      '}',
    ].join('\n'),
  };
  const st: any = { files: Object.keys(files), resolved: [] as any[], on: true };
  (window as any).__fs = {};
  (window as any).__log = [];
  Object.assign(api, {
    opState: async () =>
      st.on
        ? {
            kind: 'rebase',
            step: '1/1',
            head: 'sq17/test',
            onto: '78fd4b6',
            message: 'test',
            files: st.files,
            resolved: st.resolved,
          }
        : null,
    readWorkFile: async (_c: string, p: string) =>
      (files as any)[p] ??
      (() => {
        throw new Error('ENOENT');
      })(),
    writeWorkFile: async (_c: string, p: string, t: string) => {
      (window as any).__fs[p] = t;
    },
    resolveFile: async (_c: string, p: string) => {
      st.files = st.files.filter((f: string) => f !== p);
      st.resolved.push({ status: 'M', path: p });
    },
    opContinue: async () => {
      if (st.files.length) throw new Error('unmerged files');
      st.on = false;
    },
  });
  const calls = (...c: [string, string, any][]) => c.map(([id, name, input]) => ({ id, name, input }));
  const script = [
    { text: 'ชน conflict ครับ ขอดูรายละเอียดก่อน', calls: calls(['t1', 'get_conflicts', {}]) },
    {
      text: 'อ่านทั้งสองไฟล์',
      calls: calls(
        ['t2', 'get_conflict_file', { path: 'lib/a.dart' }],
        ['t3', 'get_conflict_file', { path: 'lib/b.dart' }],
      ),
    },
    // first attempt forgets region 1 -> must be refused and nothing written
    {
      text: 'แก้ a.dart',
      calls: calls([
        't4',
        'resolve_conflict_file',
        {
          path: 'lib/a.dart',
          resolutions: [
            { index: 0, resolved: '  final url = "sit";\n  final t = 30;', explanation: 'ใช้ URL ของ SIT ตามฝั่ง B' },
          ],
        },
      ]),
    },
    {
      text: 'ขาด region 2 แก้ใหม่',
      calls: calls(
        [
          't5',
          'resolve_conflict_file',
          {
            path: 'lib/a.dart',
            resolutions: [
              { index: 0, resolved: '  final url = "sit";\n  final t = 30;', explanation: 'ใช้ URL ของ SIT ตามฝั่ง B' },
              { index: 1, resolved: '  int x = 2;', explanation: 'x = 2 มาจาก commit ของคุณ' },
            ],
          },
        ],
        [
          't6',
          'resolve_conflict_file',
          {
            path: 'lib/b.dart',
            resolutions: [{ index: 0, resolved: '  print("new");', explanation: 'ข้อความใหม่แทนข้อความเก่า' }],
          },
        ],
      ),
    },
    { text: 'ครบแล้ว ไปต่อ', calls: calls(['t7', 'continue_operation', {}]) },
    { text: 'Rebase เสร็จเรียบร้อยแล้วครับ', calls: [] },
  ];
  let k = 0;
  api.ai.turn = async (req: any) => {
    (window as any).__sent.push(JSON.parse(JSON.stringify(req)));
    const step = script[k++];
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, text: step.text, calls: step.calls, stop: step.calls.length ? 'tool' : 'end' };
  };
  setTimeout(() => useRepo.getState().refresh(), 600); // pick up the fake stopped rebase
  if (!q.get('noanswer'))
    setInterval(async () => {
      const { useAi } = await import('../src/store/aiStore');
      if (useAi.getState().confirm) useAi.getState().answer(true);
    }, 120);
  setTimeout(async () => {
    const { useAi } = await import('../src/store/aiStore');
    const { useSettings } = await import('../src/store/settingsStore');
    useSettings.getState().set('aiProvider', 'claude');
    useAi.getState().send('rebase แล้วแก้ conflict ให้หน่อย');
    setTimeout(() => {
      try {
        const sent = (window as any).__sent as any[];
        const results: Record<string, string> = {};
        for (const m of sent[sent.length - 1].messages)
          if (m.role === 'tool') for (const r of m.results) results[r.id] = (r.isError ? 'ERR:' : '') + r.text;
        (window as any).__results = results;
        const fs = (window as any).__fs;
        document.title = JSON.stringify({
          turns: sent.length,
          t1_hasMeaning: results.t1.includes('A_means') && results.t1.includes('lib/a.dart'),
          t2_regions: JSON.parse(results.t2).region_count,
          t2_hasB: results.t2.includes('sit'),
          t4_refused: results.t4.startsWith('ERR:') && results.t4.includes('Missing resolutions for region(s) 1'),
          t4_nothingWritten: Object.keys(fs).length === 2 ? 'written-by-t5/t6' : 'none',
          a_dart: fs['lib/a.dart'],
          b_dart: fs['lib/b.dart'],
          t7: results.t7,
          opCleared: JSON.stringify(st.on),
        });
      } catch (e: any) {
        document.title = 'TEST-ERROR ' + e.message;
      }
    }, 3500);
  }, 1300);
}

// ?aiflow2=release|feature|dirty : drive flow_start / flow_finish through the real tool runner and record the git calls it makes
if (q.get('aiflow2')) {
  const mode = String(q.get('aiflow2'));
  const api: any = (window as any).gitApi;
  const local = new Set(['develop', 'main', mode === 'release' ? 'release/1.2.0' : 'feature/login']);
  let cur = mode === 'release' ? 'release/1.2.0' : 'feature/login';
  const calls: string[] = [];
  const rec = (n: string, ...a: any[]) => {
    calls.push(`${n}(${a.join(',')})`);
  };
  Object.assign(api, {
    refs: async () => ({
      local: [...local].map((name) => ({ name, current: name === cur })),
      remote: [],
      tags: [],
      stashes: [],
    }),
    status: async () => (mode === 'dirty' ? [{ index: ' ', worktree: 'M', path: 'x.txt' }] : []),
    checkout: async (_c: string, ref: string) => {
      rec('checkout', ref);
      cur = ref;
    },
    checkoutRemote: async (_c: string, ref: string) => {
      rec('checkoutRemote', ref);
      cur = ref.split('/').slice(1).join('/');
    },
    merge: async (_c: string, ref: string, noff: boolean) => {
      rec('merge', ref, noff);
    },
    createAnnotatedTag: async (_c: string, n: string, h: string, m: string) => {
      rec('tag', n, h, m);
    },
    deleteBranch: async (_c: string, n: string) => {
      rec('delete', n);
      local.delete(n);
    },
    branchAt: async (_c: string, n: string, from: string) => {
      rec('branchAt', n, from);
      local.add(n);
      cur = n;
    },
  });
  const script =
    mode === 'release'
      ? [
          { text: 'จบ release', calls: [{ id: 'f1', name: 'flow_finish', input: { tag_message: 'Release 1.2.0' } }] },
          { text: 'เสร็จ', calls: [] },
        ]
      : mode === 'dirty'
        ? [
            { text: 'จบ feature', calls: [{ id: 'f1', name: 'flow_finish', input: {} }] },
            { text: 'เสร็จ', calls: [] },
          ]
        : [
            { text: 'จบ feature', calls: [{ id: 'f1', name: 'flow_finish', input: {} }] },
            {
              text: 'เริ่มใหม่',
              calls: [
                { id: 'f2', name: 'flow_start', input: { type: 'feature', name: 'DEMO 123 pay' } },
                { id: 'f3', name: 'flow_start', input: { type: 'hotfix', name: '1.2.1' } },
              ],
            },
            { text: 'เสร็จ', calls: [] },
          ];
  let k = 0;
  api.ai.turn = async (req: any) => {
    (window as any).__sent.push(JSON.parse(JSON.stringify(req)));
    const st = script[k++];
    await new Promise((r) => setTimeout(r, 100));
    return { ok: true, text: st.text, calls: st.calls, stop: st.calls.length ? 'tool' : 'end' };
  };
  setTimeout(() => useRepo.getState().refresh(), 600);
  setInterval(async () => {
    const { useAi } = await import('../src/store/aiStore');
    if (useAi.getState().confirm) useAi.getState().answer(true);
  }, 100);
  setTimeout(async () => {
    const { useAi } = await import('../src/store/aiStore');
    useAi.getState().send('go');
    setTimeout(() => {
      const sent = (window as any).__sent as any[];
      const res: string[] = [];
      for (const m of sent[sent.length - 1].messages)
        if (m.role === 'tool') for (const r of m.results) res.push((r.isError ? 'ERR:' : 'OK:') + r.text.slice(0, 200));
      document.title = JSON.stringify({ calls, results: res });
    }, 3000);
  }, 1300);
}
