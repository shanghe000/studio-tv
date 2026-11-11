import {describe,it,expect,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {OrganizationAdapter} from '../../apps/web/src/service/organization';

type Call={path:string;method:string;body:any;headers:Headers;signal:AbortSignal};
const reply=(data:any,etag?:string,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});
const failure=(status:number,code:string)=>new Response(JSON.stringify({code,error:{code,message:code}}),{status});
const project=(id='p',revision=4)=>({id,name:'Own project '+id,ownerId:'owner',teamId:null,coverAssetId:null,pinned:false,revision,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z'});
const graph={schemaVersion:'1',nodes:[{id:'actual-node',type:'rh-text',position:{x:0,y:0},data:{text:'Actual saved content'}}],edges:[],viewport:{x:0,y:0,zoom:1}};
const snapshot=(id='p',revision=4)=>({projectId:id,revision,graph,updatedAt:'2026-10-05T00:00:00Z'});
const folder=(id='f',revision=3)=>({id,parentId:null,name:'Saved folder',revision,level:1,maxLevel:3,allowCreateSubFolder:true,itemCount:1,total:1,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z'});
function setup(route:(call:Call)=>Response|Promise<Response>){
 const calls:Call[]=[],transport=vi.fn(async(path:any,options:any={})=>{const call={path:String(path),method:options.method??'GET',body:options.body===undefined?undefined:JSON.parse(options.body),headers:new Headers(options.headers),signal:options.signal};calls.push(call);return route(call);});
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner-session');const storage=new ServiceStorage(api,vi.fn());return{adapter:new OrganizationAdapter(api,storage),storage,api,calls,transport};
}
const v1=(call:Call,rev=4)=>{const match=call.path.match(/^\/api\/v1\/projects\/([^/?]+)(\/snapshot)?$/);if(!match)return null;return reply(match[2]?snapshot(match[1],rev):project(match[1],rev),'"'+rev+'"');};
const previews=(call:Call)=>call.path==='/api/v2/project-previews/query'?reply({items:call.body.projectIds.map((id:string)=>({project:{...project(id),role:'OWNER'},role:'OWNER',nodesCount:1,thumbnail:null}))}):null;

describe('persisted organization native adapter',()=>{
 it('reads the enforced server config and creates a native folder using the real parent and UUID',async()=>{
  const {adapter,calls}=setup(call=>call.path.endsWith('/config')?reply({maxLevel:3,maxFolders:1000}):reply({...folder('child',1),parentId:call.body.parentId,level:2},'"1"',201));
  expect(await adapter.handle('/canvas/folder/getConfig',{})).toEqual({maxLevel:3,maxFolders:1000});
  const created=await adapter.handle('/canvas/folder/create',{name:'Child',folderId:'parent',teamId:'untrusted-team',ownerId:'untrusted-owner'});
  expect(created).toMatchObject({id:'child',type:'FOLDER',parentId:'parent',level:2,itemCount:1});expect(calls[1].body).toEqual({name:'Child',parentId:'parent'});
  expect(calls[1].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);expect(calls[1].headers.get('Authorization')).toBe('Bearer owner-session');
 });

 it('preserves the actual mixed page, filter and sort using one preview batch without loading canvases',async()=>{
  const {adapter,storage,calls}=setup(call=>previews(call)??reply({records:[{type:'FOLDER',folder:folder()},{type:'CANVAS',project:project(),folderId:'f'}],page:2,current:2,size:20,total:22,pages:2,hasNext:false,revision:9}));
  const page=await adapter.list({page:2,size:20,folderId:'f',queryScope:'ALL',querySortBy:'NAME',querySortOrder:'ASC',keyword:'own',teamId:'ignored'});
  const url=new URL(calls[0].path,'https://studio.test');expect(url.pathname).toBe('/api/v2/project-folders/entries');expect(Object.fromEntries(url.searchParams)).toEqual({folderId:'f',queryScope:'ALL',sort:'NAME_ASC',keyword:'own',page:'2',size:'20'});
  expect(page).toMatchObject({current:2,size:20,total:22,pages:2,hasNext:false,revision:9,records:[{id:'f',type:'FOLDER',total:1},{id:'p',type:'CANVAS',canvasId:'p',folderId:'f',nodesCount:1}]});
  expect(()=>storage.fixture('p')).toThrow('服务器加载');expect(storage.projects.size).toBe(0);expect(storage.snapshots.size).toBe(0);expect(storage.etags.size).toBe(0);expect(calls).toHaveLength(2);expect(calls[1]).toMatchObject({path:'/api/v2/project-previews/query',method:'POST',body:{projectIds:['p']}});
 });

 it('sends the viewed folder revision on rename and propagates412 without a fresh overwrite',async()=>{
  const {adapter,calls}=setup(call=>call.method==='GET'?reply(folder(),'"3"'):failure(412,'VERSION_CONFLICT'));
  await expect(adapter.handle('/canvas/folder/update',{folderId:'f',name:'Renamed'})).rejects.toMatchObject({status:412,code:'VERSION_CONFLICT'});
  expect(calls.map(call=>call.method)).toEqual(['GET','PATCH']);expect(calls[1].headers.get('If-Match')).toBe('"3"');expect(calls[1].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1].body).toEqual({name:'Renamed'});
 });

 it('maps native file-size order to real server sorting and preserves authoritative byte sizes',async()=>{
  const {adapter,calls}=setup(call=>previews(call)??reply({records:[{type:'CANVAS',project:project(),folderId:null,byteSize:2048}],page:1,size:20,total:1,pages:1,hasNext:false,revision:3}));
  const result=await adapter.list({queryScope:'CANVAS',querySortBy:'FILE_SIZE',querySortOrder:'DESC'});
  expect(new URL(calls[0].path,'https://studio.test').searchParams.get('sort')).toBe('SIZE_DESC');expect(result.records[0].byteSize).toBe(2048);
 });

 it('cleans only actual server-deleted canvas caches after a versioned UUID folder deletion',async()=>{
  const {adapter,storage,calls}=setup(call=>call.method==='GET'?reply(folder(),'"3"'):reply({id:'f',revision:4,deletedFolderIds:['f','child'],deletedProjectIds:['p'],deletedAt:'2026-10-05T01:00:00Z'},'"4"'));
  storage.projects.set('p',project());storage.projects.set('kept',project('kept'));storage.snapshots.set('p',snapshot() as any);storage.etags.set('p','"4"');
  const result=await adapter.handle('/canvas/folder/delete',{folderId:'f'});expect(result.deletedProjectIds).toEqual(['p']);expect(storage.projects.has('p')).toBe(false);expect(storage.snapshots.has('p')).toBe(false);expect(storage.etags.has('p')).toBe(false);expect(storage.projects.has('kept')).toBe(true);
  expect(calls[1]).toMatchObject({method:'DELETE',body:undefined});expect(calls[1].headers.get('If-Match')).toBe('"3"');expect(calls[1].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 });

 it('projects the actual move tree and refreshes graph+project revision after membership mutation',async()=>{
  const tree={records:[{id:null,folderId:null,type:'ROOT',name:'',level:0,maxLevel:3,allowCreateSubFolder:true,itemCount:1,total:1,childList:[{...folder(),folderId:'f',type:'FOLDER',childList:[{id:'p',canvasId:'p',folderId:'f',type:'CANVAS',name:'Actual project',nodesCount:1,childList:[]}]}]}],revision:8};
  const {adapter,storage,calls}=setup(call=>call.path.startsWith('/api/v2/project-folders/tree')?reply(tree):call.path==='/api/v2/projects/p/folder'?reply({projectId:'p',folderId:call.method==='PUT'?null:'f',revision:call.method==='PUT'?5:4},call.method==='PUT'?'"5"':'"4"'):v1(call,5)!);
  expect(await adapter.handle('/canvas/move/v1/targetList',{canvasId:'p'})).toEqual(tree.records);storage.projects.set('p',project());storage.snapshots.set('p',snapshot() as any);storage.etags.set('p','"4"');
  const moved=await adapter.handle('/canvas/move/v1/submit',{canvasId:'p',targetFolderId:null,teamId:'foreign'});expect(moved).toEqual({projectId:'p',folderId:null,revision:5});
  expect(calls.map(call=>call.method)).toEqual(['GET','GET','PUT','GET','GET']);expect(calls[2].body).toEqual({folderId:null});expect(calls[2].headers.get('If-Match')).toBe('"4"');expect(calls[2].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(storage.projects.get('p')?.revision).toBe(5);expect(storage.snapshots.get('p')?.revision).toBe(5);expect(storage.etags.get('p')).toBe('"5"');
 });

 it('waits for pending saves before moving and rejects unresolved save conflicts without any membership write',async()=>{
  const {adapter,storage,calls}=setup(()=>reply({}));let finish!:()=>void;const waiting=new Promise<void>(resolve=>finish=resolve);
  vi.spyOn(storage,'wait').mockReturnValue(waiting);vi.spyOn(storage,'isBlocked').mockReturnValue(true);
  const moving=adapter.handle('/canvas/move/v1/submit',{canvasId:'p',targetFolderId:'f'});const rejected=expect(moving).rejects.toMatchObject({status:409,code:'PROJECT_SAVE_CONFLICT'});
  await Promise.resolve();expect(calls).toHaveLength(0);finish();await rejected;expect(calls).toHaveLength(0);
 });

 it('creates project+folder atomically and makes its actual snapshot immediately available',async()=>{
  const {adapter,storage,calls}=setup(call=>v1(call,1)??reply(project('p',1),'"1"',201));
  expect(await adapter.create({name:'Folder project',folderId:'f',userId:'foreign',teamId:'foreign'})).toMatchObject({id:'p',ownerId:'owner',revision:1});
  expect(calls[0]).toMatchObject({path:'/api/v2/project-folders/projects',method:'POST',body:{name:'Folder project',folderId:'f'}});expect(calls[0].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);expect(storage.fixture('p').nodes[0].id).toBe('actual-node');
 });

 it('rejects late ignored-abort pages and stops follow-up mutations after identity cleanup',async()=>{
  let finish!:(response:Response)=>void;const {adapter,storage,calls}=setup(()=>new Promise(resolve=>finish=resolve));
  const pending=adapter.list({queryScope:'CANVAS'}),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await Promise.resolve();adapter.clear();storage.clear();expect(calls[0].signal.aborted).toBe(true);
  finish(reply({records:[{type:'CANVAS',project:project(),folderId:null}],page:1,size:20,total:1,pages:1,hasNext:false,revision:1}));await rejected;expect(calls).toHaveLength(1);expect(storage.projects.size).toBe(0);
  const rename=adapter.handle('/canvas/folder/update',{folderId:'f',name:'New'}),renameRejected=expect(rename).rejects.toMatchObject({code:'SESSION_CHANGED'});await Promise.resolve();adapter.clear();finish(reply(folder(),'"3"'));await renameRejected;expect(calls).toHaveLength(2);
 });

 it('propagates reserved501 and foreign404 responses and rejects incomplete backend pages',async()=>{
  for(const [status,code]of [[501,'NOT_IMPLEMENTED'],[404,'RESOURCE_NOT_FOUND']] as const){const {adapter}=setup(()=>failure(status,code));await expect(adapter.list()).rejects.toMatchObject({status,code});}
  const {adapter}=setup(()=>reply({records:[],total:0}));await expect(adapter.list()).rejects.toMatchObject({code:'MISSING_ORGANIZATION_REVISION'});expect(await adapter.handle('/unknown')).toBeUndefined();
 });
});
