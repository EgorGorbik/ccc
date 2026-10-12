import { readdirSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../server/storage.mjs';

// `pnpm dev` binds an empty Miniflare D1. Wrangler does not apply drizzle/
// on startup, so the first /api/bootstrap dies with "no such table".
export function localD1() {
  return {
    name: 'falcon-local-d1',
    configureServer(server) {
      let ready = false;
      server.middlewares.use((_req, _res, next) => {
        if (ready) return next();
        const file = findLocalD1(server.config.root);
        if (!file) return next();
        try {
          const db = openDatabase(file);
          db.close();
          ready = true;
          next();
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function findLocalD1(root) {
  const dir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  let names;
  try { names = readdirSync(dir); }
  catch { return null; }
  const files = names.filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  return files.length === 1 ? path.join(dir, files[0]) : null;
}
