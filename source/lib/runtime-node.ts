import {nodeEnv} from '../server/storage.mjs';
export const env = nodeEnv as unknown as Cloudflare.Env;
export const selfHosted = true;
export const tenantId = 'falcon-selfhosted';
export const appOrigin = process.env.FALCON_ORIGIN || '';
