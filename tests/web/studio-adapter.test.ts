import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {StudioAdapter} from '../../apps/web/src/service/studio';
import {modelSelections} from '../../apps/web/src/service/model-catalog';

const result=(data:any,etag:string|null='"3"',status=200)=>({data,etag,status});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
function setup(){
 const requestV2=vi.fn().mockImplementation(async(path:string,options:any)=>{
  if(path==='/studio/projects/p')return result({id:'p',files:['index.html','compositions/clip.html','assets/a.png'],revision:3});
  if(path.startsWith('/studio/projects/p/files/')&&!options.method)return result({content:'<html>persisted file</html>',revision:3});
  return result({accepted:true,revision:4},'"4"');
 });
 const rawV2=vi.fn().mockResolvedValue(new Response('actual bytes',{headers:{'Content-Type':'text/html'}})),request=vi.fn();
 return{studio:new StudioAdapter({requestV2,rawV2,request} as unknown as ProductClient),requestV2,rawV2,request};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();modelSelections.clear();});
it('sends the selected public HF model and refuses an unknown explicit model before creating a run',async()=>{
 const {studio,requestV2}=setup(),cap={capabilityRef:'public-text-6',version:'1',kind:'LLM',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'supplier',modelRef:'m6',title:'Model 6',version:'6'}};
 requestV2.mockImplementation(async(path:string)=>path.startsWith('/model-capabilities')?result({items:[cap],nextCursor:null}):path.endsWith('/runs')?result({id:'task',state:'QUEUED',testMode:false}):path.includes('/events?')?result({items:[],terminal:true,schemaVersion:'1',nextCursor:null}):result({id:'task',state:'SUCCEEDED',testMode:false,plans:[{outputs:[{type:'TEXT',text:'synthetic HF fixture'}]}]}));
 modelSelections.set('hf:LLM',{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,explicit:true});
 const body={businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'agent',messages:[{role:'user',content:'keep this text'}]};const response=await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify(body)});expect(response!.status).toBe(200);await response!.text();expect(requestV2.mock.calls.find(call=>String(call[0]).endsWith('/runs'))?.[1]).toMatchObject({body:{capabilityRef:cap.capabilityRef,capabilityVersion:'1',message:'keep this text',agentId:'agent'}});
 const rejected=await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({...body,capabilityRef:'unknown'})});expect(rejected!.status).toBe(422);expect(requestV2.mock.calls.filter(call=>String(call[0]).endsWith('/runs'))).toHaveLength(1);
});

describe('native HyperFrames project and session projection',()=>{
 it('reads real projects, creates the requested HF card and deletes with its server version',async()=>{
  const {studio,requestV2}=setup();
  requestV2.mockResolvedValueOnce(result({projects:[{id:'p',title:'Saved'}]}));
  expect((await studio.handle('/canvas/hf/projects?type=HYPER_FRAMES',{userId:'forged'})).projects[0].title).toBe('Saved');
  expect(requestV2.mock.calls[0][0]).toBe('/hf/projects?page=1&size=100');
  requestV2.mockResolvedValueOnce(result({id:'p',title:'Created',revision:4},'"4"',201));
  await studio.handle('/canvas/hf/projects/create',{projectId:'p',title:'Created',userId:'forged',teamId:'forged'},'POST');
  expect(requestV2.mock.calls[1][1]).toMatchObject({body:{id:'p',title:'Created'},idempotencyKey:expect.any(String)});
  await studio.handle('/canvas/hf/projects/p',{},'DELETE');
  expect(requestV2.mock.calls[2][1]).toMatchObject({method:'DELETE',etag:'"4"'});
 });
 it('loads every real page for the native unpaged HF project history',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({records:[{id:'p1',title:'Page one'}],hasNext:true})).mockResolvedValueOnce(result({records:[{id:'p2',title:'Page two'}],hasNext:false}));
  expect(await studio.handle('/canvas/hf/projects')).toEqual({projects:[{id:'p1',title:'Page one'},{id:'p2',title:'Page two'}]});expect(requestV2.mock.calls.map(call=>call[0])).toEqual(['/hf/projects?page=1&size=100','/hf/projects?page=2&size=100']);
 });
 it('uses persisted scalar HF conversation and agent IDs while forwarding actual501 failures',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'hf-s',revision:2},'"2"',201)).mockResolvedValueOnce(result({agentId:'studio-agent'}));
  expect(await studio.handle('/canvas/openclaw/business/sessions/create',{businessCode:'HYPER_FRAMES'},'POST')).toBe('hf-s');
  expect(requestV2.mock.calls[0]).toMatchObject(['/conversations',{method:'POST',body:{kind:'HF',title:''}}]);
  expect(await studio.handle('/canvas/openclaw/hf/agents/create',{sessionId:'hf-s'},'POST')).toBe('studio-agent');expect(requestV2.mock.calls[1]).toMatchObject(['/hf/conversations/hf-s/agent',{body:{},idempotencyKey:expect.any(String)}]);
  requestV2.mockRejectedValueOnce(new ApiError(501,'NOT_IMPLEMENTED','HF agent unavailable'));await expect(studio.handle('/canvas/openclaw/hf/agents/create',{sessionId:'hf-s'},'POST')).rejects.toMatchObject({status:501});
 });
 it('lists and persists actual HF session bindings with UUID idempotency',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({records:[{sessionId:'hf-s',title:'Storyboard'}]}));
  const rows=await studio.handle('/canvas/hf/projects/session/list?projectId=p');expect(rows.records[0].sessionId).toBe('hf-s');
  await studio.handle('/canvas/hf/projects/session/create',{projectId:'p',sessionId:'hf-s',teamId:'forged'},'POST');
  expect(requestV2.mock.calls.at(-1)).toMatchObject(['/hf/projects/p/sessions',{method:'POST',body:{sessionId:'hf-s'},idempotencyKey:expect.any(String)}]);
 });
 it('leaves shared history and deletion to the actual assistant adapter without invented HF probes',async()=>{
  const {studio,requestV2}=setup();
  expect(await studio.handle('/canvas/openclaw/sessions/delete',{sessionId:'canvas-s'},'POST')).toBeUndefined();expect(await studio.handle('/canvas/openclaw/sessions/detail',{sessionId:'canvas-s'},'POST')).toBeUndefined();expect(requestV2).not.toHaveBeenCalled();
 });
});

describe('real Studio files, assets and operations',()=>{
 it('keeps text file contents and encoded paths, sends exact If-Match and propagates412',async()=>{
  const {studio,requestV2}=setup(),path='/studio-api/projects/p/files/'+encodeURIComponent('compositions/a b.html');
  expect(await (await studio.fetch(path))!.json()).toMatchObject({content:'<html>persisted file</html>'});
  requestV2.mockResolvedValueOnce(result({content:'<html>new</html>',revision:4},'"4"'));
  expect((await studio.fetch(path,{method:'PUT',body:'<html>new</html>'}))!.status).toBe(200);
  expect(requestV2.mock.calls.at(-1)).toMatchObject(['/studio/projects/p/files/compositions%2Fa%20b.html',{method:'PUT',body:{content:'<html>new</html>',encoding:'utf8',mimeType:'text/html'},etag:'"3"'}]);
  requestV2.mockRejectedValueOnce(new ApiError(412,'VERSION_CONFLICT','Changed in another tab'));
  const conflict=(await studio.fetch(path,{method:'PUT',body:'stale'}))!;expect(conflict.status).toBe(412);expect(await conflict.json()).toMatchObject({error:{code:'VERSION_CONFLICT'}});
  expect(requestV2.mock.calls.at(-1)?.[1].etag).toBe('"4"');
 });
 it('persists new files and directory markers against the loaded server tree',async()=>{
  const {studio,requestV2}=setup();await studio.fetch('/studio-api/projects/p/files/'+encodeURIComponent('assets/fonts/.gitkeep'),{method:'POST',body:''});
  expect(requestV2.mock.calls.at(-1)).toMatchObject(['/studio/projects/p/files/assets%2Ffonts%2F.gitkeep',{method:'POST',body:{content:'',encoding:'utf8',mimeType:'text/plain'},etag:'"3"',idempotencyKey:expect.any(String)}]);
 });
 it('maps rename, delete and duplicate to actual mutations with no local success',async()=>{
  const {studio,requestV2}=setup();await studio.fetch('/studio-api/projects/p/files/index.html',{method:'PATCH',body:JSON.stringify({newPath:'compositions/renamed.html',ownerId:'forged'})});
  expect(requestV2.mock.calls.at(-1)?.[1]).toMatchObject({method:'PATCH',body:{newPath:'compositions/renamed.html'},etag:'"3"'});
  await studio.fetch('/studio-api/projects/p/files/'+encodeURIComponent('compositions/renamed.html'),{method:'DELETE'});
  expect(requestV2.mock.calls.at(-1)?.[1]).toMatchObject({method:'DELETE',etag:'"4"'});
  requestV2.mockResolvedValueOnce(result({path:'index-copy.html'},'"5"'));
  const copy=(await studio.fetch('/studio-api/projects/p/duplicate-file',{method:'POST',body:JSON.stringify({path:'index.html'})}))!;expect(await copy.json()).toEqual({path:'index-copy.html'});
 });
 it('renames and deletes actual directories atomically with the loaded project tree version',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'p',files:['index.html','assets/.gitkeep','assets/fonts/a.woff2'],revision:8},'"8"')).mockResolvedValueOnce(result({id:'p',files:['index.html','media/.gitkeep','media/fonts/a.woff2'],revision:9},'"9"')).mockResolvedValueOnce(result({id:'p',files:['index.html'],revision:10},'"10"'));
  await studio.fetch('/studio-api/projects/p');await studio.fetch('/studio-api/projects/p/files/assets',{method:'PATCH',body:JSON.stringify({newPath:'media'})});await studio.fetch('/studio-api/projects/p/files/media',{method:'DELETE'});
  expect(requestV2.mock.calls.map(call=>call[0])).toEqual(['/studio/projects/p','/studio/projects/p/files/assets','/studio/projects/p/files/media']);expect(requestV2.mock.calls[1][1]).toMatchObject({method:'PATCH',etag:'"8"',body:{newPath:'media'}});expect(requestV2.mock.calls[2][1]).toMatchObject({method:'DELETE',etag:'"9"'});
 });
 it('loads the real directory tree when needed and preserves missing-file404 instead of issuing a delete',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'p',files:['assets/a.png'],revision:8},'"8"')).mockResolvedValueOnce(result({id:'p',files:[],revision:9},'"9"'));
  expect((await studio.fetch('/studio-api/projects/p/files/assets',{method:'DELETE'}))!.status).toBe(200);expect(requestV2.mock.calls[0][0]).toBe('/studio/projects/p');expect(requestV2.mock.calls[1]).toMatchObject(['/studio/projects/p/files/assets',{method:'DELETE',etag:'"8"'}]);
  requestV2.mockRejectedValueOnce(new ApiError(404,'RESOURCE_NOT_FOUND','Missing file'));expect((await studio.fetch('/studio-api/projects/p/files/missing',{method:'DELETE'}))!.status).toBe(404);expect(requestV2.mock.calls[2][1].method).toBeUndefined();expect(requestV2).toHaveBeenCalledTimes(3);
 });
 it('uploads actual multipart files and drops native team/auth headers',async()=>{
  const {studio,requestV2,rawV2}=setup(),form=new FormData();form.append('file',new File(['bytes'],'a.png',{type:'image/png'}));form.append('file',new File(['font'],'a.woff2'));
  rawV2.mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:{files:['assets/a.png','assets/a.woff2']}}),{status:201,headers:{ETag:'"4"'}}));
  const response=(await studio.fetch('/studio-api/projects/p/upload?dir=assets%2Ffonts',{method:'POST',body:form,headers:{Authorization:'Bearer native','X-Team-Id':'forged'}}))!;
  expect(await response.json()).toEqual({files:['assets/a.png','assets/a.woff2']});const [path,options]=rawV2.mock.calls[0];expect(path).toBe('/studio/projects/p/upload?dir=assets%2Ffonts');expect(options.body).toBe(form);expect(options.headers.get('If-Match')).toBe('"3"');expect(options.headers.has('Authorization')).toBe(false);expect(options.headers.has('X-Team-Id')).toBe(false);expect(requestV2).toHaveBeenCalledOnce();
 });
 it('returns real UTF8 and base64 file bytes for preview through the authenticated metadata seam',async()=>{
  const {studio,requestV2,rawV2}=setup();requestV2.mockResolvedValueOnce(result({content:'<html>Actual preview</html>',encoding:'utf8',mimeType:'text/html'})).mockResolvedValueOnce(result({content:'AP8B',encoding:'base64',mimeType:'image/png'}));
  const response=(await studio.fetch('/studio-api/projects/p/preview/comp/compositions/a.html?cache=1',{headers:{'X-Team-Id':'forged'}}))!;
  expect(await response.text()).toBe('<html>Actual preview</html>');expect(response.headers.get('Content-Type')).toBe('text/html');expect(requestV2.mock.calls[0][0]).toBe('/studio/projects/p/files/compositions%2Fa.html');
  const image=(await studio.fetch('/studio-api/projects/p/preview/assets/a.png'))!;expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([0,255,1]);expect(image.headers.get('Content-Type')).toBe('image/png');expect(rawV2).not.toHaveBeenCalled();
 });
 it.each([
  ['/studio-api/projects/p/lint','/studio/projects/p/lint',{findings:[{severity:'error',message:'Real finding',file:'index.html'}]}],
  ['/studio-api/registry/blocks','/studio/registry/blocks',[{name:'real-block',title:'Real'}]],
  ['/studio-api/fonts','/studio/fonts',{fonts:['Actual font']}],
  ['/studio-api/fonts/google','/studio/fonts/google',{fonts:['Catalog font']}],
 ])('projects %s from the real backend response',async(nativePath,studioPath,data)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result(data));expect(await (await studio.fetch(nativePath))!.json()).toEqual(data);expect(requestV2.mock.calls[0][0]).toBe(studioPath);
 });
 it('projects actual terminal render DTOs without restoring active jobs as successful history',async()=>{
  const {studio,requestV2}=setup(),renders=[
   {id:'queued',status:'QUEUED',progress:0,revision:1,createdAt:'2026-10-05T00:00:00Z'},
   {id:'running',status:'RUNNING',progress:0,revision:2,createdAt:'2026-10-05T00:00:00Z'},
   {id:'done',status:'SUCCEEDED',progress:100,filename:'done.mp4',durationMs:2500,revision:3,createdAt:'2026-10-05T00:00:00Z'},
   {id:'failed',status:'FAILED',progress:0,error:'RENDER_FAILED',revision:3,createdAt:'2026-10-05T00:00:00Z'},
   {id:'cancelled',status:'CANCELLED',progress:0,revision:3,createdAt:'2026-10-05T00:00:00Z'},
  ];requestV2.mockResolvedValueOnce(result({renders}));
  const data=await (await studio.fetch('/studio-api/projects/p/renders'))!.json();expect(requestV2.mock.calls[0][0]).toBe('/studio/projects/p/renders');
  const createdAt=Date.parse('2026-10-05T00:00:00Z');expect(data).toEqual({renders:[{...renders[2],createdAt,status:'complete'},{...renders[3],createdAt,filename:'Export failed',status:'failed'},{...renders[4],createdAt,filename:'Export failed',status:'failed'}]});
  // Mirror the frozen history branch: only the successful record can expose
  // completion actions; failed rows never display its rendering progress bar.
  const nativeRows=data.renders.map((row:any)=>({id:row.id,status:row.status==='failed'?'failed':'complete',progress:100}));expect(nativeRows.filter((row:any)=>row.status==='complete').map((row:any)=>row.id)).toEqual(['done']);expect(data.renders.filter((row:any)=>row.status==='failed').every((row:any)=>row.progress===0)).toBe(true);
  expect(data.renders.every((row:any)=>Number.isFinite((Date.now()-row.createdAt)/3600000))).toBe(true);expect(data.renders[1].error).toBe('RENDER_FAILED');expect(data.renders[1]).not.toHaveProperty('artifact');expect(renders[3]).not.toHaveProperty('filename');expect(renders[2].createdAt).toBe('2026-10-05T00:00:00Z');
 });
 it('converts the actual persisted timezone and fractional timestamp without changing successful filenames',async()=>{
  const {studio,requestV2}=setup(),createdAt='2026-10-05T08:12:34.123456+08:00';requestV2.mockResolvedValueOnce(result({renders:[{id:'done',status:'SUCCEEDED',progress:100,filename:'owned-result.webm',createdAt}]}));
  const data=await (await studio.fetch('/studio-api/projects/p/renders'))!.json();expect(data.renders[0]).toMatchObject({filename:'owned-result.webm',createdAt:Date.parse('2026-10-05T00:12:34.123Z'),status:'complete'});
 });
 it.each([undefined,null,'not-a-timestamp','2026-99-99T00:00:00Z',1780000000000])('rejects terminal history with an invalid stored timestamp instead of inventing one: %s',async(createdAt)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({renders:[{id:'failed',status:'FAILED',progress:0,error:'STUDIO_RENDER_FAILED',createdAt}]}));const response=(await studio.fetch('/studio-api/projects/p/renders'))!;expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'INVALID_RESPONSE'}});
 });
 it.each([
  {id:'r',status:'UNKNOWN',progress:0},
  {id:'r',status:'SUCCEEDED',progress:100},
  {id:'r',status:'FAILED',progress:-1},
 ])('rejects render history that lacks a valid persisted state or successful file: %o',async(row)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({renders:[row]}));const response=(await studio.fetch('/studio-api/projects/p/renders'))!;expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'INVALID_RESPONSE'}});
 });
 it('installs real registry files and removes elements using actual file revision',async()=>{
  const {studio,requestV2}=setup();requestV2.mockImplementation(async(path:string,options:any)=>{
   if(path==='/studio/projects/p')return result({id:'p',files:['index.html'],revision:3});
   if(path.endsWith('/registry/install'))return result({written:['compositions/block.html'],block:{name:'real',type:'hyperframes:component'}},'"4"');
   if(options.method==='GET'||!options.method)return result({content:'<div id="x">before</div>',revision:4},'"4"');
   return result({content:'<div>after</div>',revision:5},'"5"');
  });
  const installed=(await studio.fetch('/studio-api/projects/p/registry/install',{method:'POST',body:JSON.stringify({blockName:'real'})}))!;expect((await installed.json()).written).toEqual(['compositions/block.html']);
  const removed=(await studio.fetch('/studio-api/projects/p/file-mutations/remove-element/index.html',{method:'POST',body:JSON.stringify({target:{id:'x',selector:'#x',selectorIndex:0},ownerId:'forged'})}))!;
  expect(await removed.json()).toMatchObject({content:'<div>after</div>'});expect(requestV2.mock.calls.at(-1)?.[1]).toMatchObject({etag:'"4"',body:{target:{id:'x',selector:'#x',selectorIndex:0}}});
 });
 it('keeps an implemented HTML element mutation revision and propagates unsupported selectors',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({path:'compositions/a.html',content:'<div><p>Saved</p></div>',encoding:'utf8',mimeType:'text/html',revision:8},'"8"')).mockResolvedValueOnce(result({content:'<div></div>',revision:9},'"9"')).mockRejectedValueOnce(new ApiError(501,'NOT_IMPLEMENTED','Selector is unsupported'));
  const path='/studio-api/projects/p/file-mutations/remove-element/compositions%2Fa.html',body=JSON.stringify({target:{selector:'div > p',selectorIndex:0}}),changed=(await studio.fetch(path,{method:'POST',body}))!;expect(await changed.json()).toEqual({content:'<div></div>',revision:9});expect(changed.headers.get('ETag')).toBe('"9"');expect(requestV2.mock.calls[1]).toMatchObject(['/studio/projects/p/file-mutations/remove-element/compositions%2Fa.html',{method:'POST',etag:'"8"',body:{target:{selector:'div > p',selectorIndex:0}}}]);
  const unsupported=(await studio.fetch(path,{method:'POST',body:JSON.stringify({target:{selector:'div:has(p)'}})}))!;expect(unsupported.status).toBe(501);expect(requestV2.mock.calls[2][1].etag).toBe('"9"');
 });
 it('creates real render jobs and deletes only the server render record',async()=>{
  const {studio,requestV2}=setup();requestV2.mockImplementation(async(path:string,options:any)=>{
   if(path==='/studio/projects/p')return result({id:'p',files:['index.html'],revision:3});
   if(path.endsWith('/render'))return result({jobId:'render-1'},'"3"',202);
   if(options.method==='DELETE')return result({accepted:true});return result({id:'render-1',status:'SUCCEEDED',progress:100,revision:6},'"6"');
  });
  const response=(await studio.fetch('/studio-api/projects/p/render',{method:'POST',body:JSON.stringify({fps:30,quality:'high',format:'mp4',resolution:'4k',composition:'compositions/a.html',teamId:'forged'})}))!;
  expect(response.status).toBe(202);expect(await response.json()).toEqual({jobId:'render-1'});expect(requestV2.mock.calls[1][1]).toMatchObject({body:{fps:30,quality:'high',format:'mp4',resolution:'4k',composition:'compositions/a.html'},etag:'"3"'});
  await studio.fetch('/studio-api/render/render-1',{method:'DELETE'});expect(requestV2.mock.calls.at(-1)).toMatchObject(['/studio/renders/render-1',{method:'DELETE',etag:'"6"'}]);
 });
 it('keeps the project revision separate from the task revision returned by render submission',async()=>{
  const {studio,requestV2}=setup();requestV2.mockImplementation(async(path:string,options:any)=>{
   if(path==='/studio/projects/p')return result({id:'p',files:['index.html'],revision:9},'"9"');
   if(path.endsWith('/render'))return result({jobId:'render-1'},'"1"',202);
   if(path.endsWith('/files/assets%2F.gitkeep'))return result({path:'assets/.gitkeep',revision:10},'"10"');
   throw new Error('Unexpected request '+path);
  });
  await studio.fetch('/studio-api/projects/p/render',{method:'POST',body:JSON.stringify({fps:30,quality:'standard',format:'mp4'})});
  await studio.fetch('/studio-api/projects/p/files/assets%2F.gitkeep',{method:'POST',body:''});
  expect(requestV2.mock.calls[1]).toMatchObject(['/studio/projects/p/render',{etag:'"9"'}]);expect(requestV2.mock.calls[2]).toMatchObject(['/studio/projects/p/files/assets%2F.gitkeep',{etag:'"9"'}]);
 });
 it('preserves explicit501 and resource404 instead of empty or clean200 responses',async()=>{
  const {studio,requestV2}=setup();requestV2.mockRejectedValueOnce(new ApiError(501,'NOT_IMPLEMENTED','Renderer is unavailable'));
  const response=(await studio.fetch('/studio-api/projects/p/renders'))!;expect(response.status).toBe(501);expect(await response.json()).toEqual({error:{code:'NOT_IMPLEMENTED',message:'Renderer is unavailable'}});
  requestV2.mockRejectedValueOnce(new ApiError(404,'FILE_NOT_FOUND','Missing'));
  expect((await studio.fetch('/studio-api/projects/p/files/missing.json?optional=1'))!.status).toBe(404);
  const unknown=(await studio.fetch('/studio-api/projects/p/invented'))!;expect(unknown.status).toBe(404);expect(requestV2).toHaveBeenCalledTimes(2);
  expect(await studio.fetch('/opencut/local-project')).toBeUndefined();
 });
});

describe('persisted HyperFrames streams and identity cleanup',()=>{
 it('emits actual persisted render progress, then stops on the actual terminal state',async()=>{
  vi.useFakeTimers();const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'r',status:'RUNNING',progress:17,stage:'encode'})).mockResolvedValueOnce(result({id:'r',status:'SUCCEEDED',progress:100}));
  const response=(await studio.fetch('/studio-api/render/r/progress'))!,reader=response.body!.getReader(),decoder=new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('"progress":17');await vi.advanceTimersByTimeAsync(1000);expect(decoder.decode((await reader.read()).value)).toContain('"status":"complete"');expect((await reader.read()).done).toBe(true);expect(requestV2.mock.calls.map(call=>call[0])).toEqual(['/studio/renders/r','/studio/renders/r']);
 });
 it.each(['FAILED','CANCELLED'])('stops persisted %s renders as failed with their actual zero progress',async(status)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'r',projectId:'p',status,progress:0,error:'RENDER_STOPPED',revision:3,testMode:false}));
  const response=(await studio.fetch('/studio-api/render/r/progress'))!,text=await response.text();expect(text).toContain('"status":"failed"');expect(text).toContain('"progress":0');expect(text).toContain('RENDER_STOPPED');expect(text).not.toContain('"status":"complete"');expect(text).not.toContain('"progress":100');expect(requestV2).toHaveBeenCalledOnce();
 });
 it('returns501 before SSE success when the persisted event service is unavailable',async()=>{
  const {studio,requestV2}=setup();requestV2.mockRejectedValueOnce(new ApiError(501,'NOT_IMPLEMENTED','No persisted event service'));
  const response=(await studio.fetch('/studio-api/events'))!;expect(response.status).toBe(501);expect(response.headers.get('Content-Type')).toBe('application/json');
 });
 it('polls implemented owned file events using the last actual sparse sequence cursor',async()=>{
  vi.useFakeTimers();const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({records:[{seq:4,event:'file-change',projectId:'p',path:'index.html',revision:8}],hasMore:true})).mockResolvedValueOnce(result({records:[{seq:99,event:'file-change',projectId:'p',path:'assets/a.woff2',revision:9}],hasMore:false}));
  const response=(await studio.fetch('/studio-api/events'))!,reader=response.body!.getReader(),decoder=new TextDecoder();expect(decoder.decode((await reader.read()).value)).toBe('id: 4\nevent: file-change\ndata: {"projectId":"p","path":"index.html"}\n\n');await vi.advanceTimersByTimeAsync(1000);expect(decoder.decode((await reader.read()).value)).toBe('id: 99\nevent: file-change\ndata: {"projectId":"p","path":"assets/a.woff2"}\n\n');expect(requestV2.mock.calls.map(call=>call[0])).toEqual(['/studio/events?after=0','/studio/events?after=4']);await reader.cancel();
 });
 it('returns the actual backend501 before HF SSE success when execution is unavailable',async()=>{
  const {studio,requestV2}=setup();requestV2.mockRejectedValueOnce(new ApiError(501,'MODEL_ROUTER_NOT_CONFIGURED','测试模型能力尚未配置。'));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'own-agent',previousResponseId:'studio-old',messages:[{role:'user',content:'Old prompt'},{role:'assistant',content:'Old result'},{role:'user',content:'Newest prompt'}],temperature:.7,teamId:'forged'})}))!;
  expect(response.status).toBe(501);expect(await response.json()).toMatchObject({error:{code:'MODEL_ROUTER_NOT_CONFIGURED'}});expect(requestV2).toHaveBeenCalledOnce();
  expect(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'CANVAS'})})).toBeUndefined();
 });
 it('projects actual sequential events to cumulative HF text and commits only persisted final output',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'run-1',state:'SUCCEEDED',testMode:true})).mockResolvedValueOnce(result({items:[{sequence:1,type:'text.delta',data:{delta:'Saved '}},{sequence:2,type:'text.delta',data:{delta:'partial'}}],nextCursor:'2',terminal:true,schemaVersion:'1'})).mockResolvedValueOnce(result({id:'run-1',state:'SUCCEEDED',testMode:true,plans:[{outputs:[{type:'TEXT',text:'Persisted final'},{type:'STRUCTURED',schemaVersion:'hf-project',data:{projectId:'persisted-project',title:'Real project'}}]}]}));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'studio-agent',messages:[{role:'user',content:'Older prompt'},{role:'assistant',content:'Earlier response'},{role:'user',content:'Newest prompt'}],temperature:.7})}))!,text=await response.text();
  expect(text).toContain('"text":"[TEST MODE]\\nSaved partial"');expect(text).toContain('Persisted final');expect(text).toContain('hf-project');expect(text).toContain('persisted-project');expect(text).toContain('data: [DONE]');expect(requestV2.mock.calls[0]).toMatchObject(['/hf/conversations/hf-s/runs',{body:{message:'Newest prompt',agentId:'studio-agent'},idempotencyKey:expect.any(String)}]);expect(requestV2.mock.calls[1][0]).toBe('/assistant-runs/run-1/events?after=0');expect(requestV2.mock.calls[2][0]).toBe('/assistant-runs/run-1');
 });
 it('uses actual HF Task IDs for continuation and treats persisted chat.delta as cumulative text',async()=>{
  vi.useFakeTimers();const {studio,requestV2}=setup();
  requestV2.mockResolvedValueOnce(result({id:'tsk_current',conversationId:'hf-s',kind:'ASSISTANT',state:'QUEUED',revision:1,testMode:true,plans:[{state:'QUEUED',outputs:[]}]}))
   .mockResolvedValueOnce(result({items:[{sequence:1,type:'state.changed',data:{state:'QUEUED'},testMode:true}],nextCursor:'1',terminal:false,schemaVersion:'1'}))
   .mockResolvedValueOnce(result({items:[{sequence:2,type:'state.changed',data:{state:'RUNNING'},testMode:true},{sequence:3,type:'chat.delta',data:{text:'[TEST MODE] Persisted answer',messageId:'msg_current_response'},testMode:true},{sequence:4,type:'state.changed',data:{state:'SUCCEEDED'},testMode:true}],nextCursor:'4',terminal:true,schemaVersion:'1'}))
   .mockResolvedValueOnce(result({id:'tsk_current',conversationId:'hf-s',kind:'ASSISTANT',state:'SUCCEEDED',revision:3,testMode:true,plans:[{state:'SUCCEEDED',outputs:[{id:'out_1',type:'TEXT',text:'[TEST MODE] Persisted answer'}]}]}));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'hfa_persisted',previousResponseId:'tsk_previous',messages:[{role:'user',content:'Saved prompt'}]})}))!,reader=response.body!.getReader(),decoder=new TextDecoder();
  expect(requestV2).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1000);let text='';for(;;){const packet=await reader.read();if(packet.done)break;text+=decoder.decode(packet.value);}
  expect(text).toContain('event: response.created');expect(text).toContain('"response":{"id":"tsk_current"}');expect(text).not.toContain('msg_current_response');expect(text).toContain('event: chat.delta');expect(text).toContain('event: chat.final');expect(text).toContain('"text":"[TEST MODE] Persisted answer"');expect(text).not.toContain('[TEST MODE]\\n[TEST MODE]');expect(text).toContain('data: [DONE]');
  expect(requestV2.mock.calls[0]).toMatchObject(['/hf/conversations/hf-s/runs',{method:'POST',body:{agentId:'hfa_persisted',message:'Saved prompt',previousResponseId:'tsk_previous'},idempotencyKey:expect.any(String)}]);expect(requestV2.mock.calls[2][0]).toBe('/assistant-runs/tsk_current/events?after=1');
 });
 it.each(['FAILED','CANCELED'])('projects actual HF %s terminal state without inventing a final output',async(state)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'tsk_real',state:'QUEUED',testMode:true})).mockResolvedValueOnce(result({items:[{sequence:1,type:'state.changed',data:{state}}],nextCursor:'1',terminal:true,schemaVersion:'1'})).mockResolvedValueOnce(result({id:'tsk_real',state,errorCode:'PERSISTED_STOP',plans:[{outputs:[]}]}));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'hfa_persisted',messages:[{role:'user',content:'Prompt'}]})}))!,text=await response.text();expect(text).not.toContain('event: response.created');expect(text).toContain('event: chat.error');expect(text).toContain('PERSISTED_STOP');expect(text).not.toContain('event: chat.final');expect(text).toContain('data: [DONE]');
 });
 it.each([[404,'CONVERSATION_NOT_FOUND'],[409,'CONVERSATION_CONFLICT'],[412,'VERSION_CONFLICT']])('preserves actual HF run failure %s before returning an SSE response',async(status,code)=>{
  const {studio,requestV2}=setup();requestV2.mockRejectedValueOnce(new ApiError(status,code,'Persisted HF rejection'));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'hfa_persisted',messages:[{role:'user',content:'Prompt'}]})}))!;expect(response.status).toBe(status);expect(response.headers.get('Content-Type')).toBe('application/json');expect(await response.json()).toEqual({error:{code,message:'Persisted HF rejection'}});expect(requestV2).toHaveBeenCalledOnce();
 });
 it('does not manufacture a final answer when a successful run lacks persisted output',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({id:'run-1',state:'SUCCEEDED'})).mockResolvedValueOnce(result({items:[],nextCursor:null,terminal:true,schemaVersion:'1'})).mockResolvedValueOnce(result({id:'run-1',state:'SUCCEEDED',plans:[{outputs:[]}]}));
  const response=(await studio.fetch('/canvas/openclaw/chat',{method:'POST',body:JSON.stringify({businessType:'HYPER_FRAMES',sessionId:'hf-s',agentId:'studio-agent',messages:[{role:'user',content:'Prompt'}]})}))!;expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'HF_OUTPUT_NOT_PERSISTED'}});
 });
 it('rejects a late file read after logout and never reuses its version in a new identity',async()=>{
  const {studio,requestV2}=setup(),late=deferred<ReturnType<typeof result>>();requestV2.mockReturnValueOnce(late.promise);
  const loading=studio.fetch('/studio-api/projects/p/files/index.html'),rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});studio.clear();expect(requestV2.mock.calls[0][1].signal.aborted).toBe(true);late.resolve(result({content:'Private old identity',revision:90},'"90"'));await rejected;
  requestV2.mockResolvedValueOnce(result({content:'New identity',revision:2},'"2"')).mockResolvedValueOnce(result({content:'Save',revision:3},'"3"'));
  await studio.fetch('/studio-api/projects/p/files/index.html',{method:'PUT',body:'Save'});expect(requestV2.mock.calls.at(-1)?.[1].etag).toBe('"2"');
 });
 it('aborts an active file event poll on logout without issuing another request',async()=>{
  vi.useFakeTimers();const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({records:[{seq:5,event:'file-change',projectId:'p',path:'index.html'}],hasMore:false}));
  const response=(await studio.fetch('/studio-api/events'))!,reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain('"path":"index.html"');
  const pending=reader.read(),rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});studio.clear();await rejected;await vi.advanceTimersByTimeAsync(5000);expect(requestV2).toHaveBeenCalledOnce();
 });
 it('does not use a late upload tree version to upload bytes after identity cleanup',async()=>{
  const {studio,requestV2,rawV2}=setup(),late=deferred<ReturnType<typeof result>>(),form=new FormData();form.append('file',new File(['private'],'a.png'));requestV2.mockReturnValueOnce(late.promise);
  const uploading=studio.fetch('/studio-api/projects/p/upload',{method:'POST',body:form}),rejected=expect(uploading).rejects.toMatchObject({code:'SESSION_CHANGED'});studio.clear();late.resolve(result({id:'p',files:[],revision:1}));await rejected;expect(rawV2).not.toHaveBeenCalled();
 });
 it('cancels an already returned media body immediately on logout',async()=>{
  const {studio,rawV2}=setup(),cancel=vi.fn();rawV2.mockResolvedValueOnce(new Response(new ReadableStream({cancel}),{headers:{'Content-Type':'video/mp4'}}));
  const response=(await studio.fetch('/studio-api/projects/p/renders/file/real.mp4?download'))!,reading=response.body!.getReader().read(),rejected=expect(reading).rejects.toMatchObject({name:'AbortError'});studio.clear();await rejected;expect(cancel).toHaveBeenCalledOnce();
 });
});

describe('authenticated native preview navigation',()=>{
 function frame(source:string){let src=source;const element={getAttribute:vi.fn(()=>src),setAttribute:vi.fn((_name:string,value:string)=>{src=value;})};return element as unknown as HTMLIFrameElement;}
 it('uses the shared memory Bearer only for own v2 file reads and never the original host',async()=>{
  const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:{path:'index.html',content:'<html>Own bytes</html>',encoding:'utf8',mimeType:'text/html',revision:1}}),{headers:{ETag:'"1"'}})),api=new ProductClient('/api/v1',transport);api.setAccessToken('own-memory-session');const studio=new StudioAdapter(api);
  const response=(await studio.fetch('https://www.runninghub.ai/studio-api/projects/p/preview',{headers:{Authorization:'Bearer native','X-Team-Id':'forged'}}))!;expect(await response.text()).toBe('<html>Own bytes</html>');expect(transport.mock.calls[0][0]).toBe('/api/v2/studio/projects/p/files/index.html');expect(transport.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer own-memory-session');expect(transport.mock.calls[0][1].headers.has('X-Team-Id')).toBe(false);
 });
 it('hydrates only own signed preview URLs and blanks them on logout',async()=>{
  vi.stubGlobal('location',{origin:'https://studio.local'});const {studio,requestV2}=setup(),element=frame('/studio-api/projects/p/preview/comp/compositions/a.html');requestV2.mockResolvedValueOnce(result({url:'/api/v2/studio/preview/p/grant-1/compositions/a.html',expiresIn:300}));expect(await studio.hydratePreview(element)).toBe(true);expect(requestV2.mock.calls[0]).toMatchObject(['/studio/projects/p/preview-session',{method:'POST',body:{path:'compositions/a.html',composition:true},idempotencyKey:expect.any(String)}]);expect(element.setAttribute).toHaveBeenCalledWith('src','https://studio.local/api/v2/studio/preview/p/grant-1/compositions/a.html');studio.clear();expect(element.setAttribute).toHaveBeenLastCalledWith('src','about:blank');
 });
 it('rejects external preview grants and late signed URLs after logout',async()=>{
  vi.stubGlobal('location',{origin:'https://studio.local'});const {studio,requestV2}=setup(),element=frame('/studio-api/projects/p/preview');requestV2.mockResolvedValueOnce(result({url:'https://vendor.local/preview'}));await expect(studio.hydratePreview(element)).rejects.toMatchObject({code:'UNTRUSTED_PREVIEW_URL'});expect(element.setAttribute).not.toHaveBeenCalled();
  const late=deferred<ReturnType<typeof result>>();requestV2.mockReturnValueOnce(late.promise);const hydration=studio.hydratePreview(element),rejected=expect(hydration).rejects.toMatchObject({code:'SESSION_CHANGED'});studio.clear();late.resolve(result({url:'/api/v2/studio/preview/p/old-grant/index.html',expiresIn:300}));await rejected;expect(element.setAttribute).not.toHaveBeenCalled();
 });
 it.each(['/api/v2/studio/preview/foreign/grant/index.html','/api/v2/studio/preview/p/grant/foreign.html','/api/v2/other','/api/v2/studio/preview/p/grant/index.html?unexpected=yes'])('rejects a grant outside the exact requested own project and file: %s',async url=>{
  vi.stubGlobal('location',{origin:'https://studio.local'});const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({url}));await expect(studio.resolveNavigation('/studio-api/projects/p/preview')).rejects.toMatchObject({code:'UNTRUSTED_PREVIEW_URL'});
 });
 it('hydrates the real native custom player with own wrapper code and disposes it on logout',async()=>{
  vi.stubGlobal('location',{origin:'https://studio.local'});const {studio,requestV2}=setup(),attrs=new Map<string,string>([['src','/studio-api/projects/p/preview']]),surface={addEventListener:vi.fn(),removeEventListener:vi.fn()},nativeFrame={contentWindow:{},addEventListener:vi.fn(),removeEventListener:vi.fn()},element={tagName:'HYPERFRAMES-PLAYER',iframeElement:nativeFrame,ownerDocument:{defaultView:surface},getAttribute:(key:string)=>attrs.get(key)||null,setAttribute:vi.fn((key:string,value:string)=>attrs.set(key,value)),removeAttribute:vi.fn((key:string)=>attrs.delete(key))} as unknown as HTMLElement;
  requestV2.mockResolvedValueOnce(result({url:'/api/v2/studio/preview/p/grant/index.html'}));expect(await studio.hydratePreview(element)).toBe(true);expect(requestV2.mock.calls[0][1].body).toEqual({path:'index.html',composition:true});expect(attrs.get('srcdoc')).toContain('sandbox="allow-scripts"');expect(attrs.get('srcdoc')).not.toContain('persisted file');studio.clear();expect(attrs.get('src')).toBe('about:blank');expect(attrs.has('srcdoc')).toBe(false);expect(surface.removeEventListener).toHaveBeenCalledWith('message',expect.any(Function));
 });
});

describe('persisted render output navigation',()=>{
 const source='/studio-api/projects/p/renders/file/tsk_real.mp4?download',state={id:'tsk_real',projectId:'p',status:'SUCCEEDED',progress:100,filename:'tsk_real.mp4',revision:3},task={id:'tsk_real',kind:'STUDIO',state:'SUCCEEDED',targetId:'p',projectId:'vault_owned',plans:[{outputs:[{type:'ARTIFACT',assetId:'ast_saved',mimeType:'video/mp4'}]}]},asset={id:'ast_saved',projectId:'vault_owned',state:'READY',kind:'VIDEO',mimeType:'video/mp4',downloadUrl:'/storage/assets/ast_saved?token=real-grant'};
 function navigationSetup(){vi.stubGlobal('location',{origin:'https://studio.local'});const value=setup();value.requestV2.mockImplementation(async(path:string)=>{if(path==='/studio/renders/tsk_real')return result(state);if(path==='/tasks/tsk_real')return result(task);throw new Error('Unexpected route '+path);});value.request.mockResolvedValue(result(asset));return value;}
 function element(attribute:'src'|'href',source:string){const attrs=new Map([[attribute,source]]),node={getAttribute:vi.fn((name:string)=>attrs.get(name as 'src'|'href')||null),setAttribute:vi.fn((name:'src'|'href',value:string)=>{attrs.set(name,value);})};return node as unknown as HTMLElement;}
 it('resolves only the actual completed project file through its persisted task and owned READY asset',async()=>{
  const {studio,requestV2,request}=navigationSetup();expect(await studio.resolveNavigation(source)).toBe('https://studio.local/storage/assets/ast_saved?token=real-grant');expect(requestV2.mock.calls.map(call=>call[0])).toEqual(['/studio/renders/tsk_real','/tasks/tsk_real']);expect(request.mock.calls[0]).toMatchObject(['/assets/ast_saved',{signal:expect.any(AbortSignal)}]);
  expect(await studio.resolveNavigation('/opencut/local')).toBeUndefined();expect(await studio.resolveNavigation('/studio-api/projects/p/renders')).toBeUndefined();expect(request).toHaveBeenCalledOnce();
 });
 it.each(['QUEUED','RUNNING','FAILED','CANCELLED'])('rejects actual %s output navigation before requesting any task or asset',async(status)=>{
  const {studio,requestV2,request}=navigationSetup();requestV2.mockResolvedValueOnce(result({...state,status,filename:undefined,progress:0}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({status:409,code:'RENDER_NOT_READY'});expect(requestV2).toHaveBeenCalledOnce();expect(request).not.toHaveBeenCalled();
 });
 it.each([{projectId:'foreign'},{filename:'tsk_other.mp4'},{id:'tsk_other'}])('rejects a render record that does not match the exact native project/file: %o',async(fields)=>{
  const {studio,requestV2,request}=navigationSetup();requestV2.mockResolvedValueOnce(result({...state,...fields}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({status:404,code:'RENDER_NOT_FOUND'});expect(requestV2).toHaveBeenCalledOnce();expect(request).not.toHaveBeenCalled();
 });
 it('rejects a mismatched task and a successful task without an actual materialized output',async()=>{
  const {studio,requestV2,request}=navigationSetup();requestV2.mockResolvedValueOnce(result(state)).mockResolvedValueOnce(result({...task,targetId:'foreign'}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({status:502,code:'INVALID_RENDER_OUTPUT'});expect(request).not.toHaveBeenCalled();
  requestV2.mockResolvedValueOnce(result(state)).mockResolvedValueOnce(result({...task,plans:[{outputs:[{type:'STRUCTURED',schemaVersion:'studio-render/1',data:{filename:'tsk_real.mp4'}}]}]}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({status:501,code:'RENDER_NAVIGATION_UNAVAILABLE'});expect(request).not.toHaveBeenCalled();
 });
 it.each([{state:'PROCESSING'},{projectId:'foreign'},{id:'ast_other'},{mimeType:'text/html'},{kind:'FILE'}])('rejects an output asset with invalid readiness, type or ownership: %o',async(fields)=>{
  const {studio,request}=navigationSetup();request.mockResolvedValueOnce(result({...asset,...fields}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({status:502,code:'INVALID_RENDER_ASSET'});
 });
 it.each(['https://vendor.local/storage/assets/ast_saved?token=grant','https://evil@studio.local/storage/assets/ast_saved?token=grant','/storage/assets/ast_other?token=grant','/storage/assets/ast_saved?token=grant#fragment','/storage/assets/ast_saved','/storage/assets/ast_saved?token=one&token=two','/api/v2/redirect?token=grant'])('rejects an untrusted render navigation URL: %s',async(downloadUrl)=>{
  const {studio,request}=navigationSetup();request.mockResolvedValueOnce(result({...asset,downloadUrl}));await expect(studio.resolveNavigation(source)).rejects.toMatchObject({code:'UNTRUSTED_RENDER_URL'});
 });
 it('hydrates actual video sources and anchor hrefs and blanks their grants on logout',async()=>{
  const {studio}=navigationSetup(),video=element('src',source),anchor=element('href',source);expect(await studio.hydratePreview(video)).toBe(true);expect(await studio.hydratePreview(anchor)).toBe(true);expect(video.setAttribute).toHaveBeenCalledWith('src','https://studio.local/storage/assets/ast_saved?token=real-grant');expect(anchor.setAttribute).toHaveBeenCalledWith('href','https://studio.local/storage/assets/ast_saved?token=real-grant');studio.clear();expect(video.setAttribute).toHaveBeenLastCalledWith('src','about:blank');expect(anchor.setAttribute).toHaveBeenLastCalledWith('href','about:blank');
 });
 it('rejects ignored-abort asset completion after logout and never writes its URL to a source',async()=>{
  const {studio,request}=navigationSetup(),late=deferred<ReturnType<typeof result>>(),video=element('src',source);request.mockReturnValueOnce(late.promise);const loading=studio.hydratePreview(video),rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());studio.clear();expect(request.mock.calls[0][1].signal.aborted).toBe(true);late.resolve(result(asset));await rejected;expect(video.setAttribute).not.toHaveBeenCalled();
 });
 it('uses memory Bearer for actual v2 task reads and v1 asset grants without sending it to signed navigation',async()=>{
  vi.stubGlobal('location',{origin:'https://studio.local'});const transport=vi.fn().mockImplementation(async(path:string)=>{const data=path==='/api/v2/studio/renders/tsk_real'?state:path==='/api/v2/tasks/tsk_real'?task:path==='/api/v1/assets/ast_saved'?asset:undefined;if(!data)throw new Error('Unexpected transport '+path);return new Response(JSON.stringify({code:0,data}));}),api=new ProductClient('/api/v1',transport);api.setAccessToken('memory-only-access');const studio=new StudioAdapter(api);expect(await studio.resolveNavigation(source)).toBe('https://studio.local/storage/assets/ast_saved?token=real-grant');expect(transport).toHaveBeenCalledTimes(3);for(const [path,options] of transport.mock.calls){expect(path).toMatch(/^\/api\/v[12]\//);expect(options.headers.get('Authorization')).toBe('Bearer memory-only-access');expect(options.signal).toBeInstanceOf(AbortSignal);}
 });
 it('leaves other-origin native-shaped navigation unmodified without issuing STUDIO requests',async()=>{
  const {studio,requestV2,request}=navigationSetup();expect(await studio.resolveNavigation('https://foreign.local'+source)).toBeUndefined();expect(await studio.resolveNavigation('https://someone@studio.local'+source)).toBeUndefined();expect(requestV2).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
 });

});

import type {StudioEditDescriptor} from '../../apps/web/src/service/studio-player';
const visualSelection:StudioEditDescriptor={sourceFile:'compositions/title.html',selector:'main:nth-of-type(1) > h1:nth-of-type(1)',selectorIndex:0,tagName:'h1',text:'actual saved title',childCount:0,attributes:{class:'title'},styles:{color:'red'},box:{x:0,y:0,width:100,height:40}};
describe('versioned actual visual Studio edit persistence',()=>{
 it('uses the root project ETag rather than file ETag and UUID idempotency, then returns exact stored bytes',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({content:'original file',revision:2},'"2"')).mockResolvedValueOnce(result({id:'p',files:['compositions/title.html'],revision:9},'"9"')).mockResolvedValueOnce(result({path:'compositions/title.html',content:'canonical saved file',mimeType:'text/html',revision:10},'"10"'));
  expect(await studio.editElement('p',visualSelection,[{type:'text',value:'new title'}])).toEqual({before:'original file',after:'canonical saved file'});expect(requestV2.mock.calls[2]).toMatchObject(['/studio/projects/p/file-mutations/edit/compositions%2Ftitle.html',{method:'POST',etag:'"9"',body:{target:{selector:visualSelection.selector,selectorIndex:0},operations:[{type:'text',value:'new title'}]}}]);expect(requestV2.mock.calls[2][1].idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  requestV2.mockResolvedValueOnce(result({content:'canonical saved file',revision:10},'"10"')).mockResolvedValueOnce(result({path:'compositions/title.html',content:'second saved file',revision:11},'"11"'));await studio.editElement('p',{...visualSelection,domId:'actual-dom-id'},[{type:'style',property:'color',value:'green'}]);expect(requestV2.mock.calls.at(-1)?.[1]).toMatchObject({etag:'"10"',body:{target:{id:'actual-dom-id'}}});expect(requestV2).toHaveBeenCalledTimes(5);
 });
 it.each([404,409,412])('preserves real server%d without inventing a saved edit',async(status)=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({content:'actual before',revision:3})).mockResolvedValueOnce(result({id:'p',files:['compositions/title.html'],revision:3})).mockRejectedValueOnce(new ApiError(status,'ACTUAL_FAILURE','Actual server rejection'));await expect(studio.editElement('p',visualSelection,[{type:'text',value:'changed'}])).rejects.toMatchObject({status,code:'ACTUAL_FAILURE'});
 });
 it('rejects mismatched saved path/ETag and cancels a response after logout',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({content:'actual before',revision:3})).mockResolvedValueOnce(result({id:'p',files:['compositions/title.html'],revision:3})).mockResolvedValueOnce(result({path:'foreign.html',content:'untrusted',revision:4},'"4"'));await expect(studio.editElement('p',visualSelection,[{type:'text',value:'changed'}])).rejects.toMatchObject({code:'INVALID_EDIT_RESPONSE'});
  const pending=deferred<any>();requestV2.mockImplementationOnce(()=>pending.promise);const edit=studio.editElement('p',visualSelection,[{type:'text',value:'late'}]);studio.clear();pending.resolve(result({content:'late actual file',revision:4},'"4"'));await expect(edit).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(requestV2.mock.calls.filter(call=>call[0].includes('file-mutations/edit'))).toHaveLength(1);
 });
});

describe('Studio revision recovery after actual conflict',()=>{
 it('reloads the real root revision on the next user edit after412, without retrying the rejected write',async()=>{
  const {studio,requestV2}=setup();requestV2.mockResolvedValueOnce(result({content:'actual before',revision:3})).mockResolvedValueOnce(result({id:'p',files:['compositions/title.html'],revision:3})).mockRejectedValueOnce(new ApiError(412,'VERSION_CONFLICT','Changed elsewhere'));await expect(studio.editElement('p',visualSelection,[{type:'text',value:'first'}])).rejects.toMatchObject({status:412});
  requestV2.mockResolvedValueOnce(result({content:'other tab actual',revision:8},'"8"')).mockResolvedValueOnce(result({id:'p',files:['compositions/title.html'],revision:8},'"8"')).mockResolvedValueOnce(result({path:'compositions/title.html',content:'second user edit',revision:9},'"9"'));await studio.editElement('p',visualSelection,[{type:'text',value:'second'}]);expect(requestV2.mock.calls.filter(call=>call[0].includes('file-mutations/edit'))).toHaveLength(2);expect(requestV2.mock.calls.at(-1)?.[1]).toMatchObject({etag:'"8"',body:{operations:[{type:'text',value:'second'}]}});
 });
});
