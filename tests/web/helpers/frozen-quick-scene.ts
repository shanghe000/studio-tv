import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {vi} from 'vitest';
import {nativeQuickSceneAlias} from '../../../apps/web/src/service/image-quick-scenes';
const frozen=readFileSync(new URL('../../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),slice=(start:string,end:string)=>frozen.slice(frozen.indexOf(start),frozen.indexOf(end,frozen.indexOf(start)+start.length));
export function frozenQuickSceneSubmit(resultId:string,submit:(body:any)=>Promise<unknown>){
 const functions=[slice('function GF(','function jd('),slice('function fEt(','function xEr('),slice('function xTe(','const wEr='),slice('async function uEt(','async function o_('),slice('async function LEr(','async function DEr(')].join('\n');return runInNewContext(functions+';LEr',{rn:{IMAGE_IMAGE:'image-image'},_t:{PROMPT:'prompt',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'},_1t:nativeQuickSceneAlias,nv:(row:any,type:string)=>row.config.find((field:any)=>field.type===type)?.paramName,Ie:{warning:vi.fn(),error:vi.fn()},pEt:()=>0,jd:()=>resultId,dEt:()=>({x:10,y:20}),sn:{t:(key:string)=>key},mS:()=>({width:380,height:280}),qp:vi.fn(),$f:vi.fn(),Qye:(node:any)=>structuredClone(node),lEt:(node:any)=>node,cEt:async(canvasId:string,targetId:string,graph:any,name:string)=>{await submit({canvasId,targetType:'NODE',targetId,graph,name});return true;}});
}
