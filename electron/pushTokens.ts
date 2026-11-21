import { createHash } from 'node:crypto';

/** Secret-store key of an HTTPS push profile's token (same on the Rust side). */
export const pushTokenKey = (repo: string, id: string) =>
  `push.token.${createHash('sha256')
    .update(JSON.stringify([repo, id]))
    .digest('hex')}`;
