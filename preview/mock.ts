// Browser-only mock of window.gitApi so the UI can be previewed without Electron.
const authors = ['Alex Example', 'Sam Example', 'Jane Doe'];
const commits: any[] = [];
const H = (i: number) => (i.toString(16).padStart(4, '0') + 'abcdef0123456789abcdef0123456789abcd').slice(0, 40);
const N = Number(new URLSearchParams(location.search).get('n') ?? 60);
for (let i = 0; i < N; i++) {
  const merge = i % 3 === 0 && i < N - 6;
  commits.push({
    hash: H(i),
    parents: merge ? [H(i + 1), H(i + 2)] : i === N - 1 ? [] : [H(i + (i % 3 === 1 ? 2 : 1))],
    refs:
      i === 3
        ? [{ name: 'origin/feature/DEMO-19944-DEMO-19936-implement-introduction-page-with-long-name', kind: 'remote' }]
        : i === 0
          ? [
              { name: 'feature/workspace/DEMO-18562', kind: 'local', current: true },
              { name: 'origin/dev', kind: 'remote' },
              { name: 'origin/feature/workspace/DEMO-18562', kind: 'remote' },
              { name: 'develop', kind: 'local' },
              { name: 'v1.2.0', kind: 'tag' },
            ]
          : i === 9
            ? [{ name: '1.0.0-sit-cycle-2', kind: 'tag' }]
            : [],
    author: authors[i % 3],
    email: 'a@b.c',
    date: new Date(Date.now() - i * 3600e3 * 9).toISOString(),
    body: merge ? `[DEMO-${17000 + i + 1}] Add masked HTTP request logging` : undefined,
    subject:
      (new URLSearchParams(location.search).get('long') ? 'LONG ' + 'very long commit subject text '.repeat(7) : '') +
      (merge ? `Merge branch 'demo/feature-${i}' into 'dev'` : `[DEMO-${17000 + i}] Update newman config for env ${i}`),
  });
}
const DIFF = [
  'diff --git a/f b/f',
  '--- a/f',
  '+++ b/f',
  '@@ -111,6 +111,12 @@ describe',
  " await page.getByTestId('keypad-done').click();",
  ' await expect(keypad).toBeHidden();',
  ' });',
  '+',
  "+test('keypad stays open', async ({ page }) => {",
  '+  const LONG = "' + 'abcdefghij'.repeat(20) + '";',
  "+  await page.goto('/landing');",
  "+  await expect(input).toHaveAttribute('inputmode', 'none');",
  '+});',
  '-for (const h of [600]) {',
  '+for (const h of [600, 667]) {',
  "   test('small viewport', async () => {",
].join('\n');
let localChanges = new URLSearchParams(location.search).has('changes')
  ? [
      { path: 'src/app.ts', index: ' ', worktree: 'M' },
      { path: 'docs/readme.md', index: '?', worktree: '?' },
    ]
  : [];
(window as any).gitApi = {
  opState: async () => null,
  commitFileDiff: async () => DIFF,
  fileAt: async () => 'const a = 1;\n// hello\n',
  openRepoDialog: async () => '/Users/me/projects/demo-project',
  log: async (_c: string, limit = 400, skip = 0) => {
    await new Promise((r) => setTimeout(r, 300));
    (window as any).__pages = ((window as any).__pages ?? 0) + 1;
    return commits.slice(skip, skip + limit);
  },
  status: async () => localChanges.map((f) => ({ ...f })),
  stage: async (_repo: string, paths: string[]) => {
    localChanges = localChanges.map((f) =>
      paths.includes(f.path) ? { ...f, index: f.index === '?' ? 'A' : f.worktree, worktree: ' ' } : f,
    );
  },
  unstage: async (_repo: string, paths: string[]) => {
    localChanges = localChanges.map((f) =>
      paths.includes(f.path)
        ? f.index === 'A'
          ? { ...f, index: '?', worktree: '?' }
          : { ...f, index: ' ', worktree: f.index }
        : f,
    );
  },
  commit: async () => {
    localChanges = localChanges.filter((f) => f.index === ' ' || f.index === '?');
  },
  refs: async () => ({
    headHash: H(0),
    local: [
      { name: 'dev', current: false, hash: H(9) },
      { name: 'feature/workspace/DEMO-18562', current: true, hash: H(0) },
      { name: 'feature/x', current: false, hash: H(3) },
      { name: 'release/1.0', current: false, hash: H(20) },
    ],
    remote: [
      { name: 'origin/dev', hash: H(9) },
      { name: 'origin/main', hash: H(10) },
    ],
    tags: [{ name: '1.0.0-sit-cycle-2' }, { name: '1.0.0' }],
    stashes: [],
  }),
  historyPosition: async (_repo: string, hash: string) => {
    const i = commits.findIndex((c) => c.hash === hash);
    if (i < 0) throw new Error('Commit not found');
    return i;
  },
  commitDetail: async () => ({
    body: '[DEMO-18562] [Demo UI]: Change wording from writer\n\nUpdate messages for demo UI screens.',
    files: [
      { status: 'M', path: 'src/main/resources/messages.properties' },
      { status: 'M', path: 'src/test/java/net/example/MessageSourceConfigTest.java' },
      { status: 'A', path: 'docs/readme.md' },
    ],
  }),
  commitFileDiff: async (_repo: string, _hash: string, path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-Old message\n+Updated message\n`,
  workingFileDiff: async () => DIFF,
  pushInfo: async () => ({
    branch: 'feature/workspace/DEMO-18562',
    remotes: ['origin'],
    remote: 'origin',
    target: 'feature/workspace/DEMO-18562',
  }),
  commitIdentity: async () => ({ name: 'Example User', email: 'user@example.com' }),
  setCommitIdentity: async () => {},
  setActiveIdentity: async () => {},
  pushProfiles: {
    tokenStatus: async () => false,
    setToken: async () => {},
    chooseKey: async () => null,
    push: async () => {},
  },
};
