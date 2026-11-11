import {randomUuid} from '../browser-compat';
import type {CanvasOperationJournal} from './canvas-operations';

/** A Web Lock identifies a live document, not the editor of the canvas. This
 * lets concurrent tabs recover closed-tab batches without adopting live edits.
 * Row payloads and operation IDs stay immutable for server receipt lookup. */
export class CanvasPageOutbox implements CanvasOperationJournal {
 private readonly logical:string;
 private readonly physical:string;
 private readonly marker:string;
 private aliases=new Map<string,string>();
 private releases=new Map<string,()=>void>();
 private ownReady:Promise<boolean>;
 private lockless=false;
 private closed=false;
 private generation=0;
 constructor(private raw:CanvasOperationJournal,user:string,project:string,private page:string,private locks:Pick<LockManager,'request'>|undefined,private surface?:Window){
  this.logical='studiotv:canvas-operations:1:'+user+':'+project+':';
  this.physical='studiotv:page-operations:2:'+user+':'+project+':';
  this.marker='studiotv:outbox-owner:2:'+user+':'+project+':';
  this.ownReady=this.holdPage();
  surface?.addEventListener?.('pagehide',this.leave);surface?.addEventListener?.('pageshow',this.back);
 }
 private claim(owner:string){
  if(this.releases.has(owner))return Promise.resolve(true);
  const locks=this.locks;if(!locks)return Promise.resolve(false);
  const generation=this.generation;return new Promise<boolean>(ready=>{
   void locks.request(this.marker+owner,{ifAvailable:true},async lock=>{
    if(!lock||this.closed||generation!==this.generation){ready(false);return;}
    await new Promise<void>(done=>{this.releases.set(owner,done);ready(true);});
   }).catch(()=>ready(false));
  }).catch(()=>false);
 }
 private async holdPage(){
  const generation=this.generation,acquired=await this.claim(this.page);
  if(!this.closed&&generation===this.generation&&!acquired){this.lockless=true;try{this.raw.setItem(this.marker+this.page,'live');}catch{/* The journal records persistence failures on write. */}}
  return acquired;
 }
 private leave=()=>{
  this.closed=true;this.generation++;
  if(this.lockless){try{if(this.hasPhysical(this.page))this.raw.setItem(this.marker+this.page,'closed');else this.raw.removeItem(this.marker+this.page);}catch{}}
  for(const release of this.releases.values())release();this.releases.clear();
 };
 private back=()=>{if(this.closed){this.closed=false;this.lockless=false;this.page=randomUuid();this.ownReady=this.holdPage();}};
 dispose(){this.surface?.removeEventListener?.('pagehide',this.leave);this.surface?.removeEventListener?.('pageshow',this.back);this.leave();}
 private hasPhysical(owner:string){for(let i=0;i<this.raw.length;i++)if(this.raw.key(i)?.startsWith(this.physical+owner+':'))return true;return false;}
 private ownerKey(k:string){const parts=k.slice(this.physical.length).split(':');return parts.length===2&&/^[A-Za-z0-9_-]{1,64}$/.test(parts[0])&&/^[A-Za-z0-9_-]{1,64}$/.test(parts[1])?{owner:parts[0],batch:parts[1]}:null;}
 async claimRecoverable(){
  await this.ownReady;if(this.closed)return;
  try{
  const others=new Set<string>();for(let i=0;i<this.raw.length;i++){const key=this.raw.key(i);if(!key?.startsWith(this.physical))continue;const owner=this.ownerKey(key)?.owner;if(owner&&owner!==this.page)others.add(owner);}
  for(const owner of others){
   const fallback=this.raw.getItem(this.marker+owner);
   if(fallback==='live')continue;
   if(this.locks&&!this.lockless){await this.claim(owner);continue;}
   // Without Web Locks, only an explicitly closed page can be recovered.
   // Concurrent recoverers still use the same server idempotency receipt.
   if(fallback==='closed')this.releases.set(owner,()=>{});
  }
  }catch{/* Restricted browser storage must not prevent editing in memory. */}
 }
 get length(){return this.raw.length;}
 key=(i:number)=>{
  const key=this.raw.key(i);if(!key?.startsWith(this.physical))return key;
  const parts=this.ownerKey(key);if(!parts||(parts.owner!==this.page&&!this.releases.has(parts.owner)))return null;
  const logical=this.logical+parts.batch;this.aliases.set(logical,key);return logical;
 };
 private actual(key:string){return this.aliases.get(key)??(key.startsWith(this.logical)&&this.raw.getItem(key)===null?this.physical+this.page+':'+key.slice(this.logical.length):key);}
 getItem=(key:string)=>this.raw.getItem(this.actual(key));
 setItem=(key:string,value:string)=>{
  const actual=this.actual(key);this.raw.setItem(actual,value);
  // A history restore allocates a new owner while another page may recover
  // the old one. The receipt still belongs to the original immutable row.
  // Keep its physical address even when that owner is now held elsewhere.
  if(actual.startsWith(this.physical))this.aliases.set(key,actual);
 };
 removeItem=(key:string)=>{const actual=this.actual(key);this.raw.removeItem(actual);this.aliases.delete(key);};
 releaseRecovered(){
  for(const [owner,release]of this.releases){if(owner===this.page)continue;this.releases.delete(owner);release();try{if(!this.hasPhysical(owner))this.raw.removeItem(this.marker+owner);}catch{}}
 }
}
