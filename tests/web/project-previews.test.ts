import {describe,it,expect,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {OrganizationAdapter} from '../../apps/web/src/service/organization';
import {projectPreviewPage,projectPreviewIds,type ProjectPreview} from '../../apps/web/src/service/project-previews';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';

// These are explicit local transport fixtures. No production API or model is used.
type Call={path:string;method:string;body:any;headers:Headers;signal:AbortSignal};
const reply=(data:any,etag?:string)=>new Response(JSON.stringify({code:0,data}),{headers:etag?{ETag:etag}:{}});
const failure=(status:number,code:string)=>new Response(JSON.stringify({code,error:{code,message:code}}),{status});
const project=(id='p',revision=4)=>({id,name:'Saved '+id,ownerId:'canonical-owner',teamId:null,coverAssetId:null,pinned:false,revision,createdAt:'2026-10-06T00:00:00Z',updatedAt:'2026-10-07T00:00:00Z'});
const preview=(id='p',role:ProjectPreview['role']='EDITOR',changes:Partial<ProjectPreview>={}):ProjectPreview=>({project:{...project(id),role},role,nodesCount:7,thumbnail:null,...changes});
const thumbnail=(assetId='ast_cover')=>({assetId,url:'http://localhost/storage/assets/'+assetId+'?token=local-fixture-only',urlsExpireAt:'2026-10-07T00:15:00Z'});
const native=()=>({nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{text:'Saved content'}}],edges:[]});
const snapshot=(id='p',revision=4)=>({projectId:id,revision,graph:encodeGraph(native()),updatedAt:project().updatedAt});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
function setup(route:(call:Call)=>Response|Promise<Response>,withIdentity=true){
 let actor:string|null='actual-editor';const calls:Call[]=[],transport=vi.fn(async(path:any,init:any={})=>{const call={path:String(path),method:init.method??'GET',body:init.body===undefined?undefined:JSON.parse(init.body),headers:new Headers(init.headers),signal:init.signal};calls.push(call);return route(call);});
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('local-actor-session');const storage=new ServiceStorage(api,vi.fn(),withIdentity?()=>actor:undefined);
 return{api,storage,organization:new OrganizationAdapter(api,storage),calls,transport,identity:(value:string|null)=>actor=value};
}
const batch=(items:ProjectPreview[])=>reply({items});

describe('bounded presentation-only project previews',()=>{
 it.each([8,20])('renders %i native cards with directory+one batch and no canvas initialization',async(count)=>{
  const ids=Array.from({length:count},(_,index)=>'p_'+index),items=ids.map((id,index)=>preview(id,index%2?'VIEWER':'EDITOR',{nodesCount:index,thumbnail:index===0?thumbnail():null}));
  const s=setup(call=>{
   if(call.path.startsWith('/api/v2/project-folders/entries?'))return reply({records:ids.map(id=>({type:'CANVAS',project:project(id),folderId:null,byteSize:11})),total:count,hasNext:false,revision:3});
   if(call.path==='/api/v2/project-previews/query'){expect(call.body).toEqual({projectIds:ids});return batch(items);}throw new Error('Unexpected list initialization '+call.path);
  });
  const result=await s.organization.list({size:count,queryScope:'CANVAS'});
  expect(result.records).toHaveLength(count);expect(result.records[0]).toMatchObject({canvasId:ids[0],thumbnail:thumbnail().url,cover:thumbnail().url,nodesCount:0,byteSize:11,role:'EDITOR'});expect(result.records[1]).toMatchObject({thumbnail:'',nodesCount:1,role:'VIEWER'});
  expect(s.calls).toHaveLength(2);expect(s.calls.every(call=>call.headers.get('Authorization')==='Bearer local-actor-session')).toBe(true);
  expect(s.storage.projects.size+s.storage.snapshots.size+s.storage.assets.size+s.storage.etags.size+s.storage.accessMap.size).toBe(0);expect(s.storage.hasDraft(ids[0])).toBe(false);expect(()=>s.storage.fixture(ids[0])).toThrow('服务器加载');expect(s.storage.canEdit(ids[0])).toBe(false);
 });

 it('uses the same lightweight batch for the v1 project list and preserves real pagination and sort',async()=>{
  const s=setup(call=>call.path.startsWith('/api/v1/projects?')?reply({items:[project()],page:2,pageSize:20,total:22,hasMore:false}):call.path==='/api/v2/project-previews/query'?batch([preview('p','OWNER',{thumbnail:thumbnail()})]):(()=>{throw new Error(call.path);})());
  const result=await s.storage.list({page:2,size:20,sort:'NAME_ASC',keyword:'saved'});expect(result).toMatchObject({current:2,size:20,total:22,pages:2,hasNext:false,records:[{id:'p',role:'OWNER',nodesCount:7,thumbnail:thumbnail().url}]});expect(s.calls).toHaveLength(2);expect(new URL(s.calls[0].path,'http://localhost').searchParams.get('sort')).toBe('NAME_ASC');expect(s.storage.snapshots.size).toBe(0);
 });

 it('splits large native pages into batches of at most100 without per-project fetches',async()=>{
  const ids=Array.from({length:101},(_,index)=>'p_'+index),s=setup(call=>{
   if(call.path.startsWith('/api/v2/project-folders/entries?')){const page=Number(new URL(call.path,'http://localhost').searchParams.get('page'));return reply({records:ids.slice((page-1)*100,page*100).map(id=>({type:'CANVAS',project:project(id),folderId:null})),total:101,hasNext:page===1,revision:6});}
   if(call.path==='/api/v2/project-previews/query')return batch(call.body.projectIds.map((id:string)=>preview(id)));throw new Error(call.path);
  });
  expect((await s.organization.list({size:101})).records).toHaveLength(101);expect(s.calls).toHaveLength(4);expect(s.calls.filter(call=>call.method==='POST').map(call=>call.body.projectIds.length)).toEqual([100,1]);expect(s.storage.snapshots.size).toBe(0);
 });

 it('does not call the preview API for an empty page',async()=>{
  const s=setup(()=>reply({records:[],total:0,hasNext:false,revision:1}));expect((await s.organization.list()).records).toEqual([]);expect(s.calls).toHaveLength(1);expect(await s.storage.loadProjectPreviews([])).toEqual(new Map());expect(s.calls).toHaveLength(1);
 });

 it('keeps an active acknowledged graph and unsaved draft unchanged when a newer preview arrives',async()=>{
  const s=setup(()=>batch([preview('p','EDITOR',{project:{...project('p',5),name:'Fresh list name',role:'EDITOR'},thumbnail:thumbnail()})]));
  s.storage.projects.set('p',project());s.storage.rememberAccess(verifiedAccess('p','EDITOR','canonical-owner',9));s.storage.acceptRemoteSnapshot('p',snapshot(),'"4"');const local=s.storage.fixture('p');s.storage.attachNativeView('p',local);local.nodes[0].data.text='Unsaved editor input';s.storage.observeNativeDraft('p',local);
  const before=structuredClone(s.storage.snapshots.get('p'));await s.storage.loadProjectPreviews(['p']);expect(s.storage.projects.get('p')?.name).toBe('Saved p');expect(s.storage.snapshots.get('p')).toEqual(before);expect(s.storage.etags.get('p')).toBe('"4"');expect(s.storage.fixture('p').nodes[0].data.text).toBe('Unsaved editor input');expect(s.storage.hasDraft('p')).toBe(true);expect(s.storage.access('p')?.revision).toBe(9);expect(s.storage.assets.size).toBe(0);
 });

 it.each([
  (data:any)=>data.items.pop(),
  (data:any)=>data.items.reverse(),
  (data:any)=>data.items[0].project.ownerId=undefined,
  (data:any)=>data.items[0].project.coverAssetId=undefined,
  (data:any)=>data.items[0].project.role='OWNER',
  (data:any)=>data.items[0].nodesCount=-1,
  (data:any)=>data.items[0].thumbnail={...thumbnail(),url:'https://foreign.invalid/storage/assets/ast_cover?token=fixture'},
  (data:any)=>data.items[0].thumbnail={...thumbnail(),url:'http://localhost/storage/assets/other?token=fixture'},
  (data:any)=>data.items[0].thumbnail={...thumbnail(),url:'http://localhost/storage/assets/ast_cover'},
 ])('rejects malformed/partial/foreign media batches rather than fabricating cards (%#)',mutate=>{
  const data={items:[preview('p'),preview('q')]};mutate(data);expect(()=>projectPreviewPage(data,['p','q'],'http://localhost')).toThrow('无效的项目预览');
 });

 it('rejects invalid query IDs, duplicates and oversize batches before network activity',async()=>{
  const s=setup(()=>{throw new Error('No invalid request should be sent');});for(const ids of [['p','p'],['../private'],Array.from({length:101},(_,i)=>'p_'+i)])await expect(s.storage.loadProjectPreviews(ids)).rejects.toMatchObject({status:400,code:'INVALID_PROJECT_PREVIEW_QUERY'});expect(s.calls).toHaveLength(0);expect(projectPreviewIds(['p'])).toEqual(['p']);
 });

 it('propagates whole-batch404 without falling back to cached graph/media or skipping inaccessible entries',async()=>{
  const s=setup(()=>failure(404,'PROJECT_NOT_FOUND'));s.storage.projects.set('p',project());s.storage.acceptRemoteSnapshot('p',snapshot());await expect(s.storage.loadProjectPreviews(['p','q'])).rejects.toMatchObject({status:404,code:'PROJECT_NOT_FOUND'});expect(s.calls).toHaveLength(1);expect((s.storage as any).projectPreviews.size).toBe(0);
 });

 it('aborts and fences an ignored-abort preview after auth cleanup without retaining the old signed URL',async()=>{
  const late=deferred<Response>(),s=setup(()=>late.promise),loading=s.storage.loadProjectPreviews(['p']),rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});s.storage.clear();s.identity('new-actor');expect(s.calls[0].signal.aborted).toBe(true);late.resolve(batch([preview('p','EDITOR',{thumbnail:thumbnail()})]));await rejected;expect((s.storage as any).projectPreviews.size).toBe(0);expect(s.storage.projects.size+s.storage.assets.size+s.storage.accessMap.size).toBe(0);
 });

 it('prevents an older pending preview from restoring a removed/changed card',async()=>{
  const late=deferred<Response>(),s=setup(()=>late.promise),loading=s.storage.loadProjectPreviews(['p']),rejected=expect(loading).rejects.toMatchObject({code:'PROJECT_PREVIEW_CHANGED'});s.storage.forgetProjectPreview('p');late.resolve(batch([preview()]));await rejected;expect((s.storage as any).projectPreviews.has('p')).toBe(false);
 });
});

describe('list-only metadata actions and canvas navigation',()=>{
 it('renames a preview-only editor card using fresh ACL and the viewed metadata revision without a canvas fetch',async()=>{
  const s=setup(call=>{
   if(call.path==='/api/v2/project-previews/query')return batch([preview()]);
   if(call.path==='/api/v2/collaboration/projects/p/access')return reply(verifiedAccess('p','EDITOR','canonical-owner',29));
   if(call.path==='/api/v1/projects/p'&&call.method==='PATCH'){expect(call.body).toEqual({name:'Renamed'});expect(call.headers.get('If-Match')).toBe('"4"');return reply({...project('p',5),name:'Renamed'});}
   throw new Error('Unexpected metadata initialization '+call.path);
  });
  await s.storage.loadProjectPreviews(['p']);expect(s.storage.canEdit('p')).toBe(false);await s.storage.rename('p','Renamed');expect(s.calls.map(call=>call.path)).toEqual(['/api/v2/project-previews/query','/api/v2/collaboration/projects/p/access','/api/v1/projects/p']);expect(s.calls.every(call=>call.headers.get('Authorization')==='Bearer local-actor-session')).toBe(true);expect(s.storage.nativeRow(project()).name).toBe('Renamed');expect(s.storage.projects.size+s.storage.snapshots.size+s.storage.etags.size).toBe(0);expect(s.storage.hasDraft('p')).toBe(false);
 });

 it.each(['pin','delete']as const)('performs %s on an authorized preview-only owner without loading a graph',async(action)=>{
  const s=setup(call=>call.path==='/api/v2/project-previews/query'?batch([preview('p','OWNER')]):call.path.endsWith('/access')?reply(verifiedAccess('p','OWNER','canonical-owner',12)):call.path.startsWith('/api/v1/projects/p')?(expect(call.headers.get('If-Match')).toBe('"4"'),reply({...project('p',5),pinned:true})):(()=>{throw new Error(call.path);})());await s.storage.loadProjectPreviews(['p']);await(action==='pin'?s.storage.pin('p',true):s.storage.delete('p'));expect(s.calls).toHaveLength(3);expect(s.calls[2].method).toBe(action==='pin'?'PUT':'DELETE');expect(s.storage.snapshots.size+s.storage.etags.size).toBe(0);if(action==='delete')expect((s.storage as any).projectPreviews.has('p')).toBe(false);
 });

 it('rechecks revocation and role downgrade before writing rather than treating preview role as permission',async()=>{
  let role:'OWNER'|'VIEWER'='VIEWER',revoked=false;const s=setup(call=>call.path==='/api/v2/project-previews/query'?batch([preview('p','OWNER')]):call.path.endsWith('/access')?(revoked?failure(404,'PROJECT_NOT_FOUND'):reply(verifiedAccess('p',role,'canonical-owner'))):(()=>{throw new Error('Forbidden mutation '+call.path);})());await s.storage.loadProjectPreviews(['p']);s.storage.rememberAccess(verifiedAccess('p','OWNER','canonical-owner'));
  await expect(s.storage.rename('p','Blocked')).rejects.toMatchObject({status:403});await expect(s.storage.pin('p',true)).rejects.toMatchObject({status:403});await expect(s.storage.delete('p')).rejects.toMatchObject({status:403});revoked=true;role='OWNER';await expect(s.storage.rename('p','Revoked')).rejects.toMatchObject({status:404});expect(s.calls.filter(call=>!call.path.endsWith('/access'))).toHaveLength(1);expect(s.storage.access('p')).toBeUndefined();
 });

 it('propagates a server metadata412 without a fresh overwrite or blind retry',async()=>{
  const s=setup(call=>call.path==='/api/v2/project-previews/query'?batch([preview()]):call.path.endsWith('/access')?reply(verifiedAccess('p','EDITOR','canonical-owner')):failure(412,'VERSION_CONFLICT'));await s.storage.loadProjectPreviews(['p']);await expect(s.storage.rename('p','No overwrite')).rejects.toMatchObject({status:412,code:'VERSION_CONFLICT'});expect(s.calls).toHaveLength(3);expect(s.calls[2].headers.get('If-Match')).toBe('"4"');expect(s.storage.nativeRow(project()).name).toBe('Saved p');
 });

 it('moves a list-only project with current membership revision and refreshes metadata only',async()=>{
  const s=setup(call=>call.path==='/api/v2/project-previews/query'?batch([preview('p','OWNER')]):call.path==='/api/v2/projects/p/folder'?reply({projectId:'p',folderId:call.method==='PUT'?'folder':null,revision:call.method==='PUT'?5:4},call.method==='PUT'?'"5"':'"4"'):call.path==='/api/v1/projects/p'?reply(project('p',5)):(()=>{throw new Error(call.path);})());await s.storage.loadProjectPreviews(['p']);await s.organization.handle('/canvas/move/v1/submit',{canvasId:'p',targetFolderId:'folder'});expect(s.calls.map(call=>call.path)).toEqual(['/api/v2/project-previews/query','/api/v2/projects/p/folder','/api/v2/projects/p/folder','/api/v1/projects/p']);expect(s.calls[2]).toMatchObject({method:'PUT',body:{folderId:'folder'}});expect(s.calls[2].headers.get('If-Match')).toBe('"4"');expect(s.storage.snapshots.size+s.storage.etags.size).toBe(0);
 });

 it('cancels one canvas route waiter while letting another same-identity waiter finish the shared fill',async()=>{
  const late=deferred<Response>(),s=setup(call=>call.path.endsWith('/snapshot')?reply(snapshot(),'"4"'):late.promise,false),controller=new AbortController(),first=s.storage.loadProject('p',{signal:controller.signal}),other=s.storage.loadProject('p'),rejected=expect(first).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;expect(s.calls).toHaveLength(2);expect(s.calls.every(call=>!call.signal.aborted)).toBe(true);late.resolve(reply(project()));await expect(other).resolves.toMatchObject({id:'p'});expect(s.storage.fixture('p').nodes[0].data.text).toBe('Saved content');
 });

 it('does not start a canvas fill for an already canceled route',async()=>{
  const s=setup(()=>{throw new Error('Canceled route must not load');}),controller=new AbortController();controller.abort();await expect(s.storage.loadProject('p',{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(s.calls).toHaveLength(0);
 });
});
