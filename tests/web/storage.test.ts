import {crc32,deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {videoUploadFileError} from '../../apps/web/src/service/video-input';
import {describe,it,expect,vi} from 'vitest';
import {ApiClient} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
const project={id:'p',name:'Demo',ownerId:'u',teamId:null,coverAssetId:null,pinned:false,revision:1,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'};
const graph={schemaVersion:'1',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}};
const json=(status:number,body:any,etag?:string)=>new Response(JSON.stringify(body),{status,headers:etag?{ETag:etag}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
describe('service authoritative storage',()=>{
 it('requires a preloaded server project and does not auto-create local projects',()=>{
  const storage=new ServiceStorage(new ApiClient('/api/v1',vi.fn()),vi.fn());
  expect(()=>storage.fixture('missing')).toThrow('服务器加载');expect(storage.projects.size).toBe(0);
 });
 it('pauses autosaves after a 412 whose recovery snapshot has not advanced, retaining the local copy',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/snapshot')?json(200,{code:0,data:{projectId:'p',revision:1,graph,updatedAt:project.updatedAt}},'"1"'):json(200,{code:0,data:project},'"1"'));
  const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
  transport.mockResolvedValueOnce(json(412,{code:'VERSION_CONFLICT',message:'conflict'}));
  await expect(storage.save('p',{nodes:[],edges:[],meta:{name:'Modified'}})).rejects.toMatchObject({status:412});
  expect(storage.isBlocked('p')).toBe(true);
  const count=transport.mock.calls.length;
  await expect(storage.save('p',{nodes:[],edges:[]})).rejects.toThrow('正在同步');
  expect(transport.mock.calls.length).toBe(count);
  expect(storage.etags.get('p')).toBe('"1"');
 });
});

it('rejects a late canvas response after identity cleanup without restoring the previous account cache',async()=>{
 const lateProject=deferred<Response>();
 const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/snapshot')?json(200,{code:0,data:{projectId:'p',revision:1,graph,updatedAt:project.updatedAt}},'"1"'):lateProject.promise);
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const loading=storage.loadProject('p');const rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});
 storage.clear();lateProject.resolve(json(200,{code:0,data:project}));
 await rejected;
 expect(storage.projects.size).toBe(0);expect(storage.snapshots.size).toBe(0);expect(storage.etags.size).toBe(0);
 expect(()=>storage.fixture('p')).toThrow('服务器加载');
});

it('discards late media metadata and signed URLs while preserving a new session canvas',async()=>{
 const lateAsset=deferred<Response>(),assetStarted=deferred<void>();
 const signedUrl='https://store.local/old-user?token=old-session';
 const withAsset={...graph,nodes:[{id:'image',type:'image',position:{x:0,y:0},data:{url:'rhtv-asset:ast_old'}}]};
 const transport=vi.fn().mockImplementation(async(path:string)=>{
  if(path==='/api/v1/assets/ast_old'){assetStarted.resolve();return lateAsset.promise;}
  const id=path.includes('/q')?'q':'p';
  if(path.endsWith('/snapshot'))return json(200,{code:0,data:{projectId:id,revision:1,graph:id==='p'?withAsset:graph,updatedAt:project.updatedAt}},'"1"');
  return json(200,{code:0,data:{...project,id,ownerId:id==='p'?'old':'new'}});
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const loading=storage.loadProject('p');const rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await assetStarted.promise;storage.clear();await storage.loadProject('q');
 lateAsset.resolve(json(200,{code:0,data:{id:'ast_old',projectId:'p',state:'READY',downloadUrl:signedUrl,previewUrl:null}}));
 await rejected;
 expect(storage.projects.has('p')).toBe(false);expect(storage.projects.get('q')?.ownerId).toBe('new');
 expect(storage.assets.size).toBe(0);expect(storage.encodeAsset(signedUrl)).toBe(signedUrl);expect(storage.decodeAsset('rhtv-asset:ast_old')).toBe('');
});

it('does not execute an old queued autosave after cleanup',async()=>{
 const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/snapshot')?json(200,{code:0,data:{projectId:'p',revision:1,graph,updatedAt:project.updatedAt}},'"1"'):json(200,{code:0,data:project}));
 const notice=vi.fn(),storage=new ServiceStorage(new ApiClient('/api/v1',transport),notice);await storage.loadProject('p');
 const queued=storage.queueSave('p',{nodes:[],edges:[]});storage.clear();
 await expect(queued).rejects.toMatchObject({code:'SESSION_CHANGED'});
 expect(transport.mock.calls).toHaveLength(2);expect(storage.hasPending()).toBe(false);expect(storage.isBlocked('p')).toBe(false);expect(notice).not.toHaveBeenCalled();
});

it('keeps a new autosave queue and revision when an older same-ID save finishes late',async()=>{
 const firstSave=deferred<Response>(),secondSave=deferred<Response>(),firstStarted=deferred<void>(),secondStarted=deferred<void>();
 let revision=1,puts=0;
 const transport=vi.fn().mockImplementation(async(path:string,options:any)=>{
  if(options.method==='PUT'){puts++;if(puts===1){firstStarted.resolve();return firstSave.promise;}secondStarted.resolve();return secondSave.promise;}
  if(path.endsWith('/snapshot'))return json(200,{code:0,data:{projectId:'p',revision,graph,updatedAt:project.updatedAt}},'"'+revision+'"');
  return json(200,{code:0,data:{...project,revision}});
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
 const oldQueue=storage.queueSave('p',{nodes:[],edges:[],meta:{name:'Old'}});
 const oldRejected=expect(oldQueue).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await firstStarted.promise;storage.clear();revision=5;await storage.loadProject('p');
 const newQueue=storage.queueSave('p',{nodes:[],edges:[],meta:{name:'Current'}});await secondStarted.promise;
 firstSave.resolve(json(200,{code:0,data:{projectId:'p',revision:2,graph,updatedAt:project.updatedAt}},'"2"'));
 await oldRejected;await Promise.resolve();await Promise.resolve();
 expect(storage.hasPending()).toBe(true);expect(storage.wait('p')).toBe(newQueue);expect(storage.etags.get('p')).toBe('"5"');
 secondSave.resolve(json(200,{code:0,data:{projectId:'p',revision:6,graph,updatedAt:project.updatedAt}},'"6"'));
 await newQueue;expect(storage.etags.get('p')).toBe('"6"');expect(storage.projects.get('p')?.revision).toBe(6);
});

it('does not PUT file bytes using an upload grant returned after identity cleanup',async()=>{
 const lateGrant=deferred<Response>(),grantStarted=deferred<void>();
 const transport=vi.fn().mockImplementation(async()=>{grantStarted.resolve();return lateGrant.promise;});
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const uploading=storage.upload(new File([new Uint8Array([1,2,3])],'a.png',{type:'image/png'}),'p');
 const rejected=expect(uploading).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await grantStarted.promise;storage.clear();
 lateGrant.resolve(json(201,{code:0,data:{id:'upl_old',assetId:'ast_old',url:'https://store.local/put-old',headers:{'content-type':'image/png'}}}));
 await rejected;expect(transport.mock.calls).toHaveLength(1);expect(storage.assets.size).toBe(0);
});
it('uploads through the server session, PUT and verified completion before exposing a media URL',async()=>{
 const transport=vi.fn().mockImplementation(async(path:string,options:any)=>{
  if(path==='/api/v1/asset-uploads')return json(201,{code:0,data:{id:'upl_1',assetId:'ast_1',method:'PUT',url:'https://store.local/put',headers:{'content-type':'image/png'}}});
  if(path==='https://store.local/put')return new Response('',{status:200,headers:{ETag:'"object-etag"'}});
  if(path==='/api/v1/asset-uploads/upl_1/complete')return json(200,{code:0,data:{id:'ast_1',projectId:'p',fileName:'a.png',kind:'IMAGE',mimeType:'image/png',byteSize:3,state:'READY',downloadUrl:'https://store.local/get?token=signed',previewUrl:null}});
  throw new Error('unexpected path');
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const file=new File([new Uint8Array([1,2,3])],'a.png',{type:'image/png'});
 expect(await storage.upload(file,'p')).toBe('https://store.local/get?token=signed');
 expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/asset-uploads','https://store.local/put','/api/v1/asset-uploads/upl_1/complete']);
 const initial=transport.mock.calls[0][1];expect(JSON.parse(initial.body)).toMatchObject({projectId:'p',fileName:'a.png',byteSize:3,checksumSha256:'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'});
 expect(initial.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 expect(JSON.parse(transport.mock.calls[2][1].body)).toEqual({etag:'"object-etag"'});
 expect(storage.encodeAsset('https://store.local/get?token=signed')).toBe('rhtv-asset:ast_1');
});

it('materializes a persisted catalog pointer once and stores canonical STUDIO references',async()=>{
 const vendor='https://catalog.invalid/source.png',asset={id:'ast_owned',state:'READY',mimeType:'image/png',downloadUrl:'https://studio.invalid/storage/owned'};
 const transport=vi.fn().mockImplementation(async(path:string)=>path==='/api/v2/catalog/media/materialize'?json(201,{code:0,data:{asset}}):path==='/api/v1/assets/ast_owned'?json(200,{code:0,data:asset}):json(200,{code:0,data:{projectId:'p',revision:2,graph,updatedAt:project.updatedAt}}));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());storage.etags.set('p','"1"');
 storage.registerCatalogMedia(vendor,{family:'characters',resourceId:'char-1',revision:3,path:'/images/0/url'});
 await storage.save('p',{nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:[vendor],params:{imageUrls:[vendor]}}}],edges:[]});
 const imports=transport.mock.calls.filter(call=>call[0]==='/api/v2/catalog/media/materialize');expect(imports).toHaveLength(1);
 expect(JSON.parse(imports[0][1].body)).toEqual({family:'characters',resourceId:'char-1',revision:3,path:'/images/0/url'});
 expect(imports[0][1].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 const saved=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v1/projects/p/snapshot')![1].body);
 expect(saved.graph.nodes[0].data.sourceObjects).toEqual(['rhtv-asset:ast_owned']);expect(JSON.stringify(saved)).not.toContain(vendor);
 storage.clear();expect(storage.encodeAsset(vendor)).toBe(vendor);
});

it('rejects unknown remote media without catalog registration or direct vendor fetching',async()=>{
 const transport=vi.fn(),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn());await expect(storage.resolveAsset('https://untrusted.invalid/file')).rejects.toMatchObject({code:'ASSET_REFERENCE_REQUIRED'});expect(transport).not.toHaveBeenCalled();
});

it('imports actual model media without downloading or rewriting preset metadata',async()=>{
 const url='https://catalog.invalid/style.png',preset={key:'styleLibrary',id:'cinematic_realism',prompt:'cinematic realism',coverUrl:url,referenceImageUrl:url},asset={id:'ast_owned',state:'READY',mimeType:'image/png',downloadUrl:'https://studio.invalid/owned'};
 const transport=vi.fn().mockImplementation(async(path:string)=>path==='/api/v2/catalog/media/materialize'?json(201,{code:0,data:{asset}}):path==='/api/v1/assets/ast_owned'?json(200,{code:0,data:asset}):json(200,{code:0,data:{projectId:'p',revision:2,graph,updatedAt:project.updatedAt}}));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());storage.etags.set('p','"1"');storage.registerCatalogMedia(url,{family:'PROMPT',resourceId:preset.id,revision:1,path:'/preset/referenceImageUrl'});
 const node={id:'n',type:'rh-script',position:{x:0,y:0},data:{presetSelections:[preset],promptSelection:{presetSelections:[preset]}}};
 await storage.prepareGraph({nodes:[node],edges:[]});expect(transport).not.toHaveBeenCalled();
 await storage.save('p',{nodes:[{...node,data:{...node.data,params:{imageUrls:[url]}}}],edges:[]});
 expect(transport.mock.calls.filter(call=>call[0]==='/api/v2/catalog/media/materialize')).toHaveLength(1);
 const saved=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v1/projects/p/snapshot')![1].body);
 expect(saved.graph.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:ast_owned']);
 expect(saved.graph.nodes[0].data.presetSelections).toEqual([preset]);expect(saved.graph.nodes[0].data.promptSelection.presetSelections).toEqual([preset]);
});

it('discards a catalog import returned after logout',async()=>{
 const late=deferred<Response>(),transport=vi.fn().mockImplementation(()=>late.promise),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());
 const vendor='https://catalog.invalid/old.png';storage.registerCatalogMedia(vendor,{family:'characters',resourceId:'c',revision:1,path:'/images/0/url'});
 const pending=storage.resolveAsset(vendor),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});storage.clear();late.resolve(json(201,{code:0,data:{asset:{id:'old',state:'READY',downloadUrl:'https://studio.invalid/old'}}}));await rejected;expect(storage.assets.size).toBe(0);expect(storage.encodeAsset(vendor)).toBe(vendor);expect(transport).toHaveBeenCalledOnce();
});

it('uploads actual supported 3D or Skill file bytes through the authenticated file extension',async()=>{
 const transport=vi.fn().mockResolvedValue(json(201,{code:0,data:{id:'file1',kind:'FILE',state:'READY',mimeType:'text/markdown',downloadUrl:'https://studio.invalid/storage/file1'}})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());
 expect(await storage.upload(new File(['# Skill\nreal content'],'SKILL.md',{type:'text/markdown'}),'p')).toBe('https://studio.invalid/storage/file1');
 const [path,init]=transport.mock.calls[0];expect(path).toBe('/api/v2/file-assets');expect(init.body).toBeInstanceOf(FormData);expect(init.headers.get('Authorization')).toBe('Bearer owner');expect(init.headers.has('Content-Type')).toBe(false);expect(init.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);expect(init.body.get('projectId')).toBe('p');expect(await init.body.get('file').text()).toBe('# Skill\nreal content');expect(storage.encodeAsset('https://studio.invalid/storage/file1')).toBe('rhtv-asset:file1');
});

it.each([['mesh.obj','v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],['mesh.FBX','; FBX 7.4.0 project file\nObjects: { Model: 1, "Model::Cube", "Mesh" {} }']])('routes %s to the owner-checked file parser instead of the image/audio upload flow',async(name,content)=>{
 const transport=vi.fn().mockResolvedValue(json(201,{code:0,data:{id:'mesh1',projectId:'p',kind:'FILE',state:'READY',mimeType:'application/octet-stream',downloadUrl:'https://studio.invalid/storage/mesh1'}})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());
 await storage.upload(new File([content],name,{type:'application/octet-stream'}),'p');
 expect(transport).toHaveBeenCalledOnce();const [path,init]=transport.mock.calls[0];expect(path).toBe('/api/v2/file-assets');expect(await init.body.get('file').text()).toBe(content);expect(init.body.get('projectId')).toBe('p');expect(storage.encodeAsset('https://studio.invalid/storage/mesh1')).toBe('rhtv-asset:mesh1');
});

it('rejects unimplemented project folder semantics before creating a false root listing',async()=>{
 const transport=vi.fn(),storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await expect(storage.list({folderId:'folder'})).rejects.toMatchObject({status:501,code:'PROJECT_FOLDERS_UNAVAILABLE'});await expect(storage.list({querySortBy:'UPDATE_TIME',querySortOrder:'ASC'})).rejects.toMatchObject({status:501,code:'PROJECT_SORT_UNAVAILABLE'});expect(transport).not.toHaveBeenCalled();
});


// Real, uncompressed 8-bit grayscale PNG just above the common reference limit.
function uncompressedReference(){
 const chunk=(name:string,body:Buffer)=>{
  const tag=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);
  head.writeUInt32BE(body.length);tail.writeUInt32BE(crc32(body,crc32(tag)));
  return Buffer.concat([head,tag,body,tail]);
 };
 const width=3072,height=3584,ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;
 return new File([Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),
  chunk('IDAT',deflateSync(Buffer.alloc((width+1)*height),{level:0})),chunk('IEND',Buffer.alloc(0))])],'透明场景.png',{type:'image/png',lastModified:123});
}

it('uploads one optimized reference with matching signed metadata, bytes, hash and generation facts',async()=>{
 const original=uncompressedReference(),cap={testMode:false,parameterSchema:{'x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576,mimeTypes:['image/png']}}}}} as any;
 expect(videoUploadFileError(cap,original)).toContain('10 MiB');
 let declaration:any,stored:File|undefined;
 const transport=vi.fn(async(path:string,options:any)=>{
  if(path==='/api/v1/asset-uploads'){
   declaration=JSON.parse(options.body);
   return json(201,{code:0,data:{id:'upload',url:'https://store.local/put',headers:{'Content-Type':declaration.mimeType}}});
  }
  if(path==='https://store.local/put'){
   stored=options.body;expect(options.credentials).toBe('omit');return new Response('',{headers:{ETag:'etag'}});
  }
  if(path==='/api/v1/asset-uploads/upload/complete'||path==='/api/v1/assets/png')return json(200,{code:0,data:{id:'png',kind:'IMAGE',state:'READY',...declaration,downloadUrl:'https://store.local/image'}});
  throw new Error('Unexpected upload call');
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const validate=vi.fn((prepared:File)=>{expect(videoUploadFileError(cap,prepared)).toBeNull();});
 const url=await storage.upload(original,'p',undefined,{validate});
 expect(stored).toBeDefined();expect(validate.mock.calls[0][0]).toBe(stored);
 expect(stored!.size).toBeLessThan(10*1048576);expect(original.size).toBeGreaterThan(10*1048576);
 expect(declaration).toMatchObject({projectId:'p',fileName:original.name,mimeType:stored!.type,byteSize:stored!.size,checksumSha256:createHash('sha256').update(Buffer.from(await stored!.arrayBuffer())).digest('hex')});
 expect(transport).toHaveBeenCalledTimes(3);
 expect(await storage.resolveAsset(url)).toMatchObject({id:'png',byteSize:stored!.size,mimeType:'image/png'});
 expect(transport.mock.calls[3][0]).toBe('/api/v1/assets/png');
});

it('applies model-specific limits only on attachment uploads and admits the same file on the general canvas',async()=>{
 const file=new File([new Uint8Array(10*1048576+1)],'photo.jpg',{type:'image/jpeg'});
 const cap={testMode:false,inputKinds:['IMAGE'],parameterSchema:{'x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576}}}}} as any;
 const transport=vi.fn(async(path:string)=>{if(path==='/api/v1/asset-uploads')return json(201,{code:0,data:{id:'u',url:'https://store.local/signed',headers:{}}});
  if(path==='https://store.local/signed')return new Response('',{headers:{ETag:'etag'}});
  return json(200,{code:0,data:{id:'p1',projectId:'p',kind:'IMAGE',mimeType:file.type,byteSize:file.size,state:'READY',downloadUrl:'https://store.local/img'}});
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 await expect(storage.upload(file,'p',undefined,{validate:prepared=>{const message=videoUploadFileError(cap,prepared);if(message)throw Error(message);}})).rejects.toThrow('10 MiB');
 expect(transport).not.toHaveBeenCalled();
 await storage.upload(file,'p');expect(transport).toHaveBeenCalledTimes(3);
});

it('cancels in-flight image preparation without registering or uploading bytes after logout',async()=>{
 const file=uncompressedReference(),storage=new ServiceStorage(new ApiClient('/api/v1',vi.fn()),vi.fn());
 const pending=storage.upload(file,'p');storage.clear();
 await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
 expect(storage.assets.size).toBe(0);
});
it('does not complete a canceled PUT',async()=>{
 const gate=deferred<Response>(),started=deferred<void>(),control=new AbortController();
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/asset-uploads')return json(201,{code:0,data:{id:'u',url:'https://store.local/put',headers:{}}});
  expect(init.signal).toBe(control.signal);started.resolve();return gate.promise;
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());
 const pending=storage.upload(new File(['w'],'a.wav',{type:'audio/x-wav'}),'p',undefined,{signal:control.signal});
 await started.promise;control.abort();gate.resolve(new Response('',{headers:{ETag:'etag'}}));
 await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(transport).toHaveBeenCalledTimes(2);
 expect(JSON.parse(transport.mock.calls[0][1].body).mimeType).toBe('audio/wav');
 expect(storage.assets.size).toBe(0);
});
