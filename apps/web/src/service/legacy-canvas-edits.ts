import {sha256} from '@noble/hashes/sha2.js';
import {ApiError} from '../api/client';
import type {ProjectGraph,Snapshot} from '../api/types';
import {applyCanvasOperations,diffCanvasOperations,type CanvasOperationBatch} from './canvas-operations';
import {outboxInputProof} from './canvas-outbox-proof';
import {META_NODE,type NativeGraph} from './graph';
import type {DraftJournalRecord} from './draft-journal';
import {equalDraftValue} from './canvas-draft';

type Outcome='saved'|'already-saved'|'retained';
type RecoverRequest=CanvasOperationBatch&{baseRevision?:number;receiptOnly?:boolean};
const hash=(value:string)=>Array.from(sha256(new TextEncoder().encode(value)),b=>b.toString(16).padStart(2,'0')).join('');

// A native mount decorates its copy with the project ID/title. These are
// scope/display data, never authored graph edits. Scope is verified separately.
const content=(g:NativeGraph):NativeGraph=>{
 const {id:_id,name:_name,...rest}=g.meta??{};return {...g,meta:rest};
};
const same=(a:NativeGraph,b:NativeGraph)=>equalDraftValue(content(a),content(b));
function explicitRevision(r:DraftJournalRecord){
 if(r.baseRevision)return r.baseRevision;
 const p=r.pending?.[0],m=p?.initialEtag.match(/^"([1-9]\d*)"$/);
 if(!p||!m||p.unknownBase||p.requiresBaseDecision||!r.base||!same(p.base,r.base))return;
 const n=Number(m[1]);return Number.isSafeInteger(n)?n:undefined;
}
/** Numbered checkpoints and unique causal links take precedence over time.
 * Never treat several plausible predecessors as an independent edit. */
export function legacyRecoveryOrder(all:DraftJournalRecord[],resolved:(r:DraftJournalRecord)=>boolean){
 const newest=new Map<string,DraftJournalRecord>();
 for(const r of all)if(!newest.has(r.tabId)||newest.get(r.tabId)!.updatedAt<r.updatedAt)newest.set(r.tabId,r);
 const result:{row:DraftJournalRecord;baseRevision:number|undefined;ambiguous:boolean}[]=[],visited=new Set<string>();
 const byResult=new Map<string,DraftJournalRecord[]>(),memo=new Map<string,number|undefined>();
 const signature=(g:NativeGraph)=>hash(JSON.stringify(content(g),(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v));
 const roots=[...newest.values()].filter(r=>!resolved(r));
 if(roots.some(r=>!explicitRevision(r)))for(const r of all){const sig=signature(r.graph);const rows=byResult.get(sig)??[];rows.push(r);byResult.set(sig,rows);}
 function visit(r:DraftJournalRecord):number|undefined{
  if(visited.has(r.id))return memo.get(r.id);
  visited.add(r.id);let rev=explicitRevision(r),ambiguous=false;
  if(!rev&&r.base){const candidates=(byResult.get(signature(r.base))??[]).filter(p=>p.id!==r.id&&p.userId===r.userId&&p.projectId===r.projectId&&same(p.graph,r.base!));
   if(candidates.length===1){rev=visit(candidates[0]);ambiguous=!rev;}
   else ambiguous=candidates.length>1;
  }
  memo.set(r.id,rev);if(!resolved(r))result.push({row:r,baseRevision:rev,ambiguous});return rev;
 }
 for(const r of roots.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)))visit(r);
 return result;
}

/** For an old browser record the original page may be long gone. Its copy
 * stays untouched until the new, authorized writer proves the intent is
 * already present or receives an idempotent receipt. Never PUT the envelope.
 * A failed comparison is local to this record; it must not pause the canvas.
 */
export async function recoverLegacyEdit(row:DraftJournalRecord,snapshot:Snapshot,clientId:string,encode:(g:NativeGraph)=>ProjectGraph,send:(body:RecoverRequest)=>Promise<Snapshot&{batchId:string;acceptedRevision?:number;supersededOperations?:number}>,accept:(s:Snapshot)=>void):Promise<Outcome>{
 const revision=explicitRevision(row);
 if(snapshot.projectId!==row.projectId||!row.base||(revision!==undefined&&revision>snapshot.revision)||row.unresolvedMedia||row.pending?.some(e=>e.unknownBase||e.requiresBaseDecision))return 'retained';
 const encodeContent=(g:NativeGraph)=>encode(content(g));
 const base=encodeContent(row.base),local=encodeContent(row.graph);let authored=base;
 if(row.pending?.length){
  // Only replay the original page's explicit before/after edits; its merged
  // display can also contain unrelated work that arrived from the server.
  for(const p of row.pending)authored=applyCanvasOperations(authored,diffCanvasOperations(encodeContent(p.base),encodeContent(p.local)));
 }else authored=local;
 const operations=diffCanvasOperations(base,authored);
 if(!operations.length)return diffCanvasOperations(base,local).length?'retained':'already-saved';
 // The oldest recorder occasionally had no ETag. Only existing-node
 // field patches with a complete, continuous before/after chain qualify.
 // Start at revision 1 so that *every* known deletion fences such a patch.
 if(!revision&&(!row.pending?.length||!row.pending.every((p,i)=>p.initialEtag==='unknown'&&same(i?row.pending![i-1].local:row.base!,p.base))
  ||operations.some(op=>op.type!=='node.patch'||op.nodeId===META_NODE)))return 'retained';
 const proof=(g:ProjectGraph)=>outboxInputProof(g,operations);
 const wanted=proof(authored);if(proof(local)!==wanted)return 'retained';
 const actual=proof(snapshot.graph);
 if(actual===wanted)return 'already-saved';
 const batchId='legacy_'+hash(JSON.stringify([row.userId,row.projectId,row.id,revision??null,operations])).slice(0,48);
 const request:RecoverRequest={schemaVersion:'1',batchId,clientId,observedRevision:revision??1,operations,
  ...(actual===proof(base)?{baseRevision:snapshot.revision}:{receiptOnly:true})};
 // Compare and apply in one server transaction. A concurrent new change may
 // invalidate the comparison. No new ID is minted after a lost response.
 try{
  const receipt=await send(request);
  if(receipt.projectId!==row.projectId||receipt.batchId!==batchId)throw new ApiError(502,'INVALID_OPERATION_RECEIPT','尚未确认旧页面的修改。');
  accept(receipt);
  return receipt.supersededOperations?'retained':'saved';
 }catch(e){
  if(request.receiptOnly&&e instanceof ApiError&&e.code==='CANVAS_BATCH_NOT_APPLIED')return 'retained';
  throw e;
 }
}
