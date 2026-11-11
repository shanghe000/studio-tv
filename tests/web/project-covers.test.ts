import {expect,it,vi} from 'vitest';
import {ApiClient} from '../../apps/web/src/api/client';
import type {Asset,Project} from '../../apps/web/src/api/types';
import {OrganizationAdapter} from '../../apps/web/src/service/organization';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {META_NODE} from '../../apps/web/src/service/graph';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const project:Project={id:'p',name:'Saved work',ownerId:'owner',teamId:null,coverAssetId:null,pinned:false,revision:4,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z'};
const graph=(ids:string[])=>({schemaVersion:'1',nodes:ids.map((id,index)=>({id:'node-'+index,type:'rh-image',position:{x:index,y:0},data:{url:'rhtv-asset:'+id}})),edges:[],viewport:{x:0,y:0,zoom:1}});
const snapshot=(value:any)=>({projectId:'p',revision:4,graph:value,updatedAt:project.updatedAt});
const asset=(id:string,changes:Partial<Asset>={}):Asset=>({id,projectId:'p',fileName:id+'.png',kind:'IMAGE',mimeType:'image/png',byteSize:10,state:'READY',previewUrl:'https://studio.test/storage/assets/'+id+'?token=preview',downloadUrl:'https://studio.test/storage/assets/'+id+'?token=download',urlsExpireAt:'2026-10-05T00:15:00Z',...changes});
const reply=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"4"'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}

it('preloads an explicit cover outside the graph before exposing a synchronous native fixture',async()=>{
 const cover=deferred<Response>(),started=deferred<void>(),saved={...project,coverAssetId:'selected'},actual=asset('selected');
 const transport=vi.fn(async(path:string)=>{
  if(path==='/api/v1/assets/selected'){started.resolve();return cover.promise;}
  if(path.endsWith('/snapshot'))return reply(snapshot(graph([])));
  return reply(saved);
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn()),loading=storage.loadProject('p');
 await started.promise;expect(()=>storage.fixture('p')).toThrow('服务器加载');cover.resolve(reply(actual));await loading;
 expect(storage.nativeRow(storage.projects.get('p')!)).toMatchObject({thumbnail:actual.previewUrl,cover:actual.previewUrl,createdTime:Date.parse(project.createdAt),updatedTime:Date.parse(project.updatedAt)});
 expect(storage.fixture('p').meta).toMatchObject({id:'p',name:project.name});
 expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/projects/p','/api/v1/projects/p/snapshot','/api/v1/assets/selected']);
});

it('projects the first real saved READY image without persisting a guessed cover or using unrelated media',async()=>{
 const savedGraph:any=graph(['video','pending','audio','no-url','wrong-mime','first','second']);
 savedGraph.nodes.unshift({id:META_NODE,type:'__rhtv_meta',position:{x:0,y:0},data:{version:'1',meta:{cover:'rhtv-asset:metadata-only'},edges:{}}});
 savedGraph.nodes.push({id:'external',type:'rh-image',position:{x:0,y:0},data:{url:'https://external.invalid/unverified.png'}});
 const assets:Record<string,Asset>={video:asset('video',{kind:'VIDEO',mimeType:'video/mp4'}),pending:asset('pending',{state:'PROCESSING'}),audio:asset('audio',{kind:'AUDIO',mimeType:'audio/wav'}),'no-url':asset('no-url',{previewUrl:null,downloadUrl:null}),'wrong-mime':asset('wrong-mime',{mimeType:'video/mp4'}),first:asset('first',{previewUrl:null}),second:asset('second'),'metadata-only':asset('metadata-only')};
 const transport=vi.fn(async(path:string)=>path.includes('/assets/')?reply(assets[path.split('/').at(-1)!]):path.endsWith('/snapshot')?reply(snapshot(savedGraph)):reply(project));
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());storage.assets.set('unrelated',asset('unrelated'));await storage.loadProject('p');
 const row=storage.nativeRow(storage.projects.get('p')!);
 expect(row).toMatchObject({coverAssetId:null,thumbnail:assets.first.downloadUrl,nodesCount:8});
 expect(storage.projects.get('p')?.coverAssetId).toBeNull();expect(storage.snapshots.get('p')?.graph).toEqual(savedGraph);
 expect(transport.mock.calls.every(call=>!call[1]||!call[1].method||call[1].method==='GET')).toBe(true);
});

it('keeps the persisted cover ahead of a graph fallback and resolves a repeated asset only once',async()=>{
 const saved={...project,coverAssetId:'selected'},savedGraph=graph(['fallback','selected','selected']),assets={fallback:asset('fallback'),selected:asset('selected')};
 const transport=vi.fn(async(path:string)=>path.includes('/assets/')?reply(assets[path.split('/').at(-1)! as keyof typeof assets]):path.endsWith('/snapshot')?reply(snapshot(savedGraph)):reply(saved));
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
 expect(storage.nativeRow(storage.projects.get('p')!).thumbnail).toBe(assets.selected.previewUrl);
 expect(transport.mock.calls.filter(call=>call[0]==='/api/v1/assets/selected')).toHaveLength(1);
 storage.assets.set('selected',{...assets.selected,state:'REJECTED'});
 expect(storage.nativeRow(storage.projects.get('p')!).thumbnail).toBe('');
});

it('leaves empty and non-image projects without fabricated thumbnails',async()=>{
 const transport=vi.fn(async(path:string)=>path.includes('/assets/')?reply(asset('video',{kind:'VIDEO',mimeType:'video/mp4'})):path.endsWith('/snapshot')?reply(snapshot(graph(['video']))):reply(project));
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
 expect(storage.nativeRow(storage.projects.get('p')!).thumbnail).toBe('');
 storage.snapshots.get('p')!.graph.nodes=[];expect(storage.nativeRow(project).thumbnail).toBe('');
});

it('shares simultaneous preloads but renews project and signed cover URLs on later visits',async()=>{
 const initial=deferred<Response>(),started=deferred<void>();let reads=0;
 const transport=vi.fn(async(path:string)=>{
  if(path==='/api/v1/projects/p'){reads++;if(reads===1){started.resolve();return initial.promise;}return reply({...project,coverAssetId:'selected'});}
  if(path.endsWith('/snapshot'))return reply(snapshot(graph([])));
  return reply(asset('selected',{previewUrl:'https://studio.test/storage/assets/selected?token=visit-'+reads}));
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn()),first=storage.loadProject('p');await started.promise;
 expect(storage.loadProject('p')).toBe(first);initial.resolve(reply({...project,coverAssetId:'selected'}));await first;
 expect(storage.nativeRow(storage.projects.get('p')!).thumbnail).toContain('visit-1');
 await storage.loadProject('p');expect(storage.nativeRow(storage.projects.get('p')!).thumbnail).toContain('visit-2');
 expect(transport.mock.calls).toHaveLength(6);
});

it('does not let a previous account preload or its cleanup replace a new same-ID preload',async()=>{
 const oldProject=deferred<Response>(),newProject=deferred<Response>();let reads=0;
 const transport=vi.fn(async(path:string)=>path.endsWith('/snapshot')?reply(snapshot(graph([]))):++reads===1?oldProject.promise:newProject.promise);
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn()),old=storage.loadProject('p'),rejected=expect(old).rejects.toMatchObject({code:'SESSION_CHANGED'});
 storage.clear();const current=storage.loadProject('p');oldProject.resolve(reply({...project,ownerId:'old'}));await rejected;
 expect(storage.loadProject('p')).toBe(current);expect(storage.projects.size).toBe(0);
 newProject.resolve(reply({...project,ownerId:'new'}));await current;
 expect(storage.projects.get('p')?.ownerId).toBe('new');expect(transport.mock.calls).toHaveLength(4);
});

it('returns the native thumbnail used by folder previews from the actual owner-scoped folder list',async()=>{
 const actual=asset('image',{previewUrl:'http://localhost/storage/assets/image?token=local-fixture'}),transport=vi.fn(async(path:string)=>{
  if(path.startsWith('/api/v2/project-folders/entries'))return reply({records:[{type:'CANVAS',project,folderId:'folder'}],page:1,size:20,total:1,hasNext:false,revision:2});
  if(path==='/api/v2/project-previews/query')return reply({items:[{project:{...project,role:'OWNER'},role:'OWNER',nodesCount:1,thumbnail:{assetId:actual.id,url:actual.previewUrl,urlsExpireAt:actual.urlsExpireAt}}]});
  throw new Error('Unexpected list request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),organization=new OrganizationAdapter(api,storage);
 const listed=await organization.list({folderId:'folder',queryScope:'CANVAS',page:1,size:20});
 expect(listed.records[0]).toMatchObject({type:'CANVAS',folderId:'folder',thumbnail:actual.previewUrl,createdTime:Date.parse(project.createdAt),updatedTime:Date.parse(project.updatedAt)});
 expect(storage.projects.size).toBe(0);expect(storage.snapshots.size).toBe(0);expect(storage.assets.size).toBe(0);expect(()=>storage.fixture('p')).toThrow('服务器加载');expect(transport.mock.calls).toHaveLength(2);
 expect(new URL(transport.mock.calls[0][0],'https://studio.test').searchParams.get('folderId')).toBe('folder');
});
