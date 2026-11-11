import {afterEach,describe,it,expect,vi} from 'vitest';
import {createHash,webcrypto} from 'node:crypto';
import {copyTextFallback,installBrowserCompatibility,randomUuid,sha256Hex} from '../../apps/web/src/browser-compat';
import {ApiClient} from '../../apps/web/src/api/client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

afterEach(()=>vi.unstubAllGlobals());
const lanCrypto=()=>({getRandomValues:webcrypto.getRandomValues.bind(webcrypto)} as Crypto);
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function documentFixture(copy:()=>boolean=()=>true){
 const anchor={} as Node,focus={} as Node,clone={} as Range;
 const range={cloneRange:vi.fn(()=>clone)};
 const selection={rangeCount:1,anchorNode:anchor,anchorOffset:4,focusNode:focus,focusOffset:1,getRangeAt:vi.fn(()=>range),removeAllRanges:vi.fn(),addRange:vi.fn(),setBaseAndExtent:vi.fn()};
 const active={tagName:'TEXTAREA',selectionStart:2,selectionEnd:5,selectionDirection:'backward',focus:vi.fn(),setSelectionRange:vi.fn()};
 const textarea={value:'',readOnly:false,style:{cssText:''},setAttribute:vi.fn(),select:vi.fn(()=>{selection.rangeCount=0;}),remove:vi.fn()};
 const doc={activeElement:active,getSelection:vi.fn(()=>selection),createElement:vi.fn(()=>textarea),body:{appendChild:vi.fn()},execCommand:vi.fn(copy)} as unknown as Document;
 return{doc,active,textarea,selection,anchor,focus,clone};
}

describe('LAN HTTP browser compatibility',()=>{
 it('uses browser randomness to generate UUID v4 when randomUUID is missing',()=>{
  const source=lanCrypto(),seen=new Set<string>();
  for(let index=0;index<64;index++){const id=randomUuid(source);expect(id).toMatch(uuidPattern);seen.add(id);}
  expect(seen.size).toBe(64);
  expect(()=>randomUuid({} as Crypto)).toThrow('随机数服务不可用');
 });
 it('installs only missing UUID and text copy methods without pretending to be secure or adding other crypto/clipboard APIs',()=>{
  const source=lanCrypto(),nav={} as Navigator,{doc}=documentFixture();
  const host={crypto:source,navigator:nav,document:doc,isSecureContext:false};
  installBrowserCompatibility(host);
  expect(source.randomUUID()).toMatch(uuidPattern);expect(source.subtle).toBeUndefined();
  expect(nav.clipboard.writeText).toBeTypeOf('function');expect(nav.clipboard.read).toBeUndefined();expect(nav.clipboard.write).toBeUndefined();
  expect(host.isSecureContext).toBe(false);
  const uuid=source.randomUUID,copy=nav.clipboard.writeText;
  installBrowserCompatibility(host);expect(source.randomUUID).toBe(uuid);expect(nav.clipboard.writeText).toBe(copy);
 });
 it('preserves native UUID, SubtleCrypto and Clipboard objects and methods',()=>{
  const uuid=vi.fn(()=>'876bda1e-8e09-4dc8-a74e-b6c82a1b7c88'),digest=vi.fn(),writeText=vi.fn(async()=>{}),write=vi.fn();
  const source={randomUUID:uuid,subtle:{digest},getRandomValues:vi.fn()} as unknown as Crypto;
  const clipboard={writeText,write},nav={clipboard} as unknown as Navigator,{doc}=documentFixture();
  installBrowserCompatibility({crypto:source,navigator:nav,document:doc});
  expect(source.randomUUID).toBe(uuid);expect(source.subtle.digest).toBe(digest);expect(nav.clipboard).toBe(clipboard);expect(nav.clipboard.writeText).toBe(writeText);expect(nav.clipboard.write).toBe(write);
  expect(randomUuid(source)).toBe('876bda1e-8e09-4dc8-a74e-b6c82a1b7c88');expect(uuid).toHaveBeenCalledOnce();expect(doc.execCommand).not.toHaveBeenCalled();
 });
 it('copies real text and restores focus, input selection and backward DOM selection',async()=>{
  const fixture=documentFixture(),{doc,active,textarea,selection,anchor,focus,clone}=fixture;
  await copyTextFallback('Studio TV · 文本',doc);
  expect(textarea.value).toBe('Studio TV · 文本');expect(doc.execCommand).toHaveBeenCalledWith('copy');expect(doc.body.appendChild).toHaveBeenCalledWith(textarea);
  expect(textarea.remove).toHaveBeenCalledOnce();expect(active.focus).toHaveBeenCalledWith({preventScroll:true});expect(active.setSelectionRange).toHaveBeenCalledWith(2,5,'backward');
  expect(selection.addRange).toHaveBeenCalledWith(clone);expect(selection.setBaseAndExtent).toHaveBeenCalledWith(anchor,4,focus,1);
 });
 it('rejects unsupported or denied copying and still restores focus and selection',async()=>{
  const denied=documentFixture(()=>false);
  await expect(copyTextFallback('Do not claim copied',denied.doc)).rejects.toMatchObject({name:'NotAllowedError'});
  expect(denied.textarea.remove).toHaveBeenCalledOnce();expect(denied.active.focus).toHaveBeenCalledOnce();expect(denied.active.setSelectionRange).toHaveBeenCalledWith(2,5,'backward');
  const thrown=documentFixture(()=>{throw new Error('browser denied');});
  await expect(copyTextFallback('Do not claim copied',thrown.doc)).rejects.toThrow('browser denied');expect(thrown.textarea.remove).toHaveBeenCalledOnce();expect(thrown.active.focus).toHaveBeenCalledOnce();
  const unavailable=documentFixture();Object.assign(unavailable.doc,{execCommand:undefined});
  await expect(copyTextFallback('No copy API',unavailable.doc)).rejects.toMatchObject({name:'NotAllowedError'});
 });
 it('exposes the same actual fallback behavior through native text copy calls',async()=>{
  const nav={} as Navigator,{doc,textarea}=documentFixture();installBrowserCompatibility({navigator:nav,document:doc});
  await nav.clipboard.writeText('Native text node');expect(textarea.value).toBe('Native text node');expect(doc.execCommand).toHaveBeenCalledOnce();
  const failedNav={} as Navigator,failed=documentFixture(()=>false);installBrowserCompatibility({navigator:failedNav,document:failed.doc});
  await expect(failedNav.clipboard.writeText('Native failed copy')).rejects.toMatchObject({name:'NotAllowedError'});
 });
 it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq','248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
 ])('matches known SHA-256 vector %j with no SubtleCrypto',async(text,expected)=>{
  expect(await sha256Hex(new TextEncoder().encode(text),lanCrypto())).toBe(expected);
 });
 it('matches Node standard SHA-256 over binary, sliced bytes and multiblock payloads',async()=>{
  const inputs=[new Uint8Array([0,255,1,128]),new Uint8Array([77,1,2,3,88]).subarray(1,4),new TextEncoder().encode('Studio TV · 图形'.repeat(1024))];
  for(const bytes of inputs)expect(await sha256Hex(bytes,lanCrypto())).toBe(createHash('sha256').update(bytes).digest('hex'));
 });
 it('uses available native digest and preserves native failures instead of hiding them',async()=>{
  const bytes=new Uint8Array([1,2,3]),digest=vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle));
  expect(await sha256Hex(bytes,{subtle:{digest}} as unknown as Crypto)).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(digest).toHaveBeenCalledWith('SHA-256',bytes);
  const denied=vi.fn(async()=>{throw new Error('native digest failed');});
  await expect(sha256Hex(bytes,{subtle:{digest:denied}} as unknown as Crypto)).rejects.toThrow('native digest failed');
 });
 it('uploads through unchanged server protocol with neither randomUUID nor SubtleCrypto',async()=>{
  vi.stubGlobal('crypto',lanCrypto());
  const json=(status:number,data:unknown)=>new Response(JSON.stringify({code:0,data}),{status});
  const transport=vi.fn().mockImplementation(async(path:string)=>{
   if(path==='/api/v1/asset-uploads')return json(201,{id:'upl_lan',url:'/api/v1/signed-upload',headers:{'content-type':'image/png'}});
   if(path==='/api/v1/signed-upload')return new Response('',{status:200,headers:{ETag:'"stored-etag"'}});
   if(path==='/api/v1/asset-uploads/upl_lan/complete')return json(200,{id:'ast_lan',projectId:'prj_lan',state:'READY',downloadUrl:'/api/v1/signed-media'});
   throw new Error('unexpected path');
  });
  const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
  expect(await storage.upload(new File([new Uint8Array([1,2,3])],'a.png',{type:'image/png'}),'prj_lan')).toBe('/api/v1/signed-media');
  const first=transport.mock.calls[0][1];expect(JSON.parse(first.body).checksumSha256).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  expect(first.headers.get('Idempotency-Key')).toMatch(uuidPattern);expect(transport.mock.calls[2][1].headers.get('Idempotency-Key')).toMatch(uuidPattern);
  expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/asset-uploads','/api/v1/signed-upload','/api/v1/asset-uploads/upl_lan/complete']);
 });
});
