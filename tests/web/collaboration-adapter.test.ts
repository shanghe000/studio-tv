import {expect,it,vi} from 'vitest';
import {CollaborationAdapter} from '../../apps/web/src/service/collaboration';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {verifiedAccess} from './collaboration-fixtures';
import {collaborationOperation,contractResponse} from './collaboration-contract';

const team=(id='t',role='OWNER',revision=4)=>({id,name:'Team '+id,ownerId:'actual-owner',role,revision});
const member=(kind='project',revision=7)=>({[kind+'Id']:kind==='project'?'p':'t',revision,members:[{userId:'actual-owner',displayName:'Owner',avatarUrl:null,role:'OWNER'}]});
const entry=()=>({id:'e',teamId:'t',folderId:null,name:'Image',kind:'ASSET',revision:3,content:{primaryAssetId:'a'},thumbnailAssetId:'a',assets:[]});
function setup(handler:(path:string,init:any)=>Response|Promise<Response>){let identity:string|null='actor';const transport=vi.fn((path:string,init:any)=>{collaborationOperation(path,init.method||'GET');return handler(path,init);}),api=new ProductClient('/api/v1',transport as any);api.setAccessToken('actual-actor-token');const storage=new ServiceStorage(api,vi.fn(),()=>identity);storage.rememberAccess(verifiedAccess());const adapter=new CollaborationAdapter(api,storage,()=>identity);return{adapter,api,storage,transport,setIdentity:(value:string|null)=>identity=value};}
const reply=(path:string,init:any,data:any,status=200,etag?:string)=>contractResponse(path,init.method||'GET',data,status,etag);

it('uses registered namespace/envelopes for projects, permissions, users and all membership operations with the actual caller identity',async()=>{
 const f=setup((path,init)=>{
  if(path.includes('/access'))return reply(path,init,verifiedAccess('p','OWNER','owner',8),200,'"8"');
  if(path.includes('/users?'))return reply(path,init,{items:[{id:'u',displayName:'Colleague',avatarUrl:null}]});
  if(path.includes('/projects?'))return reply(path,init,{items:[{id:'p',role:'OWNER'}],page:1,pageSize:20,total:1,hasMore:false});
  if(path.includes('/projects/p/members'))return reply(path,init,member('project',init.method==='PUT'?8:9),200,'"9"');
  if(path.includes('/projects/p/teams'))return reply(path,init,{projectId:'p',revision:10,teams:[]},200,'"10"');
  throw new Error(path);
 });
 await f.storage.refreshAccess('p');await f.adapter.projects('shared');await f.adapter.users('Colleague');await f.adapter.members('projects','p');await f.adapter.setMember('projects','p','u','EDITOR');await f.adapter.removeMember('projects','p','u');await f.adapter.projectTeams('p');await f.adapter.setProjectTeam('p','t','VIEWER');await f.adapter.removeProjectTeam('p','t');
 for(const [path,init]of f.transport.mock.calls){expect(path).toMatch(/^\/api\/v2\/collaboration\//);expect(init.headers.get('Authorization')).toBe('Bearer actual-actor-token');expect(init.headers.get('X-Router-Subject-Ref')).toBeNull();if(init.method&&init.method!=='GET'){expect(init.headers.get('If-Match')).toMatch(/^"[1-9][0-9]*"$/);expect(init.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);}}
});
it('uses the viewed team revision without refreshing it behind a stale write or retrying a conflict',async()=>{
 const f=setup((path,init)=>path.includes('?')?reply(path,init,{items:[team()],page:1,pageSize:100,total:1,hasMore:false}):reply(path,init,{},412));await f.adapter.loadTeams();await expect(f.adapter.renameTeam('t','New')).rejects.toMatchObject({status:412});expect(f.transport).toHaveBeenCalledTimes(2);expect(f.transport.mock.calls[1][1].headers.get('If-Match')).toBe('"4"');
});
it('pages authorized teams, keeps their viewed versions and never adopts a personal-team identity',async()=>{
 const f=setup((path,init)=>{const page=Number(new URL(path,'http://studio.test').searchParams.get('page'));return reply(path,init,{items:[team('t'+page,page===1?'EDITOR':'VIEWER')],page,pageSize:100,total:2,hasMore:page===1});});expect((await f.adapter.loadTeams()).map(row=>row.id)).toEqual(['t1','t2']);expect(f.adapter.nativeTeams().map(row=>row.role)).toEqual(['EDITOR','VIEWER']);expect(f.adapter.currentTeamId).toBeNull();expect(f.transport).toHaveBeenCalledTimes(2);
});
it('decodes only declared raw team asset DTOs and handles real DELETE 204 with CAS and UUID keys',async()=>{
 const f=setup((path,init)=>{
  if(path.endsWith('/folders')&&init.method==='POST')return reply(path,init,{id:'f',teamId:'t',parentId:null,name:'Folder',revision:1},201,'"1"');
  if(path.includes('/folders?'))return reply(path,init,{records:[{id:'f',teamId:'t',parentId:null,name:'Folder',revision:2}],page:1,size:100,total:1,hasNext:false});
  if(path.endsWith('/folders/f'))return reply(path,init,init.method==='DELETE'?undefined:{id:'f',teamId:'t',parentId:null,name:'New',revision:3},init.method==='DELETE'?204:200,'"3"');
  if(path.includes('/assets?'))return reply(path,init,{records:[entry()],page:1,size:20,total:1,hasNext:false});
  if(path.endsWith('/import'))return reply(path,init,{targetProjectId:'p',entry:entry(),node:null,assets:[],assetIdMap:{}},201);
  if(path.endsWith('/assets/e'))return reply(path,init,init.method==='DELETE'?undefined:{...entry(),revision:4},init.method==='DELETE'?204:200,'"4"');
  if(path.endsWith('/assets'))return reply(path,init,entry(),201,'"3"');
  throw new Error(path);
 });f.adapter.teams.set('t',team());await f.adapter.createFolder('t','Folder');await f.adapter.folders('t');await f.adapter.renameFolder('t','f','New');await f.adapter.deleteFolder('t','f');await f.adapter.entries('t');await f.adapter.publish('t',{sourceAssetId:'a'},'Image',null);await f.adapter.renameEntry('t','e','Renamed',null);await f.adapter.importEntry('t','e','p');await f.adapter.deleteEntry('t','e');
 const mutations=f.transport.mock.calls.filter(([,init])=>init.method);for(const [,init]of mutations)expect(init.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);expect(mutations.filter(([,init])=>['PATCH','DELETE'].includes(init.method)).every(([,init])=>!!init.headers.get('If-Match'))).toBe(true);expect(JSON.parse(mutations[1][1].body)).toEqual({name:'New'});
});
it('rejects viewer/team-editor management and publication before any transport',async()=>{
 const f=setup(()=>{throw new Error('must not call');});f.storage.rememberAccess(verifiedAccess('p','VIEWER'));f.adapter.teams.set('t',team('t','VIEWER'));await expect(f.adapter.setProjectTeam('p','t','EDITOR')).rejects.toMatchObject({status:403});await expect(f.adapter.setMember('projects','p','u','EDITOR')).rejects.toMatchObject({status:403});await expect(f.adapter.publish('t',{sourceAssetId:'a'},'',null)).rejects.toMatchObject({status:403});await expect(f.adapter.createFolder('t','Folder')).rejects.toMatchObject({status:403});f.adapter.teams.set('t',team('t','EDITOR'));await expect(f.adapter.setMember('teams','t','u','EDITOR')).rejects.toMatchObject({status:403});await expect(f.adapter.renameTeam('t','New')).rejects.toMatchObject({status:403});expect(f.transport).not.toHaveBeenCalled();
});
it('aborts old team requests and rejects ignored-abort responses after selection changes without hydrating the new scope',async()=>{
 let finish!:(value:Response)=>void,started!:(value:void)=>void;const ready=new Promise<void>(resolve=>started=resolve);const f=setup((path,init)=>path.includes('/folders?')?(started(),new Promise(resolve=>finish=resolve)):reply(path,init,team('other')));f.adapter.teams.set('t',team());const pending=f.adapter.folders('t'),rejected=expect(pending).rejects.toMatchObject({code:'COLLABORATION_SCOPE_CHANGED'});await ready;await f.adapter.selectTeam('other');finish(contractResponse('/api/v2/collaboration/teams/t/folders','GET',{records:[{id:'old',teamId:'t',name:'Old',revision:1}],hasNext:false,page:1,size:100,total:1}));await rejected;expect(f.adapter.currentTeamId).toBe('other');expect((f.transport.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);await expect(f.adapter.renameFolder('t','old','Overwrite')).rejects.toMatchObject({status:428});
});
it('clears team selection, versions and in-flight fills on signout and refuses the next identity adopting them',async()=>{
 let finish!:(value:Response)=>void;const f=setup((path,init)=>new Promise(resolve=>finish=resolve));f.adapter.teams.set('t',team());f.adapter.currentTeamId='t';const pending=f.adapter.loadTeams(),rejected=expect(pending).rejects.toMatchObject({code:'COLLABORATION_SCOPE_CHANGED'});f.setIdentity(null);f.adapter.clear();finish(contractResponse('/api/v2/collaboration/teams','GET',{items:[team()],hasMore:false,page:1,pageSize:100,total:1}));await rejected;expect(f.adapter.teams.size).toBe(0);expect(f.adapter.currentTeamId).toBeNull();await expect(f.adapter.loadTeams()).rejects.toMatchObject({status:401});expect(f.transport).toHaveBeenCalledOnce();
});
it('preserves a backend unavailable result rather than reporting an empty successful team list',async()=>{const f=setup(()=>new Response(JSON.stringify({code:'UPSTREAM_UNAVAILABLE',message:'Unavailable'}),{status:503}));await expect(f.adapter.loadTeams()).rejects.toMatchObject({status:503});expect(f.adapter.teams.size).toBe(0);});

it('keeps the revision actually displayed by a list even when another dialog refreshes the shared cache',async()=>{
 const f=setup((path,init)=>path.includes('?')?reply(path,init,{items:[team()],page:1,pageSize:100,total:1,hasMore:false}):init.method==='PATCH'?reply(path,init,{},412):reply(path,init,team('t','OWNER',5),200,'"5"'));
 const [displayed]=await f.adapter.loadTeams();await f.adapter.team('t');await expect(f.adapter.renameTeam('t','Stale edit',displayed.revision)).rejects.toMatchObject({status:412});expect(f.transport.mock.calls[2][1].headers.get('If-Match')).toBe('"4"');expect(f.transport).toHaveBeenCalledTimes(3);
});
