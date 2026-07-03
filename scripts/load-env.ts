// Side-effect module: load .env.local into process.env for CLI scripts.
// Next.js does this automatically for the server; tsx does not. Import this
// FIRST in every script — config's env accessors are lazy, so it only has to
// run before the first env.*() call, not before other module imports.

import { existsSync, readFileSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
