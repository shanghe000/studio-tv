import {resolveFeatures,type Edition,type Features} from './features/policy';
export type RuntimeMode='preview'|'service';
declare const __RHTV_BUILD_MODE__: RuntimeMode;
const runtime=globalThis.window?.__RHTV_RUNTIME_CONFIG__;
if(runtime&&(!['preview','service'].includes(runtime.mode)||runtime.apiBase!=='/api/v1'||runtime.catalogMode!=='sample-snapshot'||runtime.edition!==undefined&&!['internal','external'].includes(runtime.edition)))throw new Error('Invalid public runtime configuration');
const edition=(runtime?.edition||'internal') as Edition;
export const config=Object.freeze({
 mode:(runtime?.mode||__RHTV_BUILD_MODE__) as RuntimeMode,
 apiBase:'/api/v1',
 catalogSource:'sample-snapshot' as const,
 edition,
 features:resolveFeatures(edition,runtime?.features) as Features,
});
