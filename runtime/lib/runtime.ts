// Sites runtime. The VPS build replaces this module with runtime-node.ts.
export {env} from 'cloudflare:workers';
export const selfHosted = false;
export const tenantId = '';
export const appOrigin = '';
