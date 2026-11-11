import {afterEach,expect,it,vi} from 'vitest';
import {CanvasSyncTransport} from '../../apps/web/src/service/canvas-sync-resume';
import {CanvasSync} from '../../apps/web/src/service/canvas-sync';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

const events=()=>{const doc=Object.assign(new EventTarget(),{visibilityState:'visible'}),surface=new EventTarget();return{doc,surface};};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('retires exactly one read for freeze → resume → show → focus and never reopens a stopped attachment',()=>{
 const {doc,surface}=events(),io=new CanvasSyncTransport();io.listen(doc as any,surface as any);
 doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));doc.dispatchEvent(new Event('freeze'));const before=io.signal;expect(before.aborted).toBe(false);
 doc.dispatchEvent(new Event('resume'));expect(before.aborted).toBe(true);io.next();const recovered=io.signal;
 doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));surface.dispatchEvent(new Event('focus'));expect(recovered.aborted).toBe(false);
 io.abort();io.next();expect(io.signal).toBe(recovered);expect(io.signal.aborted).toBe(true);
});
it('recovers BFCache from pageshow alone and coalesces its resume, visibility and focus events',()=>{
 const {doc,surface}=events(),io=new CanvasSyncTransport(),woke=vi.fn();io.listen(doc as any,surface as any);io.onWake(woke);
 const transition=(type:string,persisted:boolean)=>Object.assign(new Event(type),{persisted});
 const initial=io.signal;surface.dispatchEvent(transition('pageshow',false));expect(initial.aborted).toBe(false);
 // A persisted pageshow is sufficient even when no preceding suspension
 // event reached this attachment.
 surface.dispatchEvent(transition('pageshow',true));expect(initial.aborted).toBe(true);
 io.next();const fresh=io.signal;doc.dispatchEvent(new Event('resume'));surface.dispatchEvent(new Event('focus'));expect(fresh.aborted).toBe(false);expect(woke).toHaveBeenCalledOnce();
 // A later history restoration is a new suspension, even without freeze.
 io.markActivity();surface.dispatchEvent(transition('pagehide',true));surface.dispatchEvent(transition('pageshow',true));expect(fresh.aborted).toBe(true);expect(woke).toHaveBeenCalledTimes(2);
 io.abort();
});
it('keeps a live background stream on focus but immediately retries a silent stream after visible-window sleep',()=>{
 vi.useFakeTimers();const {doc,surface}=events(),io=new CanvasSyncTransport(),woke=vi.fn();io.listen(doc as any,surface as any);io.onWake(woke);const initial=io.signal;
 doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));
 vi.advanceTimersByTime(60000);io.markActivity();doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));surface.dispatchEvent(new Event('focus'));
 expect(initial.aborted).toBe(false);expect(woke).not.toHaveBeenCalled();
 // No hidden/freeze event is required when a visible window wakes from sleep.
 vi.advanceTimersByTime(15000);surface.dispatchEvent(new Event('focus'));expect(initial.aborted).toBe(true);expect(woke).toHaveBeenCalledOnce();
 io.next();const recovering=io.signal;surface.dispatchEvent(new Event('focus'));expect(recovering.aborted).toBe(false);
 io.markActivity();vi.advanceTimersByTime(15000);surface.dispatchEvent(new Event('focus'));expect(recovering.aborted).toBe(true);expect(woke).toHaveBeenCalledTimes(2);io.abort();
});
it('wakes an offline reconnect immediately, clears backoff before abort and detaches lifecycle callbacks on stop',()=>{
 const {doc,surface}=events(),io=new CanvasSyncTransport(),atWake:boolean[]=[];io.listen(doc as any,surface as any);io.onWake(()=>atWake.push(io.signal.aborted));
 const initial=io.signal;surface.dispatchEvent(new Event('offline'));surface.dispatchEvent(new Event('online'));expect(initial.aborted).toBe(true);expect(atWake).toEqual([false]);
 io.next();const fresh=io.signal;surface.dispatchEvent(new Event('online'));expect(fresh.aborted).toBe(false);
 io.abort();surface.dispatchEvent(new Event('offline'));surface.dispatchEvent(new Event('online'));surface.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true}));expect(atWake).toEqual([false]);
});
it('wakes a silent SSE body, replays from the applied cursor and converges without losing a pending local change',async()=>{
 const {doc,surface}=events();vi.stubGlobal('document',doc);vi.stubGlobal('window',surface);
 const base={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{title:'old'}}],edges:[]},changed=structuredClone(base);changed.nodes[0].data.title='after resume';
 let revision=1,opened=0,canceled=0;
 const pages:string[]=[];
 const api=new ProductClient('/api/v1',async(path:any,init:any)=>{
  if(path.endsWith('/live-snapshot'))return Response.json({code:0,data:{schemaVersion:'1',projectId:'p',graph:encodeGraph(revision===1?base:changed),graphRevision:revision,eventCursor:String(revision-1),updatedAt:'2026-11-04T00:00:00Z',nodeStates:[],nodeExecutionAvailable:false}});
  if(init.headers.get('Accept')==='text/event-stream'){opened++;return new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{'content-type':'text/event-stream'}});}
  const after=new URL(path,'http://test').searchParams.get('after')!;pages.push(after);
  const events=after==='0'&&revision===2?[{schemaVersion:'1',projectId:'p',sequence:'1',occurredAt:'t',type:'canvas.invalidated',data:{baseRevision:1,graphRevision:2}}]:[];
  return Response.json({code:0,data:{projectId:'p',events,nextCursor:events.length?'1':after,eventCursor:String(revision-1),hasMore:false}});
 });api.setAccessToken('local-test');
 const storage=new ServiceStorage(api,()=>{});storage.projects.set('p',{id:'p',name:'QA',ownerId:'o',revision:1} as any);storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(base),updatedAt:'2026-11-04T00:00:00Z'});let native=base;storage.attachNativeView('p',native);
 const failure=vi.fn(),sync=new CanvasSync(api,storage,'p',{current:()=>true,read:()=>native,apply:g=>{native=g as typeof native;return true;},applied:()=>{},error:failure});
 const run=sync.start();try{
  await vi.waitFor(()=>{if(failure.mock.calls.length)throw failure.mock.calls[0][0];expect(opened).toBe(1);});expect(sync.eventCursor).toBe('0');
  const draft=structuredClone(native);draft.nodes[0].position.x=77;storage.captureDraft('p',draft);native=draft;
  doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));doc.dispatchEvent(new Event('freeze'));revision=2;
  doc.dispatchEvent(new Event('resume'));doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));surface.dispatchEvent(new Event('focus'));
  await vi.waitFor(()=>expect(sync.eventCursor).toBe('1'));expect(pages).toContain('0');expect(canceled).toBe(1);
  expect(native.nodes[0]).toMatchObject({position:{x:77},data:{title:'after resume'}});expect(failure).not.toHaveBeenCalled();
 }finally{sync.stop();await run;}
});
