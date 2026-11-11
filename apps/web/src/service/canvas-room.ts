import {ApiError} from '../api/client';
import {decodeRoomMoves,encodeRoomMoves,moveFormat,type RoomBinding} from './canvas-room-moves';

// The native editor installs a WebSocket shim for its vendor endpoints.
// Capture the browser implementation while the STUDIO service loads first.
const BrowserSocket = globalThis.WebSocket;
export const roomProtocol = 'studiotv.canvas.v1';
const maxFrame = 6 * 1024 * 1024;
const maxBufferedEvents = 32;

export interface RoomEvent { event: string; id: string; data: unknown }
interface Receipt {status: number; etag: string|null; body: unknown}
interface Pending {resolve: (value: Receipt|null) => void; candidate?: {binding:RoomBinding;batchId:string}}
type Incoming = {type:'event'; value:RoomEvent; size:number} | {type:'ready'};
const unavailable = () => new TypeError('Canvas room transport unavailable');

/** A single reader applies committed events in order. A receipt can resolve
 * while that reader is waiting for native input/focus or loading assets. */
export class CanvasRoom {
 private closed = false;
 private ready = false;
 private moves = false;
 private pinned?: RoomBinding;
 private seq = 0;
 private terminal: unknown;
 private incoming: Incoming[] = [];
 private buffered = 0;
 private wake?: () => void;
 private activity = new Set<() => void>();
 private pending = new Map<string, Pending>();
 private timeout: ReturnType<typeof setTimeout>;
 private abort = () => this.close(this.signal.reason ?? new DOMException('Aborted','AbortError'));

 static open(project:string, token:string, after:string, signal:AbortSignal) {
  if (!BrowserSocket || !globalThis.location || signal.aborted) return null;
  const url = new URL('/api/v2/projects/'+encodeURIComponent(project)+'/canvas-room',location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
   return new CanvasRoom(new BrowserSocket(url.href, roomProtocol), token, after, signal, project);
  } catch { return null; }
 }

 constructor(private socket: WebSocket, token:string, after:string, private signal:AbortSignal, private projectId:string) {
  socket.binaryType='arraybuffer';
  this.timeout = setTimeout(() => this.close(), 3000);
  socket.onopen = () => {
   if (this.closed) return;
   if (socket.protocol !== roomProtocol) {this.close();return;}
   try {socket.send(JSON.stringify({type:'join',token,after,formats:[moveFormat]}));} catch {this.close();}
  };
  socket.onerror = socket.onclose = () => this.close();
  socket.onmessage = e => this.receive(e.data);
  signal.addEventListener('abort',this.abort,{once:true});
  if (signal.aborted) this.abort();
 }

 private receive(raw:unknown) {
  if (this.closed) return;
  const length = typeof raw === 'string' ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : 0;
  if (!length || length > maxFrame) {this.close();return;}
  try {
   let m;
   if (typeof raw === 'string') m=JSON.parse(raw);
   else if (this.moves && raw instanceof ArrayBuffer) m=decodeRoomMoves(raw,this.projectId);
   else {this.close();return;}
   if (m.type === 'error') {
    if (Number.isInteger(m.status) && m.status>=400 && m.status<=599 && typeof m.body?.code==='string')
     this.close(new ApiError(m.status,m.body.code,String(m.body.message || '画布房间连接中断。'),m.body.requestId));
    else this.close();
    return;
   }
   if (!this.ready) {
    if (m.type!=='ready') {this.close();return;}
    this.ready=true;
    this.moves=Array.isArray(m.formats) && m.formats.includes(moveFormat);
    this.incoming.push({type:'ready'});
   } else if (m.type==='heartbeat') {
    this.renewReadTimeout();
    return;
   } else if (m.type==='receipt') {
    const write=this.pending.get(m.requestId);
    if (!write) {this.renewReadTimeout();return;} // Canceled or already retried with the same immutable batch.
    const success=Number.isInteger(m.status)&&m.status>=200&&m.status<300&&m.body?.code===0&&m.body.data&&typeof m.body.data==='object';
    const refused=Number.isInteger(m.status)&&m.status>=400&&m.status<=599&&typeof m.body?.code==='string'&&typeof m.body.message==='string';
    if ((!success&&!refused) || (m.etag!=null&&typeof m.etag!=='string')) {this.close();return;}
    this.renewReadTimeout();
    // Only the server can acknowledge the first binding. It never changes
    // during this connection, even if another term finishes a write later.
    if (!this.pinned && success && m.bound===true && write.candidate &&
        m.body.data.batchId===write.candidate.batchId) this.pinned=write.candidate.binding;
    write.resolve({status:m.status,etag:m.etag??null,body:m.body});
    return;
   } else if (m.type==='event' && typeof m.event==='string' && typeof m.id==='string') {
    if (this.incoming.length>=maxBufferedEvents || this.buffered+length>maxFrame) {this.close();return;}
    this.buffered+=length;
    this.incoming.push({type:'event',value:{event:m.event,id:m.id,data:m.data},size:length});
   } else {this.close();return;}
   this.renewReadTimeout();
   this.wake?.();
  } catch {this.close();}
 }

 private renewReadTimeout() {
  clearTimeout(this.timeout);
  this.timeout=setTimeout(() => this.close(),20000);
  for (const listener of this.activity) listener();
 }

 /** Heartbeats can keep a quiet room healthy without waking its event reader.
  * Observe them for foreground recovery without reopening a healthy room. */
 onActivity(listener:()=>void) {
  if (!this.closed) this.activity.add(listener);
  return () => {this.activity.delete(listener);};
 }

 async next():Promise<Incoming> {
  while (!this.closed && !this.incoming.length) await new Promise<void>(resolve => {this.wake=resolve;});
  this.wake=undefined;
  if (this.closed) throw this.terminal;
  const next=this.incoming.shift()!;
  if (next.type==='event') this.buffered-=next.size;
  return next;
 }

 write(body:unknown, credential:{proof:string;lease:string}, baseRevision:number|undefined, signal?:AbortSignal|null):Promise<Receipt|null>|null {
  if (this.closed || !this.ready || signal?.aborted || this.pending.size>=8 || this.socket.bufferedAmount>256*1024) return null;
  const requestId=String(++this.seq);
  const frame=JSON.stringify({type:'write',requestId,body,proof:credential.proof,lease:credential.lease,baseRevision});
  if (frame.length>2*1024*1024) return null;
  const compact = this.moves ? encodeRoomMoves(requestId,body,credential.proof,credential.lease,baseRevision,this.pinned) : null;
  // A binary frame is selected only when it is provably shorter. The text's
  // UTF-8 byte count is always at least this many UTF-16 code units.
  const shortened = compact && compact.frame.byteLength < frame.length ? compact : null;
  const payload = shortened?.frame ?? frame;
  return new Promise((resolve,reject) => {
   const finish=() => {clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(requestId);};
   const abort=() => {finish();reject(signal?.reason ?? new DOMException('Aborted','AbortError'));};
   // A lost acknowledgement is uncertain. Retrying via HTTP is safe only
   // because the caller keeps the exact operation batch ID, body and grant.
   const timer=setTimeout(() => this.close(),5000);
   this.pending.set(requestId,{resolve:value => {finish();resolve(value);},
    candidate:shortened ? {binding:shortened.binding,batchId:shortened.batchId} : undefined});
   signal?.addEventListener('abort',abort,{once:true});
   try {this.socket.send(payload);} catch {this.close();}
  });
 }

 close(reason:unknown=unavailable()) {
  if (this.closed) return;
  this.closed=true;
  this.activity.clear();
  this.pinned=undefined;
  this.terminal=reason;
  clearTimeout(this.timeout);
  this.signal.removeEventListener('abort',this.abort);
  this.socket.onopen=this.socket.onmessage=this.socket.onerror=this.socket.onclose=null;
  try {this.socket.close();} catch { /* a closing socket already fences this connection */ }
  for (const write of this.pending.values()) write.resolve(null);
  this.incoming=[];this.buffered=0;this.wake?.();
 }
}
