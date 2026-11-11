import {expect,it} from 'vitest';
import {CanvasPageOutbox} from '../../apps/web/src/service/canvas-page-outbox';
import {CanvasOperationSession} from '../../apps/web/src/service/canvas-operations';
import {encodeGraph} from '../../apps/web/src/service/graph';

function storage(){const map=new Map<string,string>();return{get length(){return map.size;},key:(i:number)=>[...map.keys()][i]??null,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,v:string)=>{map.set(key,v);},removeItem:(key:string)=>{map.delete(key);},map};}
function lockManager(){const held=new Set<string>();return{request:async(name:string,opts:any,fn:(lock:any)=>Promise<void>)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}} as Pick<LockManager,'request'>;}
const graph=(value:string)=>encodeGraph({nodes:[{id:'a',type:'rh-text',position:{x:0,y:0},data:{text:value}}],edges:[]});
const snap=(revision:number,value='initial')=>({projectId:'p',revision,graph:graph(value)});
const page=(raw:ReturnType<typeof storage>,locks:Pick<LockManager,'request'>|undefined,id:string)=>{const journal=new CanvasPageOutbox(raw,'u','p',id,locks);const s=new CanvasOperationSession({userId:'u',projectId:'p',clientId:id,storage:journal});s.acceptSnapshot(snap(1));s.reobserve(graph('initial'));return s;};
it.each([true,false])('does not adopt a running sibling outbox, but recovers it after closing (Web Locks=%s)',async supported=>{
 const raw=storage(),locks=supported?lockManager():undefined,a=page(raw,locks,'chromeA'),b=page(raw,locks,'chromeB');
 await Promise.all([a.prepareRecovery(),b.prepareRecovery()]);
 const batch=a.observe(graph('A offline edit'))!;expect(batch.observedRevision).toBe(1);
 await b.prepareRecovery();b.refreshOutbox();expect(b.pending()).toEqual([]);
 const edge=page(storage(),locks,'edge');await edge.prepareRecovery();edge.refreshOutbox();expect(edge.hasPending()).toBe(false);edge.dispose();
 a.dispose();await Promise.resolve();await b.prepareRecovery();b.refreshOutbox();
 expect(b.head()).toMatchObject({batchId:batch.batchId,clientId:'chromeB',observedRevision:1,operations:batch.operations});
 b.acceptSnapshot(snap(3,'remote after A'));expect(b.head()?.observedRevision).toBe(1);expect(b.recoveryOptions()).toEqual({receiptOnly:true});
 b.acknowledge(batch.batchId,snap(4,'A offline edit'));b.releaseRecovered();expect([...raw.map.values()].some(v=>v.includes(batch.batchId))).toBe(false);b.dispose();
});
it('recovers an earlier v1 row without inventing the revision it saw',async()=>{
 const raw=storage(),legacy=new CanvasOperationSession({userId:'u',projectId:'p',clientId:'legacy',storage:raw});legacy.acceptSnapshot(snap(1));legacy.reobserve(graph('initial'));
 const b=legacy.observe(graph('legacy pending'))!,key='studiotv:canvas-operations:1:u:p:'+b.batchId,record=JSON.parse(raw.getItem(key)!);delete record.observedRevision;raw.setItem(key,JSON.stringify(record));
 const modern=page(raw,lockManager(),'new');await modern.prepareRecovery();modern.refreshOutbox();expect(modern.head()?.batchId).toBe(b.batchId);expect(modern.head()).not.toHaveProperty('observedRevision');modern.acknowledge(b.batchId,snap(2,'legacy pending'));expect(raw.getItem(key)).toBeNull();modern.dispose();
});

it('captures the rendered identity frontier even when a newer receipt arrived during a drag',()=>{
 const s=new CanvasOperationSession({userId:'u',projectId:'p',clientId:'chrome'});s.acceptSnapshot(snap(4));s.reobserve(graph('initial'),4);
 s.acceptSnapshot(snap(7,'replacement node with same ID'));const beforePaint=s.observe(graph('mouse-up on removed node'))!;
 expect(beforePaint.observedRevision).toBe(4);s.reobserve(graph('replacement node with same ID'),7);
 const afterPaint=s.observe(graph('new edit on replacement'))!;expect(afterPaint.observedRevision).toBe(7);expect(s.pending()[0].observedRevision).toBe(4);
});

it('keeps the original receipt payload when an unknown result is retried after server deployment',()=>{
 let modern=false;const s=new CanvasOperationSession({userId:'u',projectId:'p',clientId:'a',permitsObservedRevision:()=>modern});s.acceptSnapshot(snap(1));s.reobserve(graph('initial'),1);
 const legacy=s.observe(graph('old server'))!;modern=true;expect(s.head()).toEqual(legacy);expect(legacy).not.toHaveProperty('observedRevision');
 const next=s.observe(graph('new server'))!;modern=false;expect(s.pending()[1]).toEqual(next);expect(next.observedRevision).toBe(1);
});
it('keeps a private journal when the origin rejects the Web Locks call synchronously',async()=>{
 const raw=storage(),locks={request(){throw new DOMException('Blocked','SecurityError');}} as Pick<LockManager,'request'>;
 const a=page(raw,locks,'one'),b=page(raw,locks,'two');await Promise.all([a.prepareRecovery(),b.prepareRecovery()]);a.observe(graph('protected'));await b.prepareRecovery();b.refreshOutbox();expect(b.hasPending()).toBe(false);
 a.dispose();await b.prepareRecovery();b.refreshOutbox();expect(b.hasPending()).toBe(true);b.dispose();
});
it('writes to a new physical owner after history navigation while the old queue is being recovered',async()=>{
 const raw=storage(),locks=lockManager(),events=new EventTarget(),journal=new CanvasPageOutbox(raw,'u','p','first',locks,events as Window);
 const a=new CanvasOperationSession({userId:'u',projectId:'p',clientId:'first',storage:journal}),b=page(raw,locks,'other');a.acceptSnapshot(snap(1));a.reobserve(graph('initial'),1);await a.prepareRecovery();const old=a.observe(graph('prior page'))!;
 events.dispatchEvent(new Event('pagehide'));await new Promise(resolve=>setTimeout(resolve,0));await b.prepareRecovery();b.refreshOutbox();expect(b.head()?.batchId).toBe(old.batchId);events.dispatchEvent(new Event('pageshow'));await a.prepareRecovery();const fresh=a.observe(graph('restored page'))!;
 expect([...raw.map.keys()].find(k=>k.endsWith(fresh.batchId))).not.toContain(':first:');b.refreshOutbox();expect(b.hasPending()).toBe(true);expect(b.pending().some(x=>x.batchId===fresh.batchId)).toBe(false);a.dispose();b.dispose();
});

it.each([true,false])('removes the original persisted batch when its receipt arrives after history restoration (Web Locks=%s)',async supported=>{
 const raw=storage(),locks=supported?lockManager():undefined,events=new EventTarget(),journal=new CanvasPageOutbox(raw,'u','p','first',locks,events as Window);
 const a=new CanvasOperationSession({userId:'u',projectId:'p',clientId:'first',storage:journal}),b=page(raw,locks,'other');a.acceptSnapshot(snap(1));a.reobserve(graph('initial'),1);await a.prepareRecovery();const old=a.observe(graph('prior page'))!;
 events.dispatchEvent(new Event('pagehide'));await new Promise(resolve=>setTimeout(resolve,0));await b.prepareRecovery();b.refreshOutbox();expect(b.head()?.batchId).toBe(old.batchId);
 events.dispatchEvent(new Event('pageshow'));await a.prepareRecovery();const fresh=a.observe(graph('restored page'))!;
 a.acknowledge(old.batchId,snap(2,'prior page'));
 expect([...raw.map.keys()].some(k=>k.endsWith(old.batchId))).toBe(false);
 expect([...raw.map.keys()].some(k=>k.endsWith(fresh.batchId))).toBe(true);
 a.acknowledge(fresh.batchId,snap(3,'restored page'));a.dispose();b.dispose();
});

it.each([true,false])('pins a pre-admission edit exactly once after protocol negotiation (modern=%s)',modern=>{
 const raw=storage(),options={userId:'u',projectId:'p',clientId:'a',storage:raw,permitsObservedRevision:()=>undefined};const first=new CanvasOperationSession(options);first.acceptSnapshot(snap(5));first.reobserve(graph('initial'),5);const queued=first.observe(graph('just connected'))!;
 expect(queued.observedRevision).toBeUndefined();const afterReload=new CanvasOperationSession(options);expect(afterReload.headForTransport(modern)?.observedRevision).toBe(modern?5:undefined);const sent=afterReload.head();expect(sent?.batchId).toBe(queued.batchId);expect(new CanvasOperationSession(options).headForTransport(!modern)).toEqual(sent);
});
