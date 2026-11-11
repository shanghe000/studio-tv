import {expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {canvasOperationReceipt} from '../../apps/web/src/service/canvas-operation-receipt';
import {encodeGraph} from '../../apps/web/src/service/graph';
const now='2026-11-04T13:00:00Z';
const base={projectId:'p',revision:3,updatedAt:now,graph:encodeGraph({nodes:[{id:'n',type:'rh-text',data:{text:'history'},position:{x:1,y:2}}],edges:[]})};
const body={schemaVersion:'1' as const,batchId:'batch',clientId:'browser',operations:[]};
const change={upsertNodes:[],removeNodeIds:[],upsertEdges:[],removeEdgeIds:[],positions:[{id:'n',x:12,y:23}]};
const v={kind:'DELTA',projectId:'p',batchId:'batch',clientId:'first_sender',revision:4,fromRevision:3,acceptedRevision:4,eventCursor:'295',acceptedAt:now,updatedAt:now,delta:change};
const reply=(data:any,etag='"4"')=>({status:200,etag,data});
const full={...base,revision:4,batchId:'batch',clientId:'first_sender'};
const guard=()=>{};
it('rebases the sender receipt on the exact immutable server base and preserves all untouched rows',async()=>{
 const send=vi.fn(async()=>reply(v));const result=await canvasOperationReceipt('p',body,base,send,guard);
 expect(send).toHaveBeenCalledWith(body,{'X-STUDIO-Canvas-Receipt':'delta-v1','X-STUDIO-Canvas-Base':'3'});expect(send).toHaveBeenCalledTimes(1);
 expect(result.data.graph.nodes.find(n=>n.id==='n')).toMatchObject({position:{x:12,y:23},data:{text:'history'}});expect(base.graph.nodes.find(n=>n.id==='n')?.position).toEqual({x:1,y:2});expect(result.data.clientId).toBe('first_sender');
});
it('accepts a proof of an unchanged current revision (including a duplicate processed at an earlier revision)',async()=>{
 const send=vi.fn(async()=>reply({...v,fromRevision:3,revision:3,acceptedRevision:2,delta:{...change,positions:[]}},'"3"'));
 const result=await canvasOperationReceipt('p',body,base,send,guard);expect(result.data.graph).toEqual(base.graph);expect(send).toHaveBeenCalledTimes(1);
});
it.each([
 ['invalid changed node ID',{...v,delta:{...change,positions:[],upsertNodes:[{id:' bad id',type:'rh-text',data:{},position:{x:0,y:0}}]}}], ['wrong base',{...v,fromRevision:2}],['wrong actor batch',{...v,batchId:'other'}],['missing receipt time',{...v,acceptedAt:null}],['corrupt graph change',{...v,delta:{...change,positions:[{id:'missing',x:1,y:1}]}}],['same revision with a mutation',{...v,revision:3,acceptedRevision:3}],['unknown payload',{}],['wrong wire type',{...v,kind:'OTHER'}]
])('only queries a full receipt after %s',async(_,bad)=>{
 const send=vi.fn().mockResolvedValueOnce(reply(bad)).mockResolvedValueOnce(reply(full));
 expect((await canvasOperationReceipt('p',body,base,send,guard)).data).toEqual(full);expect(send).toHaveBeenCalledTimes(2);
 expect(send.mock.calls[1]).toEqual([{...body,receiptOnly:true}]);
});
it('accepts the legacy full response; a lookup or missing base does not negotiate compact output',async()=>{
 const send=vi.fn(async()=>reply(full));await canvasOperationReceipt('p',body,undefined,send,guard);expect(send.mock.calls[0]).toEqual([body,undefined]);
 const probe={...body,receiptOnly:true};await canvasOperationReceipt('p',probe,base,send,guard);expect(send.mock.calls[1]).toEqual([probe,undefined]);
 await canvasOperationReceipt('p',body,base,send,guard);expect(send).toHaveBeenCalledTimes(3);
});
it('treats a malformed HTTP success as unknown and never sends a second write',async()=>{
 const send=vi.fn().mockRejectedValueOnce(new ApiError(502,'INVALID_RESPONSE','html')).mockResolvedValueOnce(reply(full));await canvasOperationReceipt('p',body,base,send,guard);expect(send.mock.calls[1]).toEqual([{...body,receiptOnly:true}]);
});
it('keeps the outbox entry if the full receipt is invalid or access disappears in flight',async()=>{
 const send=vi.fn().mockResolvedValue(reply({...v,fromRevision:20}));await expect(canvasOperationReceipt('p',body,base,send,guard)).rejects.toMatchObject({code:'INVALID_OPERATION_RECEIPT'});
 const revoked=vi.fn().mockResolvedValue(reply({...v,fromRevision:20}));await expect(canvasOperationReceipt('p',body,base,revoked,()=>{throw new DOMException('revoked','AbortError');})).rejects.toMatchObject({name:'AbortError'});expect(revoked).toHaveBeenCalledTimes(1);
});
