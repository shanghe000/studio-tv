import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';

export type LongformError=string|{code?:string;message?:string};
export interface LongformCandidate {id:string;status:string;seed?:string|number;frames?:number;duration?:number;width?:number;height?:number;artifactId?:string;error?:LongformError}
export interface LongformSegment {id:string;index:number;prompt:string;duration:number;seed?:string|number;selectedCandidateId?:string|null;stale?:boolean;candidates:LongformCandidate[]}
export interface LongformProgress {phase?:string;scope?:string;updatedAt?:number|string;currentStep?:number;totalSteps?:number}
export interface LongformJob {id:string;type:string;status:string;currentSegmentId?:string;progress?:LongformProgress;error?:LongformError}
export interface LongformProject {id:string;revision:number;title:string;canvasId?:string;nodeId?:string;commonPrompt?:string;references?:LongformReference[];settings:Record<string,any>;segments:LongformSegment[];jobs:LongformJob[];compositions:{id:string;artifactId?:string;status?:string}[];activeJobId?:string|null}
export interface LongformReference {assetId:string;kind:'IMAGE'|'VIDEO'|'AUDIO';role:string;videoIndex?:number}
export interface LongformCapabilities {available?:boolean;reason?:string;defaults?:Record<string,any>;settingsSchema?:{properties?:Record<string,any>;[key:string]:any};limits?:Record<string,number>;productLimits?:{maxImportBytes?:number;[key:string]:number|undefined};[key:string]:any}
export interface LongformDraft {title:string;commonPrompt:string;settings:Record<string,any>;segments:{id?:string;prompt:string;duration:number;seed?:string|number}[];references:LongformReference[]}
export type LongformAction='updateDraft'|'generateAll'|'retrySegment'|'regenerateFrom'|'append'|'adoptCandidate'|'composeSelected'|'stopAfterSegment'|'keepFollowing';
// Keep aligned with the cloud longform runtime's ACTIVE set. activeJobId is
// the durable mutation lock, including submission/recovery/composition phases.
export const longformPending=new Set(['QUEUED','RUNNING','UNKNOWN','SUBMITTING','COMPOSING']);
export function longformBusy(project:LongformProject|undefined){return !!project?.activeJobId;}
export function longformDuration(project:Pick<LongformProject,'segments'>|LongformDraft){return project.segments.reduce((total,segment)=>total+Number(segment.duration||0),0);}
export function longformOutputLimitText(cap:LongformCapabilities){
 const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
 const cloud=cap.limits?.maxArtifactBytes,product=cap.productLimits?.maxImportBytes,bytes=Math.min(valid(cloud)?cloud:512*1024*1024,valid(product)?product:Infinity),unit=bytes>=1024**3?'GiB':'MiB',amount=Number((bytes/(unit==='GiB'?1024**3:1024**2)).toFixed(2));
 return `单个分段或合片文件上限 ${amount} ${unit}${valid(cloud)?'':'（云端默认值，以实际服务配置为准）'}；按原视频规格导出。`;
}
function nativeRound(value:number){const floor=Math.floor(value),fraction=value-floor;return fraction===.5?floor%2===0?floor:floor+1:Math.round(value);}
export function longformNativeDimensions(aspectRatio:unknown,megapixels:number,multiple=32){
 const match=typeof aspectRatio==='string'?aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)(?:\s|$)/):undefined;
 if(!match||!Number.isFinite(megapixels)||megapixels<=0||!Number.isSafeInteger(multiple)||multiple<=0)return;
 const a=Number(match[1]),b=Number(match[2]);if(a<=0||b<=0)return;const scale=Math.sqrt(megapixels*1024*1024/(a*b));return{width:nativeRound(a*scale/multiple)*multiple,height:nativeRound(b*scale/multiple)*multiple};
}
export function longformResolutionPresets(settings:Record<string,any>,cap:LongformCapabilities){
 const aspect=settings.aspectRatio??settings.aspect_ratio,match=typeof aspect==='string'?aspect.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)(?:\s|$)/):undefined,field=cap.settingsSchema?.properties?.megapixels;if(!match||!field)return[];
 const a=Number(match[1]),b=Number(match[2]),multiple=cap.limits?.dimensionMultiple??32;if(a<=0||b<=0||!Number.isSafeInteger(multiple)||multiple<=0)return[];
 return[480,720,768,1080].flatMap(resolution=>{const shortEdge=Math.ceil(resolution/multiple)*multiple,scale=shortEdge/Math.min(a,b),megapixels=Number((a*b*scale*scale/1024**2).toFixed(6)),dimensions=longformNativeDimensions(aspect,megapixels,multiple);if(!dimensions||megapixels<(field.minimum??.1)||megapixels>(field.maximum??cap.limits?.maxMegapixels??16))return[];return[{resolution,megapixels,...dimensions,approximate:Math.min(dimensions.width,dimensions.height)!==resolution}];});
}
/** Width and height are server-derived display fields, never authored settings.
 * Normalize before journaling/signing so retries use the exact submitted body. */
function longformMutationInput(input:any){const body=structuredClone(input);for(const settings of [body.settings,body.patch?.settings])if(settings&&typeof settings==='object'&&!Array.isArray(settings)){delete settings.width;delete settings.height;}return body;}
export function longformDraft(project:LongformProject,references:LongformReference[]=[]):LongformDraft{return{title:project.title,commonPrompt:project.commonPrompt??'',settings:structuredClone(project.settings),segments:project.segments.map(({id,prompt,duration,seed})=>({id,prompt,duration,...(seed===undefined?{}:{seed})})),references:structuredClone((project as any).references??references)};}
export function validLongformSeed(value:unknown){return typeof value==='number'?Number.isSafeInteger(value)&&value>=0:typeof value==='string'&&/^[0-9]{1,20}$/.test(value)&&BigInt(value)<=18446744073709551615n;}
function schemaError(value:any,schema:any,title:string):string|undefined{
 const types=Array.isArray(schema.type)?schema.type:[schema.type];if(value===undefined||value===null&&types.includes('null'))return;
 if(Array.isArray(schema.enum)&&!schema.enum.some((item:any)=>JSON.stringify(item)===JSON.stringify(value)))return `${title} 不在当前可用选项中。`;
 if(types.some((t:string)=>['number','integer'].includes(t))&&(!Number.isFinite(value)||types.includes('integer')&&!Number.isInteger(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))return `${title} 超出支持范围。`;
 if(types.includes('string')&&(typeof value!=='string'||schema.pattern&&!new RegExp(schema.pattern).test(value)))return `${title} 格式无效。`;
 if(types.includes('boolean')&&typeof value!=='boolean')return `${title} 需选择开启或关闭。`;
 if(types.includes('array')){if(!Array.isArray(value))return `${title} 格式无效。`;if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)return `${title} 项目数量超出范围。`;if(schema.items)for(const [i,item]of value.entries()){const error=schemaError(item,schema.items,`${title} 第 ${i+1} 项`);if(error)return error;}}
 if(types.includes('object')){if(value===null||typeof value!=='object'||Array.isArray(value))return `${title} 格式无效。`;for(const key of schema.required??[])if(value[key]===undefined)return `${title} 缺少 ${key}。`;for(const [key,field]of Object.entries(schema.properties??{})){const error=schemaError(value[key],field,`${title} ${key}`);if(error)return error;}}
 return;
}
export function validateLongformDraft(draft:LongformDraft,cap:LongformCapabilities):string|undefined{
 if(!draft.title.trim())return '请填写长片名称。';
 if(!draft.segments.length)return '请先添加至少一段。';
 const max=cap.limits?.maxSegments??10000;if(draft.segments.length>max)return `最多支持 ${max} 段。`;
 for(const [kind,limitKey,name]of [['IMAGE','maxImages','图片'],['VIDEO','maxVideos','视频'],['AUDIO','maxAudios','独立音频']] as const){const limit=cap.limits?.[limitKey];if(limit!==undefined&&draft.references.filter(ref=>ref.kind===kind&&(kind!=='AUDIO'||ref.role!=='VIDEO_AUDIO')).length>limit)return `${name}参考最多支持 ${limit} 份，请移除多余连线或引用。`;}
 const videos=draft.references.filter(ref=>ref.kind==='VIDEO'),paired=draft.references.filter(ref=>ref.kind==='AUDIO'&&ref.role==='VIDEO_AUDIO');
 if(paired.length>(cap.limits?.maxVideoAudioTracks??3))return '参考视频音轨最多支持 3 份。';
 if(paired.some(ref=>!Number.isInteger(ref.videoIndex)||ref.videoIndex!<0||ref.videoIndex!>=videos.length))return '配对音轨需要对应已连接的参考视频，请重新选择。';
 if(new Set(paired.map(ref=>ref.videoIndex)).size!==paired.length)return '每个参考视频最多配对一份音轨，请调整音频用途。';
 const minDuration=cap.limits?.durationMin??cap.limits?.minDuration??0.01,maxDuration=cap.limits?.durationMax??cap.limits?.maxDuration??150;
 for(const [index,segment]of draft.segments.entries()){
  if(!segment.prompt.trim())return `第 ${index+1} 段需要画面描述。`;
  if(!Number.isFinite(segment.duration)||segment.duration<minDuration||segment.duration>maxDuration)return `第 ${index+1} 段时长需在 ${minDuration}–${maxDuration} 秒之间。`;
  if(segment.seed!==undefined&&!validLongformSeed(segment.seed))return `第 ${index+1} 段种子需为 0–18446744073709551615 的整数。`;
 }
 for(const [key,field]of Object.entries(cap.settingsSchema?.properties??{})){
  const value=draft.settings[key];if(value===undefined)continue;const error=schemaError(value,field,field.title??key);if(error)return error;
 }
 if(draft.settings.seed!==undefined&&!validLongformSeed(draft.settings.seed))return '种子超出支持范围。';
 const sigmas=draft.settings.sigmas;if(Array.isArray(sigmas)&&(sigmas.length<2||sigmas.at(-1)!==0||sigmas.some((n:any,i:number)=>typeof n!=='number'||!Number.isFinite(n)||n<0||i>0&&n>=sigmas[i-1])))return 'SIGMAS 需严格递减，并以 0 结束。';
 return;
}

/** A failed mutation keeps its exact request ID and payload until the caller
 * explicitly retries it or reloads server state. No unknown submission is replayed
 * under a new key, and the server remains the source of saved project state. */
export class LongformClient {
 private pending:{signature:string;requestId:string;path:string;body:any}|undefined;
 constructor(private api:Pick<ProductClient,'requestV2'|'rawV2'>,private current:()=>boolean=()=>true,private journal?:{getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void;removeItem:(key:string)=>void},private journalKey='studio-longform-pending'){
  try{const saved=JSON.parse(this.journal?.getItem(this.journalKey)??'null');if(saved&&typeof saved.requestId==='string'&&typeof saved.path==='string'&&saved.path.startsWith('/longform/projects')&&typeof saved.signature==='string'&&saved.body&&typeof saved.body==='object')this.pending=saved;}catch{}
 }
 private check(){if(!this.current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开长片面板。');}
 private clearPending(){this.pending=undefined;try{this.journal?.removeItem(this.journalKey);}catch{/* A stale completed key is safely reconciled by server idempotency. */}}
 async capabilities(){this.check();const result=await this.api.requestV2<LongformCapabilities>('/longform/capabilities',{cache:'no-store'});this.check();return result.data;}
 async find(canvasId:string,nodeId:string){this.check();const result=await this.api.requestV2<{items:LongformProject[]}>('/longform/projects?'+new URLSearchParams({canvasId,nodeId}),{cache:'no-store'});this.check();return result.data.items;}
 async get(id:string){this.check();const result=await this.api.requestV2<LongformProject>('/longform/projects/'+encodeURIComponent(id),{cache:'no-store'});this.check();return result.data;}
 async create(canvasId:string,nodeId:string,draft:LongformDraft){return this.mutate('/longform/projects',{canvasId,nodeId,...draft});}
 async action(project:LongformProject,type:LongformAction,fields:Record<string,any>={}){return this.mutate('/longform/projects/'+encodeURIComponent(project.id)+'/actions',{canvasId:project.canvasId,expectedRevision:project.revision,type,...fields});}
 private async mutate(path:string,input:any){
  this.check();const actual=this.pending&&input===this.pending.body?input:longformMutationInput(input),signature=JSON.stringify([path,actual]);
  if(this.pending&&this.pending.signature!==signature)throw new ApiError(409,'LONGFORM_SUBMISSION_UNKNOWN','上次操作尚未确认，请先重试该操作或刷新检查结果。');
  const operation=this.pending??{signature,requestId:randomUuid(),path,body:actual};this.pending=operation;
  if(this.journal)try{this.journal.setItem(this.journalKey,JSON.stringify(operation));}catch{throw new ApiError(409,'LONGFORM_REQUEST_NOT_SAVED','无法保存待确认操作，请保持页面打开并检查浏览器存储后重试。');}
  try{const result=await this.api.requestV2<LongformProject>(operation.path,{method:'POST',body:{...operation.body,requestId:operation.requestId},idempotencyKey:operation.requestId});this.check();this.clearPending();return result.data;}
  catch(error){if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408)this.clearPending();throw error;}
 }
 async retryPending(){if(!this.pending)throw new Error('当前没有待确认操作。');return this.mutate(this.pending.path,this.pending.body);}
 hasPending(){return !!this.pending;}
 async artifact(projectId:string,id:string){this.check();const response=await this.api.rawV2('/longform/projects/'+encodeURIComponent(projectId)+'/artifacts/'+encodeURIComponent(id)+'/content');this.check();if(!response.ok)throw new ApiError(response.status,'LONGFORM_ARTIFACT_UNAVAILABLE','视频暂时无法读取，请刷新后重试。');const blob=await response.blob();this.check();if(!blob.type.startsWith('video/'))throw new Error('服务未返回可播放的视频。');return blob;}
}
