import {cleanJson,decodeGraph,encodeGraph,type NativeGraph} from './graph';
import {randomUuid} from '../browser-compat';
import {sha256} from '@noble/hashes/sha2.js';

export interface DraftJournalEntry {base:NativeGraph;local:NativeGraph;initialEtag:string;unknownBase:boolean;requiresBaseDecision?:boolean}
export interface DraftEnvelope {
 format:'STUDIOTV_CANVAS_DRAFT';schemaVersion:'1';userId:string;projectId:string;createdAt:string;updatedAt:string;
 baseRevision?:number;base?:NativeGraph;graph:NativeGraph;pending?:DraftJournalEntry[];unresolvedMedia?:number;
}
export interface DraftJournalRecord extends DraftEnvelope {id:string;tabId:string}
export type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
const prefix='studiotv:canvas-draft:v1:';
const consumedPrefix='studiotv:canvas-draft-consumed:v1:';
const digest=(row:DraftEnvelope)=>[...sha256(new TextEncoder().encode(JSON.stringify({base:row.base,baseRevision:row.baseRevision,graph:row.graph,pending:row.pending})))].map(value=>value.toString(16).padStart(2,'0')).join('');
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));

/** Canonical metadata only: credentials and signed URL query strings never
 * belong to a recovery file. Actual media remains in STUDIO's asset storage. */
export function journalGraph(graph:NativeGraph):NativeGraph {
 const safe=cleanJson(graph,value=>{
  if(/^https?:\/\//i.test(value)){const url=new URL(value);if([...url.searchParams.keys()].some(key=>/token|signature|credential|authorization|secret|x-amz|x-tos/i.test(key))){url.search='';return url.href;}}
  return value;
 });
 const scrub=(value:any):any=>Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:token|cookie|set-cookie|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|credential)$/i.test(key)).map(([key,item])=>[key,scrub(item)])):value;
 return decodeGraph(encodeGraph(scrub(safe)));
}

export function parseDraftEnvelope(value:unknown,userId:string,projectId:string):DraftEnvelope {
 const row:any=typeof value==='string'?JSON.parse(value):value;
 if(!row||row.format!=='STUDIOTV_CANVAS_DRAFT'||row.schemaVersion!=='1'||!identity(row.userId)||!identity(row.projectId)||row.userId!==userId||row.projectId!==projectId||!timestamp(row.createdAt)||!timestamp(row.updatedAt))throw new Error('备份的账号、项目或格式不匹配。');
 if(row.baseRevision!==undefined&&(!Number.isSafeInteger(row.baseRevision)||row.baseRevision<1))throw new Error('备份的画布版本无效。');
 if(row.unresolvedMedia!==undefined&&(!Number.isSafeInteger(row.unresolvedMedia)||row.unresolvedMedia<0))throw new Error('备份的本地素材状态无效。');
 if(row.pending!==undefined&&(!Array.isArray(row.pending)||row.pending.length>1000))throw new Error('备份的修改记录无效。');
 const graph=journalGraph(row.graph),base=row.base?journalGraph(row.base):undefined;
 const pending:DraftJournalEntry[]|undefined=row.pending?.map((entry:any)=>{
  if(!entry||typeof entry.initialEtag!=='string'||entry.initialEtag.length>100||typeof entry.unknownBase!=='boolean'||entry.requiresBaseDecision!==undefined&&typeof entry.requiresBaseDecision!=='boolean')throw new Error('备份的修改基线无效。');
  return{base:journalGraph(entry.base),local:journalGraph(entry.local),initialEtag:entry.initialEtag,unknownBase:entry.unknownBase,...(entry.requiresBaseDecision?{requiresBaseDecision:true}:{})};
 });
 return{format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId,projectId,createdAt:row.createdAt,updatedAt:row.updatedAt,graph,...(base?{base}:{}),...(row.baseRevision?{baseRevision:row.baseRevision}:{}),...(pending?{pending}:{}),...(row.unresolvedMedia?{unresolvedMedia:row.unresolvedMedia}:{})};
}

/** Each page instance writes only its own random record key. Reloads and
 * duplicated tabs therefore cannot overwrite an older page's only backup. */
export class DraftJournal {
 readonly tabId=randomUuid();
 constructor(private readonly storage:()=>DraftStorage){ }
 private scope(userId:string,projectId:string){if(!identity(userId)||!identity(projectId))throw new Error('本地备份缺少有效账号或项目。');return prefix+encodeURIComponent(userId)+':'+encodeURIComponent(projectId)+':';}
 list(userId:string,projectId:string,includeResolved=false,onUnreadable?:()=>void):DraftJournalRecord[]{
  const scope=this.scope(userId,projectId),storage=this.storage(),rows:DraftJournalRecord[]=[];
  for(let index=0;index<storage.length;index++){
   const key=storage.key(index);if(!key?.startsWith(scope))continue;
   const raw=storage.getItem(key);if(raw===null)continue;
   try{
   const row=JSON.parse(raw),envelope=parseDraftEnvelope(row,userId,projectId);
   if(typeof row.id!=='string'||typeof row.tabId!=='string'||key!==scope+row.id)throw new Error('本地草稿备份格式损坏，原始记录仍保留。');
   if(!includeResolved&&storage.getItem(consumedPrefix+encodeURIComponent(userId)+':'+encodeURIComponent(projectId)+':'+row.id)===digest(envelope))continue;
   rows.push({...envelope,id:row.id,tabId:row.tabId});
   }catch(e){if(!onUnreadable)throw e;onUnreadable();}
  }
  return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
 }
 write(envelope:DraftEnvelope,id:string):DraftJournalRecord {
  const safe=parseDraftEnvelope(envelope,envelope.userId,envelope.projectId),record={...safe,id,tabId:this.tabId};
  const key=this.scope(safe.userId,safe.projectId)+id,storage=this.storage(),existing=storage.getItem(key);
  if(existing!==null&&JSON.parse(existing).tabId!==this.tabId)throw new Error('此备份属于另一个页面，未覆盖该记录。');
  storage.setItem(key,JSON.stringify(record));return record;
 }
 removeOwn(userId:string,projectId:string,id:string){
  const key=this.scope(userId,projectId)+id,storage=this.storage(),raw=storage.getItem(key);
  if(raw!==null&&JSON.parse(raw).tabId===this.tabId)storage.removeItem(key);
 }
 /** A missing or newer record is not evidence that an edit was recovered.
  * Only storage's successful-save marker for this exact content qualifies. */
 isResolved(record:DraftJournalRecord){return this.storage().getItem(consumedPrefix+encodeURIComponent(record.userId)+':'+encodeURIComponent(record.projectId)+':'+record.id)===digest(record);}
 markResolved(record:DraftJournalRecord){this.storage().setItem(consumedPrefix+encodeURIComponent(record.userId)+':'+encodeURIComponent(record.projectId)+':'+record.id,digest(record));}
}

export function browserDraftJournal():DraftJournal|undefined {
 return typeof window!=='undefined'&&'localStorage'in window?new DraftJournal(()=>window.localStorage):undefined;
}
