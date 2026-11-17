export function reorderRepoTabs(repos: string[], groups: Record<string, string>, source: string, target: string) {
  const members = (repo: string) => (groups[repo] ? repos.filter((path) => groups[path] === groups[repo]) : [repo]);
  const moving = members(source);
  if (moving.includes(target)) return repos;
  const remaining = repos.filter((repo) => !moving.includes(repo));
  const targetMembers = members(target);
  const index = remaining.findIndex((repo) => targetMembers.includes(repo));
  if (index < 0) return repos;
  const after = repos.indexOf(source) < repos.indexOf(target);
  const insertAt = after
    ? remaining.length - [...remaining].reverse().findIndex((repo) => targetMembers.includes(repo))
    : index;
  remaining.splice(insertAt, 0, ...moving);
  return remaining;
}
