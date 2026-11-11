import {ApiError} from '../api/client';
import {canvasRequestDeadline} from './canvas-request-deadline';
import {historyVideoPosterURL} from './video-history-display';

export interface HistoryVideoGrantPort {
 scope:()=>string|null;
 cached:(assetId:string)=>any;
 resolve:(assetId:string,signal:AbortSignal)=>Promise<any>;
 subscribe?:(fn:()=>void)=>()=>void;
}
interface Grant {
 id:string;url:string;expires:number;due:number;attempts:number;lastAttempt:number;
 error?:'access'|'temporary';pending?:AbortController;expiredNotified:boolean;
}
interface Owner {epoch:number;ids:Set<string>}
const lead=50000,backoff=[5000,15000];
function assetId(value:unknown,origin:string){
 if(typeof value!=='string')return;
 try{const url=new URL(value,origin);if(url.origin!==origin)return;
  const match=/^\/storage\/assets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(url.pathname);
  return match&&url.searchParams.get('token')?match[1]:undefined;
 }catch{return;}
}
const source=(row:any)=>row.resultUrl||row.url;

/** A display-only, identity-scoped grant table. Metadata, not a decoded token,
 * supplies the expiry. Only mounted history/preview owners keep entries alive. */
export class HistoryVideoGrants {
 private scope:string|null;
 private epoch=0;
 private version=0;
 private disposed=false;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private readers=0;
 private entries=new Map<string,Grant>();
 private deniedMetadata=new WeakSet<object>();
 private owners=new Map<object,Owner>();
 private listeners=new Set<()=>void>();
 constructor(private port:HistoryVideoGrantPort,private origin:string){this.scope=port.scope();}
 session=()=>this.epoch;
 snapshot=()=>this.version;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
 current=(epoch:number)=>!this.disposed&&epoch===this.epoch&&!!this.scope&&this.scope===this.port.scope();
 private emit(){this.version++;for(const listener of [...this.listeners])listener();}
 private metadata(id:string,asset:any){
  const url=asset?.downloadUrl||asset?.previewUrl,expires=Date.parse(asset?.urlsExpireAt??'');
  if(asset?.id!==id||asset?.state!=='READY'||asset?.kind!=='VIDEO'||!String(asset?.mimeType).startsWith('video/')||assetId(url,this.origin)!==id||!Number.isFinite(expires)||expires<=Date.now())throw new ApiError(502,'INVALID_VIDEO_GRANT','视频链接暂时无法更新。');
  return{url,expires};
 }
 private cachedMetadata(id:string){const asset=this.port.cached(id);if(asset&&typeof asset==='object'&&this.deniedMetadata.has(asset))throw new ApiError(403,'ASSET_ACCESS_DENIED','素材访问权限已变更。');return this.metadata(id,asset);}
 watch(owner:object,rows:readonly any[],epoch:number){
  if(!this.current(epoch)){this.remove(owner);return;}
  const ids=new Set(rows.map(row=>assetId(source(row),this.origin)).filter((id):id is string=>!!id));
  this.owners.set(owner,{epoch,ids});let changed=false;
  for(const id of ids)if(!this.entries.has(id)){
   let grant:{url:string;expires:number}|undefined;try{grant=this.cachedMetadata(id);}catch{}
   this.entries.set(id,{id,url:grant?.url??'',expires:grant?.expires??0,due:grant?grant.expires-lead:0,attempts:0,lastAttempt:0,expiredNotified:false});changed=true;
  }
  this.prune();if(changed)this.emit();this.pump();
 }
 remove(owner:object){this.owners.delete(owner);this.prune();this.schedule();}
 private prune(){const ids=new Set([...this.owners.values()].flatMap(owner=>[...owner.ids]));for(const [id,entry] of this.entries)if(!ids.has(id)){entry.pending?.abort();this.entries.delete(id);}}
 project(rows:readonly any[],epoch:number,preview=false){
  return rows.map(row=>{
   const id=assetId(source(row),this.origin);if(!id)return row;
   const entry=this.entries.get(id);let url='';
   if(this.current(epoch)){if(entry){if(entry.error!=='access'&&entry.expires>Date.now())url=entry.url;}else try{url=this.cachedMetadata(id).url;}catch{}}
   if(preview){const thumbnailUrl=url?historyVideoPosterURL(url,'preview'):undefined;return row.url===url&&row.thumbnailUrl===thumbnailUrl?row:{...row,url,thumbnailUrl};}
   return row.url===url&&row.resultUrl===url?row:{...row,url,resultUrl:url};
  });
 }
 message(owner:object,epoch:number){
  if(!this.current(epoch))return'登录状态已变更，请重新打开历史。';
  const entries=[...(this.owners.get(owner)?.ids??[])].map(id=>this.entries.get(id)).filter((entry):entry is Grant=>!!entry);
  if(entries.some(entry=>entry.error==='access'))return'部分视频已删除或无权访问，请重试确认。';
  if(entries.some(entry=>entry.error==='temporary'))return'部分视频链接更新失败，请重试。';
  if(entries.some(entry=>!entry.url||entry.expires<=Date.now()))return'正在更新视频链接…';
  return'';
 }
 retry(owner:object,epoch:number){
  if(!this.current(epoch))return;
  for(const id of this.owners.get(owner)?.ids??[]){const entry=this.entries.get(id);if(entry&&!entry.pending&&Date.now()-entry.lastAttempt>=1000){entry.attempts=0;entry.due=0;}}
  this.pump();
 }
 wake=()=>{
  if(this.scope!==this.port.scope()){this.reset();return;}
  for(const entry of this.entries.values())if(entry.error==='temporary'&&Date.now()-entry.lastAttempt>=10000){entry.attempts=0;entry.due=0;}
  this.pump();
 };
 reset=()=>{
  this.epoch++;this.scope=this.port.scope();clearTimeout(this.timer);this.timer=undefined;
  for(const entry of this.entries.values())entry.pending?.abort();this.entries.clear();this.owners.clear();this.emit();
 };
 dispose(){if(this.disposed)return;this.disposed=true;this.reset();this.listeners.clear();}
 private schedule(){
  clearTimeout(this.timer);this.timer=undefined;if(this.disposed||!this.entries.size)return;
  const times=[...this.entries.values()].flatMap(entry=>[...(!entry.expiredNotified&&entry.expires>0?[entry.expires]:[]),...(!entry.pending&&this.readers<4?[entry.due]:[])]).filter(Number.isFinite);
  if(times.length)this.timer=setTimeout(()=>this.pump(),Math.max(250,Math.min(...times)-Date.now()));
 }
 private pump(){
  if(this.disposed)return;if(this.scope!==this.port.scope()){this.reset();return;}
  let expired=false;for(const entry of this.entries.values())if(entry.expires<=Date.now()&&!entry.expiredNotified){entry.expiredNotified=true;expired=true;}
  if(expired)this.emit();
  for(const entry of this.entries.values())if(this.readers<4&&!entry.pending&&entry.due<=Date.now())void this.read(entry);
  this.schedule();
 }
 private async read(entry:Grant){
  const epoch=this.epoch,controller=new AbortController();entry.pending=controller;entry.lastAttempt=Date.now();entry.due=Infinity;this.readers++;
  const current=()=>this.current(epoch)&&this.entries.get(entry.id)===entry&&!controller.signal.aborted;
  try{
   const asset=await canvasRequestDeadline(controller.signal,signal=>this.port.resolve(entry.id,signal));if(!current())return;
   const grant=this.metadata(entry.id,asset);entry.url=grant.url;entry.expires=grant.expires;entry.due=Math.max(Date.now()+1000,grant.expires-lead);entry.attempts=0;entry.error=undefined;entry.expiredNotified=false;
  }catch(error){
   if(!current())return;entry.attempts++;
   if(error instanceof ApiError&&[401,403,404].includes(error.status)){const cached=this.port.cached(entry.id);if(cached&&typeof cached==='object')this.deniedMetadata.add(cached);entry.error='access';entry.url='';entry.expires=0;entry.due=Infinity;}
   else{entry.error='temporary';entry.due=entry.attempts<=backoff.length?Date.now()+backoff[entry.attempts-1]:Infinity;}
  }finally{
   this.readers--;if(this.entries.get(entry.id)===entry&&entry.pending===controller)entry.pending=undefined;
   if(current())this.emit();this.pump();
  }
 }
}

function nativeHistoryRender(native:any){
 const type=native?.dp,render=type?.render;if(typeof render!=='function')return;
 const code=Function.prototype.toString.call(render);
 return code.includes('onToggleDateSelect:')&&code.includes('getItems:()=>g.slice()')&&code.includes('de.map(oer).filter(Boolean)')&&code.includes('[g,y]=d.useState([])')?render:undefined;
}
function validRecords(value:any){return Array.isArray(value)&&value.every(row=>row&&typeof row.id==='string'&&typeof row.resultUrl==='string'&&typeof row.url==='string');}
const previews=new WeakMap<Function,boolean>();
const menus=new WeakMap<Function,boolean>();
function historyPreview(type:any,props:any){
 if(typeof type!=='function'||type.name!=='C4'||props?.kind!=='video'||!Array.isArray(props.items)||!props.items.length||!props.items.every((row:any)=>typeof row?.key==='string'&&row.key.startsWith('canvas-history-video-')))return false;
 let matches=previews.get(type);if(matches===undefined){const code=Function.prototype.toString.call(type);matches=code.includes('rh-history-preview__metadata-field is-generation-spec')&&code.includes('poster:St.thumbnailUrl');previews.set(type,matches);}return matches;
}
function historyMenu(type:any,props:any){
 if(typeof type!=='function'||type.name!=='aS'||props?.kind!=='video'||!props.item?.key?.startsWith('canvas-history-video-')||typeof props.onClose!=='function')return false;
 let matches=menus.get(type);if(matches===undefined){const code=Function.prototype.toString.call(type);matches=code.includes('rh-node-context-menu rh-history-preview__context-menu')&&code.includes('y&&(s(),y(t))');menus.set(type,matches);}return matches;
}

/** Own hooks surround the immutable Jbt render; its records state alone is
 * projected synchronously. It() calls useState with a function initializer
 * before Jbt's useState([]), so only empty-array records candidates count.
 * The original setter and every native hook keep their order. No hook remains
 * patched outside this try/finally scope. */
export function installVideoHistoryGrants(native:any,port:HistoryVideoGrantPort,surface:Window=window,onClear?:(fn:()=>void)=>()=>void){
 const react=native?.r,jsx=native?.j,renderNative=nativeHistoryRender(native);
 if(!renderNative||typeof react?.forwardRef!=='function'||typeof react?.useSyncExternalStore!=='function'||typeof react?.useLayoutEffect!=='function'||typeof jsx?.jsx!=='function')return()=>{};
 const grants=new HistoryVideoGrants(port,surface.location.origin),render=jsx.jsx,installed:{name:string;original:Function;wrapper:Function}[]=[];let active=true,rowScope:{blocked:Set<string>;selectMode:boolean}|null=null;
 function unavailableChildren(value:any,selectMode:boolean):any{
  if(Array.isArray(value))return value.map(child=>unavailableChildren(child,selectMode));if(!react.isValidElement?.(value))return value;
  // Current Jbt omits media for an empty resultUrl. Also discard an empty host
  // left by another display adapter, so an internal history ID cannot leak as
  // broken-image alt text. This runs only inside a proven unavailable row.
  if((value.type==='img'||value.type==='video')&&!value.props?.src)return null;
  const props:any={};if(value.props?.children!==undefined)props.children=unavailableChildren(value.props.children,selectMode);
  if(value.type==='div'&&value.props?.className?.split(/\s+/).includes('history-item-image'))props.children=[props.children,render('span',{
   'data-studio-history-video-placeholder':'unavailable',role:'img','aria-label':'视频暂不可用',
   style:{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',padding:12,boxSizing:'border-box',color:'var(--studio-ink, #eee9f2)',background:'var(--studio-surface, #232027)',fontSize:14,lineHeight:1.5,textAlign:'center',overflowWrap:'anywhere',pointerEvents:'none'},children:'视频暂不可用',
  })];
  if(value.type==='button'&&!selectMode){props.disabled=true;props['aria-disabled']=true;props.style={...value.props.style,opacity:.5,cursor:'default'};}
  return react.cloneElement(value,props);
 }
 function useOwner(){
  const owner=react.useRef(null);if(!owner.current)owner.current={epoch:grants.session()};
  react.useSyncExternalStore(grants.subscribe,grants.snapshot,grants.snapshot);return owner.current;
 }
 function effects(owner:any,rows:any[],visible:boolean){
  react.useLayoutEffect(()=>{grants.watch(owner,visible?rows:[],owner.epoch);},[owner,rows,visible]);
  react.useLayoutEffect(()=>()=>grants.remove(owner),[owner]);
 }
 function content(tree:any,owner:any,onClose?:()=>void){
  const message=grants.message(owner,owner.epoch);if(!message)return tree;
  const retry=grants.current(owner.epoch)&&!message.startsWith('正在');
  const buttonStyle={padding:'4px 10px',background:'var(--studio-surface, #232027)',border:'1px solid var(--studio-border, #37313f)',borderRadius:6,color:'inherit'};
  return render(react.Fragment,{children:[tree,render('div',{'data-studio-history-video-grants':retry?'error':'updating',style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',padding:'8px 12px',fontSize:14,lineHeight:1.5,color:'var(--studio-ink, #eee9f2)',...(onClose?{position:'fixed',insetInlineEnd:24,insetBlockEnd:24,maxWidth:'min(480px, calc(100vw - 48px))',zIndex:15000,background:'var(--studio-surface, #232027)',border:'1px solid var(--studio-border, #37313f)',borderRadius:8}:{})},children:[render('span',{role:'status',children:message}),retry?render('button',{type:'button',onClick:()=>grants.retry(owner,owner.epoch),style:buttonStyle,children:'重试'}):null,onClose?render('button',{type:'button',onClick:onClose,style:buttonStyle,children:'关闭'}):null]})]});
 }
 const VideoHistory=react.forwardRef(function VideoHistory(props:any,ref:any){
  const owner=useOwner(),original=react.useState,previousScope=rowScope;let recordStates=0,rows:any[]=[],tree:any;
  rowScope={blocked:new Set(),selectMode:props.selectMode===true};
  react.useState=function(initial:any){const pair=original.call(this,initial);if(Array.isArray(initial)&&initial.length===0&&validRecords(pair[0])&&recordStates++===0){rows=pair[0];const projected=grants.project(rows,owner.epoch);rowScope!.blocked=new Set(projected.filter(row=>!row.resultUrl).map(row=>row.id));return[projected,pair[1]];}return pair;};
  try{tree=renderNative(props,ref);}finally{react.useState=original;rowScope=previousScope;}
  effects(owner,rows,props.visible===true&&props.activeTab===props.type);return content(tree,owner);
 });
 const wrappers=new WeakMap<Function,Function>();
 const menuWrappers=new WeakMap<Function,Function>();
 function previewWrapper(type:Function){let component=wrappers.get(type);if(!component){component=function VideoHistoryPreview(props:any){
  const owner=useOwner();effects(owner,props.items,true);const items=grants.project(props.items,owner.epoch,true),selected=items[props.activeIndex]??items[0];
  // C4's internal downloader reports success after an empty URL. Do not mount
  // media/actions until this exact selection is readable; retain its index.
  if(!selected?.url)return content(null,owner,props.onClose);
  const readable=items.filter((item:any)=>!!item.url),index=readable.indexOf(selected);
  return content(render(type,{...props,items:readable,activeIndex:index,onSelect:(next:number)=>props.onSelect?.(items.indexOf(readable[next]))}),owner);
 };wrappers.set(type,component);}return component;}
 function menuWrapper(type:Function){let component=menuWrappers.get(type);if(!component){component=function VideoHistoryMenu(props:any){
  const owner=useOwner(),rows=react.useMemo(()=>[props.item],[props.item]);effects(owner,rows,true);const item=grants.project(rows,owner.epoch,true)[0];
  react.useLayoutEffect(()=>{if(!item.url)props.onClose();},[item.url,props.onClose]);
  return item.url?render(type,{...props,item}):null;
 };menuWrappers.set(type,component);}return component;}
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,type:any,props:any,...args:any[]){if(active){
   if(type==='div'&&rowScope&&rowScope.blocked.has(String(args[0]))&&typeof props?.className==='string'&&props.className.split(/\s+/).includes('history-item'))props={...props,'data-studio-history-video-state':'unavailable',...(!rowScope.selectMode?{'aria-disabled':true,onClick:(event:any)=>{event.preventDefault?.();event.stopPropagation?.();},onMouseEnter:undefined}:{}),children:unavailableChildren(props.children,rowScope.selectMode)};
   if(type===native.dp&&props?.type==='VIDEO')type=VideoHistory;else if(historyPreview(type,props))type=previewWrapper(type);else if(historyMenu(type,props))type=menuWrapper(type);
  }return original.call(this,type,props,...args);};jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 const wake=()=>{if(surface.document.visibilityState!=='hidden')grants.wake();};
 for(const event of ['online','pageshow','focus'])surface.addEventListener(event,wake);surface.document.addEventListener('visibilitychange',wake);
 const clear=onClear?.(grants.reset),session=port.subscribe?.(grants.wake);
 return()=>{if(!active)return;active=false;clear?.();session?.();grants.dispose();for(const event of ['online','pageshow','focus'])surface.removeEventListener(event,wake);surface.document.removeEventListener('visibilitychange',wake);for(const row of installed)if(jsx[row.name]===row.wrapper)jsx[row.name]=row.original;};
}
