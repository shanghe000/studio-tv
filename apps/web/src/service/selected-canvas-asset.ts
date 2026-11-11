import {ApiError} from '../api/client';
import type {Asset} from '../api/types';

export interface SelectedCanvasAssetPort {
 scope():string|null;
 idOf(reference:string):string|undefined;
 cached(id:string):Asset|undefined;
 resolve(id:string):Promise<Asset>;
}

type Entry={attempt:number;reason:string;asset?:Asset;timer?:ReturnType<typeof setTimeout>};
const checking='正在读取所选图片的尺寸和大小。';

/** Only inputs requested by mounted image toolbars remain candidates for retry. */
export function selectedCanvasAssets(port:SelectedCanvasAssetPort,changed:()=>void){
 let scope:string|null=null;
 const entries=new Map<string,Entry>(),used=new Set<string>();
 const forget=(id:string,entry:Entry)=>{clearTimeout(entry.timer);entries.delete(id);};
 const reset=()=>{for(const [id,entry]of entries)forget(id,entry);used.clear();};
 const read=(ref:string):Asset|string|undefined=>{
  const current=port.scope();
  if(current!==scope){reset();scope=current;}
  const id=port.idOf(ref);
  if(!id)return;
  if(!current)return '正在确认画布访问权限。';
  used.add(id);
  const cached=port.cached(id);if(cached?.state==='READY')return cached;
  const prior=entries.get(id);
  if(prior)return prior.asset??prior.reason;
  const entry:Entry={attempt:0,reason:checking};
  entries.set(id,entry);
  const active=()=>entries.get(id)===entry&&port.scope()===current;
  const load=()=>{
   if(!active())return;
   entry.attempt++;
   void port.resolve(id).then(asset=>{
    if(!active())return;
    entry.asset=asset;changed();
   },error=>{
    if(!active())return;
    const retryable=error instanceof TypeError||error instanceof ApiError&&(error.status>=500||[408,429].includes(error.status)||error.code==='INVALID_RESPONSE');
    if(retryable&&entry.attempt<3){entry.timer=setTimeout(load,500*entry.attempt);return;}
    entry.reason=retryable?'暂时无法读取所选图片，请重新打开工具重试。':'所选图片不可用，请重新选择图片。';
    changed();
   });
  };
  load();return checking;
 };
 return{read,begin:()=>used.clear(),end:()=>{for(const [id,entry]of entries)if(!used.has(id))forget(id,entry);},reset};
}
