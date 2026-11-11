import {sha256} from '@noble/hashes/sha2.js';

// LAN HTTP lacks randomUUID and SubtleCrypto, but still provides browser CSPRNG.
export function randomUuid(source:Crypto|undefined=globalThis.crypto):string {
 if(typeof source?.randomUUID==='function')return source.randomUUID();
 if(typeof source?.getRandomValues!=='function')throw new Error('浏览器随机数服务不可用，请使用支持的浏览器。');
 const bytes=source.getRandomValues(new Uint8Array(16));
 bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function sha256Hex(bytes:ArrayBuffer|Uint8Array,source:Crypto|undefined=globalThis.crypto):Promise<string> {
 const data=bytes instanceof Uint8Array?Uint8Array.from(bytes):new Uint8Array(bytes);
 const digest=typeof source?.subtle?.digest==='function'
  ?new Uint8Array(await source.subtle.digest('SHA-256',data))
  :sha256(data);
 return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}

// Only text copying is adapted. Image/read APIs and secure-context flags stay native.
export async function copyTextFallback(text:string,doc:Document):Promise<void> {
 if(!doc.body)throw new DOMException('当前页面暂时无法复制。','NotAllowedError');
 const active=doc.activeElement as HTMLElement|null;
 const selection=doc.getSelection();
 const ranges:Range[]=[];
 for(let index=0;selection&&index<selection.rangeCount;index++)ranges.push(selection.getRangeAt(index).cloneRange());
 const anchor=selection?.anchorNode,anchorOffset=selection?.anchorOffset;
 const focus=selection?.focusNode,focusOffset=selection?.focusOffset;
 let control:HTMLInputElement|HTMLTextAreaElement|undefined;
 let controlSelection:{start:number;end:number;direction:'forward'|'backward'|'none'|null}|undefined;
 if(active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA')){
  control=active as HTMLInputElement|HTMLTextAreaElement;
  try{if(control.selectionStart!==null&&control.selectionEnd!==null)controlSelection={start:control.selectionStart,end:control.selectionEnd,direction:control.selectionDirection};}catch{}
 }
 const textarea=doc.createElement('textarea');
 textarea.value=String(text);textarea.readOnly=true;textarea.setAttribute('aria-hidden','true');
 textarea.style.cssText='position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
 try{
  doc.body.appendChild(textarea);textarea.select();
  if(typeof doc.execCommand!=='function'||!doc.execCommand('copy'))throw new DOMException('复制失败，请手动复制。','NotAllowedError');
 }finally{
  textarea.remove();
  if(active){try{active.focus({preventScroll:true});}catch{try{active.focus();}catch{}}}
  if(control&&controlSelection){try{control.setSelectionRange(controlSelection.start,controlSelection.end,controlSelection.direction||undefined);}catch{}}
  if(selection){try{
   selection.removeAllRanges();for(const range of ranges)selection.addRange(range);
   if(ranges.length===1&&anchor&&focus&&typeof selection.setBaseAndExtent==='function')selection.setBaseAndExtent(anchor,anchorOffset!,focus,focusOffset!);
  }catch{}}
 }
}

type BrowserCompatibilityHost={crypto?:Crypto;navigator?:Navigator;document?:Document};
export function installBrowserCompatibility(host:BrowserCompatibilityHost=globalThis):void {
 const source=host.crypto;
 if(source&&typeof source.randomUUID!=='function'&&typeof source.getRandomValues==='function'){
  // Capture getRandomValues without calling the newly installed UUID method recursively.
  const random={getRandomValues:source.getRandomValues.bind(source)} as Crypto;
  Object.defineProperty(source,'randomUUID',{configurable:true,writable:true,value:()=>randomUuid(random)});
 }
 if(!host.navigator||!host.document)return;
 const clipboard=host.navigator.clipboard;
 if(typeof clipboard?.writeText==='function')return;
 const writeText=(text:string)=>copyTextFallback(text,host.document!);
 if(clipboard)Object.defineProperty(clipboard,'writeText',{configurable:true,writable:true,value:writeText});
 else Object.defineProperty(host.navigator,'clipboard',{configurable:true,value:{writeText}});
}
