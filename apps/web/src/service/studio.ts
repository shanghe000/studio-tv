import {ApiError,type ApiResult,type RequestOptions} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';
import {readModelCatalog,selectedModel,resolveCapability} from './model-catalog';
import {mountStudioPlayer,studioEditTarget,validStudioEditDescriptor,type StudioEditDescriptor,type StudioEditOperation} from './studio-player';

type Scope={signal:AbortSignal;check:()=>void;abort:()=>void;release:()=>void};
type EventRecord={seq:number;event:string;data?:Record<string,unknown>;projectId?:string;path?:string};
type EventPage={records:EventRecord[];hasMore:boolean;terminal?:boolean;status?:string};
type ChatPage={packets:string[];done:boolean};
const json=(data:unknown,status=200,etag?:string|null)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});
const fail=(status:number,code:string,message:string)=>new ApiError(status,code,message);
const invalid=()=>fail(400,'VALIDATION_FAILED','HyperFrames请求字段不符合协议。');
function required(value:unknown):string{if(typeof value!=='string'||!value.trim())throw invalid();return value;}
function decode(value:string):string{try{return required(decodeURIComponent(value));}catch{throw invalid();}}
const segment=(value:string)=>encodeURIComponent(required(value));
function method(actual:string,...allowed:string[]){if(!allowed.includes(actual))throw fail(405,'METHOD_NOT_ALLOWED','请求方法不支持。');}

/** Native HyperFrames protocol projected onto STUDIO's authenticated, persisted workspace. */
export class StudioAdapter {
 private epoch=0;
 private readonly controllers=new Set<AbortController>();
 private readonly versions=new Map<string,string>();
 private readonly trees=new Map<string,string[]>();
 private readonly previews=new Map<HTMLElement,'src'|'href'>();
 private readonly players=new Map<HTMLElement,()=>void>();
 private readonly playerSources=new Map<HTMLElement,string>();
 constructor(readonly api:ProductClient,private readonly beforeMutation?:()=>void){}
 clear(){this.epoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.versions.clear();this.trees.clear();for(const dispose of this.players.values())dispose();this.players.clear();this.playerSources.clear();for(const [element,attribute] of this.previews)element.setAttribute(attribute,'about:blank');this.previews.clear();}
 private scope(signal?:AbortSignal|null):Scope{
  const epoch=this.epoch,controller=new AbortController();
  const abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  this.controllers.add(controller);
  return{signal:controller.signal,abort,check:()=>{if(epoch!==this.epoch)throw fail(401,'SESSION_CHANGED','登录状态已变更，本次HyperFrames操作已取消。');if(controller.signal.aborted)throw new DOMException('操作已取消。','AbortError');},release:()=>{signal?.removeEventListener('abort',abort);this.controllers.delete(controller);}};
 }
 private async request<T>(scope:Scope,path:string,options:RequestOptions={}):Promise<ApiResult<T>>{
  scope.check();if(!['GET','HEAD'].includes((options.method??'GET').toUpperCase()))this.beforeMutation?.();try{const result=await this.api.requestV2<T>(path,{...options,signal:scope.signal});scope.check();return result;}catch(error){scope.check();throw error;}
 }
 private remember(key:string,result:ApiResult<any>){const etag=result.etag||(Number.isInteger(result.data?.revision)&&result.data.revision>0?'"'+result.data.revision+'"':null);if(etag)this.versions.set(key,etag);if(key.startsWith('project:')&&Array.isArray(result.data?.files)&&result.data.files.every((path:any)=>typeof path==='string'))this.trees.set(key.slice('project:'.length),[...result.data.files]);}
 private async project(scope:Scope,id:string){const result=await this.request<any>(scope,'/studio/projects/'+segment(id));this.remember('project:'+id,result);return result;}
 private async version(scope:Scope,id:string,file?:string){const key=file===undefined?'project:'+id:'file:'+id+':'+file;if(!this.versions.has(key)){if(file===undefined)await this.project(scope,id);else{const result=await this.request<any>(scope,'/studio/projects/'+segment(id)+'/files/'+segment(file));this.remember(key,result);}}const value=this.versions.get(key);if(!value)throw fail(502,'VERSION_REQUIRED','HyperFrames服务未返回可验证的版本。');return value;}
 private async mutate(scope:Scope,id:string,suffix:string,body:unknown,verb='POST',file?:string){
  let etag:string;try{let directory=false;if(file!==undefined&&['DELETE','PATCH'].includes(verb)&&!this.versions.has('file:'+id+':'+file)){if(!this.trees.has(id))await this.project(scope,id);directory=!!this.trees.get(id)?.some(path=>path.startsWith(file+'/'));}etag=await this.version(scope,id,directory?undefined:file);}catch(error){if(verb!=='PUT'||!(error instanceof ApiError)||error.status!==404)throw error;etag=await this.version(scope,id);}
  const result=await this.request<any>(scope,'/studio/projects/'+segment(id)+suffix,{method:verb,body,etag,idempotencyKey:verb==='POST'?randomUuid():undefined});
  this.remember('project:'+id,result);const updated=this.versions.get('project:'+id);if(updated)for(const [key,version] of this.versions)if(key.startsWith('file:'+id+':')&&version===etag)this.versions.set(key,updated);if(file!==undefined)this.remember('file:'+id+':'+file,result);return result;
 }
 async handle(path:string,body:any={},verb='GET'):Promise<any|undefined>{
  const scope=this.scope();try{return await this.handleScoped(scope,path,body||{},verb.toUpperCase());}finally{scope.release();}
 }
 private async handleScoped(scope:Scope,path:string,body:any,verb:string):Promise<any|undefined>{
  const url=new URL(path,'http://studio.invalid'),route=url.pathname,b={...Object.fromEntries(url.searchParams),...body};
  if(route==='/canvas/hf/projects'){method(verb,'GET');if(b.type&&b.type!=='HYPER_FRAMES')throw invalid();const projects:any[]=[];for(let page=1;page<=100000;page++){const result=await this.request<any>(scope,'/hf/projects?page='+page+'&size=100'),rows=result.data?.projects||result.data?.records;if(!Array.isArray(rows))throw fail(502,'INVALID_RESPONSE','HyperFrames项目目录响应无效。');projects.push(...rows);if(!result.data.hasNext)return{projects};if(!rows.length)throw fail(502,'INVALID_RESPONSE','HyperFrames项目目录分页无效。');}throw fail(502,'INVALID_RESPONSE','HyperFrames项目目录分页超出范围。');}
  if(route==='/canvas/hf/projects/create'){method(verb,'POST');const result=await this.request<any>(scope,'/hf/projects',{method:'POST',body:{id:required(b.projectId),title:required(b.title)},idempotencyKey:randomUuid()});this.remember('project:'+required(result.data?.id),result);return result.data;}
  if(route==='/canvas/hf/projects/session/list'){method(verb,'GET');const result=await this.request<any>(scope,'/hf/projects/'+segment(required(b.projectId))+'/sessions');if(!Array.isArray(result.data?.records))throw fail(502,'INVALID_RESPONSE','HyperFrames会话目录响应无效。');return result.data;}
  if(route==='/canvas/hf/projects/session/create'){method(verb,'POST');const result=await this.request<any>(scope,'/hf/projects/'+segment(required(b.projectId))+'/sessions',{method:'POST',body:{sessionId:required(b.sessionId)},idempotencyKey:randomUuid()});return result.data;}
  const project=route.match(/^\/canvas\/hf\/projects\/([^/]+)$/);
  if(project){method(verb,'DELETE');const id=decode(project[1]);if(!this.versions.has('project:'+id)){const detail=await this.request<any>(scope,'/hf/projects/'+segment(id));this.remember('project:'+id,detail);}const etag=this.versions.get('project:'+id);if(!etag)throw fail(502,'VERSION_REQUIRED','HyperFrames服务未返回项目版本。');const result=await this.request<any>(scope,'/hf/projects/'+segment(id),{method:'DELETE',etag});for(const key of this.versions.keys())if(key==='project:'+id||key.startsWith('file:'+id+':'))this.versions.delete(key);this.trees.delete(id);return result.data;}
  if(route.startsWith('/canvas/hf/'))throw fail(404,'NOT_FOUND','HyperFrames接口不存在。');
  if(route==='/canvas/openclaw/business/sessions/create'){
   method(verb,'POST');if(b.businessCode!=='HYPER_FRAMES')return undefined;
   const result=await this.request<any>(scope,'/conversations',{method:'POST',body:{kind:'HF',title:''},idempotencyKey:randomUuid()});return required(result.data?.id);
  }
  if(route==='/canvas/openclaw/hf/agents/create'){method(verb,'POST');const result=await this.request<any>(scope,'/hf/conversations/'+segment(required(b.sessionId))+'/agent',{method:'POST',body:{},idempotencyKey:randomUuid()});return required(result.data?.agentId);}
  return undefined;
 }
 async fetch(input:RequestInfo|URL,options:RequestInit={}):Promise<Response|undefined>{
  const request=typeof Request!=='undefined'&&input instanceof Request?input:null,url=new URL(request?.url||String(input),globalThis.location?.origin||'http://localhost'),route=url.pathname,verb=String(options.method||request?.method||'GET').toUpperCase();
  if(!route.startsWith('/studio-api/')&&route!=='/canvas/openclaw/chat')return undefined;
  const scope=this.scope(options.signal||request?.signal);let streaming=false;
  try{
   let body:unknown=options.body;
   if(body===undefined&&request&&!['GET','HEAD'].includes(verb))body=await request.clone().text();scope.check();
   if(route==='/canvas/openclaw/chat'){
    const data=this.objectBody(body);if(data.businessType!=='HYPER_FRAMES')return undefined;method(verb,'POST');
    const sessionId=required(data.sessionId),messages=data.messages;if(!Array.isArray(messages))throw invalid();const latest=[...messages].reverse().find(row=>row?.role==='user');
    const choice=selectedModel(data,'hf'),cap=choice?await resolveCapability(path=>this.request<any>(scope,path),await readModelCatalog(path=>this.request<any>(scope,path)),'LLM',[],choice):undefined;
    const run=await this.request<any>(scope,'/hf/conversations/'+segment(sessionId)+'/runs',{method:'POST',body:{...(cap?{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version}:{}),message:required(latest?.content),agentId:required(data.agentId),...(data.previousResponseId?{previousResponseId:required(data.previousResponseId)}:{})},idempotencyKey:randomUuid()});
    const id=required(run.data?.id);let cursor=0,full='';
    const load=async():Promise<ChatPage>=>{
     const events=(await this.request<any>(scope,'/assistant-runs/'+segment(id)+'/events?after='+cursor)).data;
     if(!Array.isArray(events?.items)||typeof events.terminal!=='boolean'||events.schemaVersion!=='1')throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames持久化对话事件协议不可用。');
     const packets:string[]=[];for(const event of events.items){if(!Number.isSafeInteger(event.sequence)||event.sequence<1||typeof event.type!=='string')throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames对话事件无效。');if(event.sequence<=cursor)continue;if(event.sequence!==cursor+1)throw fail(502,'EVENT_SEQUENCE_GAP','HyperFrames对话事件不连续。');cursor=event.sequence;const kind=event.type.toLowerCase(),value=event.data?.delta??event.data?.text;
      if(['text.delta','text_delta','output.text.delta','response.output_text.delta','chat.delta'].includes(kind)&&typeof value==='string'){full=kind==='chat.delta'||event.data?.snapshot===true?value:full+value;packets.push(this.sse('chat.delta',{text:this.testText(full,run.data?.testMode||event.testMode)},event.sequence));}
     }
     if(events.nextCursor!==null&&events.nextCursor!==undefined&&String(cursor)!==events.nextCursor)throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames对话游标无效。');
     const done=events.terminal&&events.items.length<100;if(done){const task=(await this.request<any>(scope,'/assistant-runs/'+segment(id))).data,state=String(task?.state).toUpperCase();if(state==='SUCCEEDED'){const text=this.outputText(task);packets.push(this.sse('response.created',{response:{id}}),this.sse('chat.final',{text}));}else if(['FAILED','CANCELED','CANCELLED'].includes(state)){packets.push(this.sse('chat.error',{error:task.errorMessage||task.errorCode||(state==='FAILED'?'HyperFrames运行失败。':'HyperFrames运行已取消。')}));}else throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames终态与已保存任务不一致。');packets.push('data: [DONE]\n\n');}return{packets,done};
    };
    // STUDIO accepts only a SUCCEEDED Task ID as previousResponseId. The frozen
    // consumer saves response.created even on failure, so emit it at success.
    const first=await load(),response=this.stream(scope,first,load,value=>value);streaming=true;return response;
   }
   const response=await this.studio(scope,url,verb,body,request,options);streaming=response.streaming;return response.response;
  }catch(error){scope.check();if(error instanceof ApiError)return json({error:{code:error.code,message:error.message}},error.status);throw error;}
  finally{if(!streaming)scope.release();}
 }
 private objectBody(value:unknown):any{if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw invalid();}}if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value;}
 /** Resolve only native navigation to real own preview or persisted output grants. */
 async resolveNavigation(source:string):Promise<string|undefined>{const scope=this.scope();try{return await this.navigation(scope,source);}finally{scope.release();}}
 private navigationURL(value:unknown,origin:string,code:string,message:string){let target:URL;try{if(typeof value!=='string'||!value.trim())throw new Error();target=new URL(value,origin);}catch{throw fail(502,code,message);}if(target.origin!==origin||target.username||target.password||target.hash)throw fail(502,code,message);return target;}
 private async navigation(scope:Scope,source:string,player=false):Promise<string|undefined>{
  const origin=globalThis.location?.origin||'http://localhost',url=new URL(source,origin);if(url.origin!==origin||url.username||url.password||url.hash)return undefined;const preview=url.pathname.match(/^\/studio-api\/projects\/([^/]+)\/preview(?:\/(.*))?$/);
  if(preview){const id=decode(preview[1]),composition=player||!!preview[2]?.startsWith('comp/'),path=decode(preview[2]?.replace(/^comp\//,'')||'index.html'),result=await this.request<any>(scope,'/studio/projects/'+segment(id)+'/preview-session',{method:'POST',body:{path,composition},idempotencyKey:randomUuid()}),target=this.navigationURL(result.data?.url,origin,'UNTRUSTED_PREVIEW_URL','预览服务未返回可信的PF预览地址。'),grant=target.pathname.match(/^\/api\/v2\/studio\/preview\/([^/]+)\/([^/]+)\/(.+)$/);if(!grant||decode(grant[1])!==id||grant[3].split('/').map(decode).join('/')!==path||target.search)throw fail(502,'UNTRUSTED_PREVIEW_URL','预览服务未返回当前作品文件的可信PF预览地址。');scope.check();return target.href;}
  const render=url.pathname.match(/^\/studio-api\/projects\/([^/]+)\/renders\/file\/([^/]+)$/);if(!render)return undefined;
  const projectId=decode(render[1]),filename=decode(render[2]),file=filename.match(/^([^/\\.]+)\.(mp4|webm|mov)$/);if(!file)throw invalid();const taskId=file[1],mimeType={mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'}[file[2]];
  const state=(await this.request<any>(scope,'/studio/renders/'+segment(taskId))).data;if(state?.id!==taskId||state.projectId!==projectId)throw fail(404,'RENDER_NOT_FOUND','渲染文件不属于当前作品。');if(state.status!=='SUCCEEDED')throw fail(409,'RENDER_NOT_READY','渲染文件尚未完成。');if(state.filename!==filename)throw fail(404,'RENDER_NOT_FOUND','渲染文件名与已保存结果不一致。');
  const task=(await this.request<any>(scope,'/tasks/'+segment(taskId))).data;if(task?.id!==taskId||task.kind!=='STUDIO'||task.targetId!==projectId||task.state!=='SUCCEEDED'||!Array.isArray(task.plans))throw fail(502,'INVALID_RENDER_OUTPUT','渲染任务与已保存文件不一致。');
  const outputs=task.plans.flatMap((plan:any)=>Array.isArray(plan.outputs)?plan.outputs:[]).filter((output:any)=>!output.deletedAt&&['ASSET','ARTIFACT'].includes(output.type)&&typeof output.assetId==='string'&&output.assetId&&output.mimeType===mimeType);if(outputs.length!==1)throw fail(501,'RENDER_NAVIGATION_UNAVAILABLE','渲染任务尚未提供唯一的已保存素材。');const assetId=outputs[0].assetId;
  let asset:any;scope.check();try{asset=(await this.api.request<any>('/assets/'+segment(assetId),{signal:scope.signal})).data;scope.check();}catch(error){scope.check();throw error;}
  if(asset?.id!==assetId||asset.state!=='READY'||asset.kind!=='VIDEO'||asset.mimeType!==mimeType||typeof task.projectId!=='string'||asset.projectId!==task.projectId)throw fail(502,'INVALID_RENDER_ASSET','渲染素材状态或归属不一致。');
  const target=this.navigationURL(asset.downloadUrl||asset.previewUrl,origin,'UNTRUSTED_RENDER_URL','渲染素材未返回可信的PF签名地址。');if(target.pathname!=='/storage/assets/'+segment(assetId)||target.searchParams.getAll('token').length!==1||!target.searchParams.get('token')||[...target.searchParams.keys()].some(key=>key!=='token'))throw fail(502,'UNTRUSTED_RENDER_URL','渲染素材未返回可信的PF签名地址。');scope.check();return target.href;
 }
 /** Ordinary iframe/media/anchor navigation cannot attach memory Bearer. */
 async hydratePreview(element:HTMLElement):Promise<boolean>{
  const attribute=element.getAttribute('src')?'src':'href',source=element.getAttribute(attribute);if(!source)return false;const player=attribute==='src'&&element.tagName?.toLowerCase()==='hyperframes-player',scope=this.scope(),epoch=this.epoch;
  try{if(player&&/^\/studio-api\/projects\//.test(new URL(source,globalThis.location?.origin||'http://localhost').pathname)){this.players.get(element)?.();this.players.delete(element);}const target=await this.navigation(scope,source,player);scope.check();if(!target||element.getAttribute(attribute)!==source)return false;element.setAttribute(attribute,target);this.previews.set(element,attribute);if(player){this.playerSources.set(element,source);this.mountPlayer(element,target,epoch);}return true;}finally{scope.release();}
 }
 private mountPlayer(element:HTMLElement,target:string,epoch:number,reselect?:ReturnType<typeof studioEditTarget>){
  const match=new URL(target).pathname.match(/^\/api\/v2\/studio\/preview\/([^/]+)\/[^/]+\/(.+)$/);if(!match)throw invalid();const id=decode(match[1]);
  try{const dispose=mountStudioPlayer(element,target,()=>epoch===this.epoch&&this.previews.get(element)==='src',{
   persist:async(selection,operations)=>{if(epoch!==this.epoch)throw fail(401,'SESSION_CHANGED','登录状态已变更。');return this.editElement(id,selection,operations);},
   refresh:async(selected)=>{const source=this.playerSources.get(element);if(!source||epoch!==this.epoch)throw fail(401,'SESSION_CHANGED','登录状态已变更。');const scope=this.scope();try{const fresh=await this.navigation(scope,source,true);scope.check();if(!fresh)throw fail(502,'INVALID_PREVIEW','Studio预览地址无效。');this.players.get(element)?.();element.setAttribute('src',fresh);this.previews.set(element,'src');this.mountPlayer(element,fresh,epoch,selected);}finally{scope.release();}},reselect});this.players.set(element,dispose);
  }catch{element.setAttribute('src','about:blank');this.previews.delete(element);throw fail(501,'STUDIO_PLAYER_UNAVAILABLE','原生播放器尚未提供可用的隔离预览接口。');}
 }
 async editElement(id:string,selection:StudioEditDescriptor,operations:StudioEditOperation[]){
  if(!validStudioEditDescriptor(selection,selection.sourceFile)||!Array.isArray(operations)||!operations.length||operations.length>64)throw invalid();const scope=this.scope();try{
   const file=await this.request<any>(scope,'/studio/projects/'+segment(id)+'/files/'+segment(selection.sourceFile)),before=this.fileText(file.data);this.remember('file:'+id+':'+selection.sourceFile,file);
   const etag=await this.version(scope,id),result=await this.request<any>(scope,'/studio/projects/'+segment(id)+'/file-mutations/edit/'+segment(selection.sourceFile),{method:'POST',body:{target:studioEditTarget(selection),operations},etag,idempotencyKey:randomUuid()});
   if(result.data?.path!==selection.sourceFile||typeof result.data.content!=='string'||!Number.isInteger(result.data.revision)||result.data.revision<1||!result.etag||result.etag!=='"'+result.data.revision+'"')throw fail(502,'INVALID_EDIT_RESPONSE','Studio编辑服务未返回已保存正文与版本。');this.remember('project:'+id,result);for(const [key,version] of this.versions)if(key.startsWith('file:'+id+':')&&version===etag)this.versions.set(key,result.etag);this.remember('file:'+id+':'+selection.sourceFile,result);return{before,after:result.data.content};
  }catch(error){if(error instanceof ApiError&&error.status===412){this.versions.delete('project:'+id);for(const key of this.versions.keys())if(key.startsWith('file:'+id+':'))this.versions.delete(key);}throw error;}finally{scope.release();}
 }
 private async studio(scope:Scope,url:URL,verb:string,body:unknown,request:Request|null,options:RequestInit):Promise<{response:Response;streaming:boolean}>{
  const route=url.pathname.slice('/studio-api'.length),normal=(response:Response)=>({response,streaming:false});
  if(route==='/events'){
   method(verb,'GET');let cursor=0;const first=await this.eventPage(scope,'/studio/events?after=0');
   return{response:this.stream(scope,first,()=>this.eventPage(scope,'/studio/events?after='+cursor),value=>{const packets:string[]=[];for(const row of value.records){if(row.seq<=cursor)continue;if(row.event!=='file-change'||typeof row.path!=='string'||typeof row.projectId!=='string')throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames文件变更事件协议不可用。');cursor=row.seq;packets.push(this.sse('file-change',{projectId:row.projectId,path:row.path},row.seq));}return{packets,done:false};}),streaming:true};
  }
  const render=route.match(/^\/render\/([^/]+)(\/progress)?$/);
  if(render){
   const id=decode(render[1]),target='/studio/renders/'+segment(id);
   if(render[2]){method(verb,'GET');const first=(await this.request<any>(scope,target)).data;return{response:this.stream(scope,first,async()=>(await this.request<any>(scope,target)).data,value=>{const state=String(value?.status).toUpperCase();if(!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(state)||typeof value.progress!=='number'||value.progress<0||value.progress>100)throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames渲染状态协议不可用。');const done=['SUCCEEDED','FAILED','CANCELLED'].includes(state),status=state==='SUCCEEDED'?'complete':done?'failed':'rendering';return{packets:[this.sse('progress',{progress:value.progress,status,...(value.stage?{stage:value.stage}:{}),...(value.message?{message:value.message}:{}),...(value.error?{error:value.error}:{})})],done};}),streaming:true};}
   method(verb,'DELETE');const state=await this.request<any>(scope,target);this.remember('render:'+id,state);const etag=this.versions.get('render:'+id);if(!etag)throw fail(502,'VERSION_REQUIRED','HyperFrames服务未返回渲染记录版本。');const result=await this.request<any>(scope,target,{method:'DELETE',etag});this.versions.delete('render:'+id);return normal(json(result.data,result.status,result.etag));
  }
  if(['/fonts','/fonts/google','/registry/blocks'].includes(route)){method(verb,'GET','HEAD');const result=await this.request<any>(scope,'/studio'+route);return normal(verb==='HEAD'?new Response(null,{status:result.status}):json(result.data,result.status,result.etag));}
  const match=route.match(/^\/projects\/([^/]+)(.*)$/);if(!match)throw fail(404,'NOT_FOUND','HyperFrames接口不存在。');
  const id=decode(match[1]),suffix=match[2],target='/studio/projects/'+segment(id);
  if(suffix===''){method(verb,'GET','HEAD');const result=await this.project(scope,id);if(!Array.isArray(result.data?.files))throw fail(502,'INVALID_RESPONSE','HyperFrames文件树响应无效。');return normal(verb==='HEAD'?new Response(null,{status:result.status,headers:result.etag?{ETag:result.etag}:{}}):json(result.data,result.status,result.etag));}
  if(/^\/preview(?:\/.*)?$/.test(suffix)){
   method(verb,'GET','HEAD');const path=suffix==='/preview'||suffix==='/preview/'?'index.html':suffix.replace(/^\/preview\/(?:comp\/)?/,'');const result=await this.request<any>(scope,target+'/files/'+segment(decode(path))),bytes=this.fileBytes(result.data);
   const headers=new Headers({'Content-Type':result.data.mimeType||this.mime(path),'Content-Length':String(bytes.byteLength),'Cache-Control':'no-store'});if(result.etag)headers.set('ETag',result.etag);
   return normal(new Response(verb==='HEAD'?null:bytes.buffer as ArrayBuffer,{status:200,headers}));
  }
  if(suffix.startsWith('/renders/file/')){
   method(verb,'GET','HEAD');const response=await this.api.rawV2(target+suffix+url.search,{method:verb,signal:scope.signal});scope.check();return{response:this.guardBytes(scope,response),streaming:!!response.body};
  }
  const file=suffix.match(/^\/files\/(.+)$/);
  if(file){
   method(verb,'GET','HEAD','POST','PUT','DELETE','PATCH');const path=decode(file[1]),fileTarget=target+'/files/'+segment(path),key='file:'+id+':'+path;
   if(verb==='GET'||verb==='HEAD'){const result=await this.request<any>(scope,fileTarget);const content=this.fileText(result.data);this.remember(key,result);return normal(verb==='HEAD'?new Response(null,{status:result.status}):json({...result.data,content},result.status,result.etag));}
   if(verb==='POST'){if(typeof body!=='string')throw invalid();const result=await this.mutate(scope,id,'/files/'+segment(path),{content:body,encoding:'utf8',mimeType:this.mime(path)},verb);this.remember(key,result);return normal(json(result.data,result.status,result.etag));}
   const payload=verb==='PATCH'?{newPath:required(this.objectBody(body).newPath)}:verb==='PUT'?{content:typeof body==='string'?body:(()=>{throw invalid();})(),encoding:'utf8',mimeType:this.mime(path)}:undefined;
   const result=await this.mutate(scope,id,'/files/'+segment(path),payload,verb,path);if(verb==='DELETE'||verb==='PATCH')for(const versionKey of this.versions.keys())if(versionKey===key||versionKey.startsWith(key+'/'))this.versions.delete(versionKey);if(verb==='PATCH')this.remember('file:'+id+':'+payload!.newPath,result);return normal(json(result.data,result.status,result.etag));
  }
  if(suffix==='/upload'){
   method(verb,'POST');this.beforeMutation?.();let form=body;if(!(form instanceof FormData)&&request)form=await request.clone().formData();scope.check();if(!(form instanceof FormData))throw invalid();
   const query=new URLSearchParams();if(url.searchParams.has('dir'))query.set('dir',url.searchParams.get('dir')!);
   const headers=new Headers({'If-Match':await this.version(scope,id),'Idempotency-Key':randomUuid()});const response=await this.api.rawV2(target+'/upload'+(query.size?'?'+query:''),{method:'POST',headers,body:form,signal:scope.signal});scope.check();const envelope=await response.json();scope.check();if(!response.ok||envelope.code!==0)throw fail(response.status,String(envelope.error?.code||envelope.code||'UPLOAD_FAILED'),String(envelope.error?.message||envelope.message||'素材上传失败。'));const result={data:envelope.data,etag:response.headers.get('ETag'),status:response.status};this.remember('project:'+id,result);return normal(json(result.data,result.status,result.etag));
  }
  if(suffix==='/lint'||suffix==='/renders'){method(verb,'GET');const result=await this.request<any>(scope,target+suffix);if(!Array.isArray(result.data?.[suffix==='/lint'?'findings':'renders']))throw fail(502,'INVALID_RESPONSE','HyperFrames目录响应无效。');return normal(json(suffix==='/renders'?this.renderHistory(result.data):result.data,result.status,result.etag));}
  if(suffix==='/render'){
   method(verb,'POST');const result=await this.request<any>(scope,target+suffix,{method:'POST',body:this.renderBody(this.objectBody(body)),etag:await this.version(scope,id),idempotencyKey:randomUuid()}),jobId=required(result.data?.jobId);this.remember('render:'+jobId,result);return normal(json(result.data,result.status,result.etag));
  }
  if(suffix==='/duplicate-file'||suffix==='/registry/install'){
   method(verb,'POST');const data=this.objectBody(body),payload=suffix==='/duplicate-file'?{path:required(data.path)}:{blockName:required(data.blockName)};
   const result=await this.mutate(scope,id,suffix,payload);return normal(json(result.data,result.status,result.etag));
  }
  const mutation=suffix.match(/^\/file-mutations\/remove-element\/(.+)$/);
  if(mutation){method(verb,'POST');const path=decode(mutation[1]),data=this.objectBody(body),target=this.objectBody(data.target);if(!target.id&&!target.selector)throw invalid();const payload={target:{...(target.id?{id:required(target.id)}:{}),...(target.selector?{selector:required(target.selector)}:{}),...(target.selectorIndex!==undefined?{selectorIndex:target.selectorIndex}:{})}};const result=await this.mutate(scope,id,'/file-mutations/remove-element/'+segment(path),payload,'POST',path);if(typeof result.data?.content!=='string')throw fail(502,'INVALID_RESPONSE','HyperFrames变更响应缺少正文。');return normal(json(result.data,result.status,result.etag));}
  throw fail(404,'NOT_FOUND','HyperFrames接口不存在。');
 }
 private renderHistory(data:any){
  // The frozen history loader marks every non-failed row complete/100. Active
  // jobs belong to persisted progress polling and cannot be restored as history.
  const renders:any[]=[];for(const row of data.renders){
   const state=String(row?.status).toUpperCase();
   if(!row||typeof row.id!=='string'||!row.id||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED','CANCELLED'].includes(state)||typeof row.progress!=='number'||row.progress<0||row.progress>100)throw fail(502,'INVALID_RESPONSE','HyperFrames渲染历史响应无效。');
   if(['QUEUED','RUNNING'].includes(state))continue;
   const createdAt=typeof row.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.createdAt)?Date.parse(row.createdAt):NaN;
   if(!Number.isFinite(createdAt))throw fail(502,'INVALID_RESPONSE','HyperFrames渲染记录缺少有效的保存时间。');
   if(state==='SUCCEEDED'&&(typeof row.filename!=='string'||!row.filename))throw fail(502,'INVALID_RESPONSE','HyperFrames渲染记录缺少已保存的文件。');
   renders.push({...row,createdAt,filename:state==='SUCCEEDED'?row.filename:'Export failed',status:state==='SUCCEEDED'?'complete':'failed'});
  }return{...data,renders};
 }
 private renderBody(data:any){if(![24,30,60].includes(data.fps)||!['draft','standard','high'].includes(data.quality)||!['mp4','webm','mov'].includes(data.format)||data.resolution!==undefined&&!['1080p','4k'].includes(data.resolution))throw invalid();return{fps:data.fps,quality:data.quality,format:data.format,...(data.resolution?{resolution:data.resolution}:{}),...(data.composition?{composition:required(data.composition)}:{})};}
 private mime(path:string){const extension=path.split('.').at(-1)?.toLowerCase();return({html:'text/html',htm:'text/html',json:'application/json',js:'text/javascript',mjs:'text/javascript',css:'text/css',md:'text/markdown',txt:'text/plain',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'} as Record<string,string>)[extension||'']||'text/plain';}
 private fileBytes(data:any){if(typeof data?.content!=='string')throw fail(502,'INVALID_RESPONSE','HyperFrames文件响应缺少正文。');if(data.encoding===undefined||data.encoding==='utf8')return new TextEncoder().encode(data.content);if(data.encoding!=='base64')throw fail(502,'INVALID_RESPONSE','HyperFrames文件编码无法识别。');try{return Uint8Array.from(atob(data.content),char=>char.charCodeAt(0));}catch{throw fail(502,'INVALID_RESPONSE','HyperFrames文件内容无法解码。');}}
 private fileText(data:any){if(data.encoding===undefined||data.encoding==='utf8'){if(typeof data?.content!=='string')throw fail(502,'INVALID_RESPONSE','HyperFrames文件响应缺少正文。');return data.content;}try{return new TextDecoder('utf-8',{fatal:true}).decode(this.fileBytes(data));}catch(error){if(error instanceof ApiError)throw error;throw fail(415,'BINARY_FILE','此文件应通过素材预览读取。');}}
 private testText(text:string,testMode?:boolean){return testMode&&!/TEST MODE/i.test(text)?'[TEST MODE]\n'+text:text;}
 private outputText(task:any){
  if(!Array.isArray(task?.plans))throw fail(502,'HF_OUTPUT_NOT_PERSISTED','HyperFrames任务未保存输出。');const parts:string[]=[];for(const plan of task.plans){if(!Array.isArray(plan.outputs))throw fail(502,'HF_OUTPUT_NOT_PERSISTED','HyperFrames任务输出无效。');for(const output of plan.outputs){if(output.deletedAt)continue;if(output.type==='TEXT'&&typeof output.text==='string')parts.push(this.testText(output.text,task.testMode||plan.testMode||output.testMode));else if(output.type==='STRUCTURED'&&output.data!==undefined){const code=output.schemaCode||output.schemaVersion,value=JSON.stringify(output.data);parts.push(this.testText(['creative-doc','form-fields','hf-project'].includes(code)?'```'+code+'\n'+value+'\n```':value,task.testMode||plan.testMode||output.testMode));}}}
  if(!parts.length)throw fail(502,'HF_OUTPUT_NOT_PERSISTED','HyperFrames任务尚未保存文本或结构化输出。');return parts.join('\n');
 }
 private async eventPage(scope:Scope,path:string){const value=(await this.request<EventPage>(scope,path)).data;if(!value||!Array.isArray(value.records)||typeof value.hasMore!=='boolean'||value.records.some(row=>!Number.isSafeInteger(row.seq)||row.seq<1))throw fail(502,'INVALID_EVENT_PROTOCOL','HyperFrames持久化事件协议不可用。');return value;}
 private sse(event:string,data:unknown,id?:number){return(id===undefined?'':'id: '+id+'\n')+'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n';}
 private async pause(scope:Scope){scope.check();await new Promise<void>((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(new DOMException('操作已取消。','AbortError'));};const timer=setTimeout(()=>{scope.signal.removeEventListener('abort',aborted);resolve();},1000);scope.signal.addEventListener('abort',aborted,{once:true});});scope.check();}
 private stream<T>(scope:Scope,first:T,poll:()=>Promise<T>,encode:(value:T)=>{packets:string[];done:boolean}){
  // Validate the first real response before returning successful SSE headers.
  const initial=encode(first),encoder=new TextEncoder();let closed=false;
  const body=new ReadableStream<Uint8Array>({start:controller=>{const abort=()=>{if(!closed){closed=true;controller.error(new DOMException('HyperFrames流已取消。','AbortError'));scope.release();}};scope.signal.addEventListener('abort',abort,{once:true});void(async()=>{try{let next=initial;while(!closed){scope.check();for(const packet of next.packets)controller.enqueue(encoder.encode(packet));if(next.done){closed=true;controller.close();break;}await this.pause(scope);next=encode(await poll());}}catch(error){if(!closed){closed=true;controller.error(error);}}finally{scope.signal.removeEventListener('abort',abort);scope.release();}})();},cancel:()=>{closed=true;scope.abort();scope.release();}});
  return new Response(body,{status:200,headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
 }
 private guardBytes(scope:Scope,response:Response){
  if(!response.body)return response;const reader=response.body.getReader();let closed=false,abort:(()=>void)|undefined;const release=()=>{if(abort)scope.signal.removeEventListener('abort',abort);scope.release();};
  const body=new ReadableStream<Uint8Array>({start:controller=>{abort=()=>{if(!closed){closed=true;release();void reader.cancel().catch(()=>{});controller.error(new DOMException('HyperFrames素材读取已取消。','AbortError'));}};scope.signal.addEventListener('abort',abort,{once:true});},pull:async controller=>{try{scope.check();const result=await reader.read();if(closed)return;scope.check();if(result.done){closed=true;release();controller.close();}else controller.enqueue(result.value);}catch(error){if(!closed){closed=true;release();void reader.cancel().catch(()=>{});controller.error(error);}}},cancel:async()=>{closed=true;scope.abort();release();await reader.cancel();}});
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 }
}
