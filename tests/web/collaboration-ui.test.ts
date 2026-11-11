// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {createCollaborationDialog,collaborationField,requireName} from '../../apps/web/src/service/collaboration-dialogs';
import {CollaborationAdapter} from '../../apps/web/src/service/collaboration';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {mountCollaborationPage} from '../../apps/web/src/service/collaboration-ui';
import collaborationContract from '../../contracts/collaboration-extension.json';

const disposers:Array<()=>void>=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();document.body.replaceChildren();vi.restoreAllMocks();});
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const authFixture=()=>{
 const listeners=new Set<()=>void>();
 const auth={user:{id:'fixture-actual-actor'} as {id:string}|null,onClear:(run:()=>void)=>{listeners.add(run);return()=>listeners.delete(run);},clear:()=>{auth.user=null;for(const run of [...listeners])run();}};
 return auth;
};
function findButton(root:ParentNode,label:string){const found=[...root.querySelectorAll<HTMLButtonElement>('button')].find(button=>!button.closest('[hidden]')&&(button.textContent?.trim()===label||button.getAttribute('aria-label')===label));expect(found,'button '+label).toBeTruthy();return found!;}
function field<T extends HTMLInputElement|HTMLSelectElement>(root:ParentNode,label:string){const found=[...root.querySelectorAll<T>('input,select')].find(input=>input.getAttribute('aria-label')===label);expect(found,'field '+label).toBeTruthy();return found!;}
const visibleError=(root:ParentNode)=>[...root.querySelectorAll<HTMLElement>('[role="alert"],.studio-collab-error')].find(error=>!error.hidden);
const submit=(dialog:HTMLDialogElement)=>{const form=dialog.querySelector('form');expect(form,'native form supports Enter submission').toBeTruthy();form!.requestSubmit();};
async function settle(check:()=>void){await vi.waitFor(check,{timeout:1500,interval:5});}
function contractResponse(target:string,method:string,data:any,status=200,etag?:string){
 const url=new URL(target,'http://fixture.invalid'),prefix=collaborationContract.servers[0].url;
 if(!url.pathname.startsWith(prefix+'/'))throw new Error('Not a fixture contract route: '+target);
 const path=url.pathname.slice(prefix.length),entry=Object.entries<any>(collaborationContract.paths).find(([template])=>new RegExp('^'+template.replace(/\{[^}]+\}/g,'[^/]+')+'$').test(path));
 const operation=entry?.[1][method.toLowerCase()];if(!operation)throw new Error('Unregistered fixture route: '+method+' '+target);
 if(status===204)return new Response(null,{status});
 if(status>=400)return new Response(JSON.stringify({code:'VERSION_CONFLICT',message:'权限或内容版本已更新'}),{status});
 const schema=operation.responses[String(status)]?.content?.['application/json']?.schema;if(!schema)throw new Error('Undeclared fixture success: '+status+' '+target);
 return new Response(JSON.stringify(schema.properties?.code?{code:0,message:'OK',requestId:'fixture-only',data}:data),{status,headers:etag?{ETag:etag}:{}});
}

it('uses a real form for Enter submission, trims required names and coalesces a double submit',async()=>{
 const auth=authFixture(),pending=deferred<void>(),write=vi.fn(()=>pending.promise),input=document.createElement('input');
 const modal=createCollaborationDialog({auth},{title:'新建文件夹',submitLabel:'创建',onSubmit:async()=>{await write(requireName(input.value,'文件夹名称'));}});
 disposers.push(modal.close);modal.body.append(collaborationField('文件夹名称',input));
 input.value=' \t\n';modal.form.requestSubmit();await settle(()=>expect(visibleError(modal.dialog)?.textContent).toContain('请输入文件夹名称'));
 expect(write).not.toHaveBeenCalled();expect(modal.busy).toBe(false);expect(modal.submit.type).toBe('submit');
 input.value='  分镜资料  ';modal.form.requestSubmit();modal.form.requestSubmit();
 expect(write).toHaveBeenCalledExactlyOnceWith('分镜资料');expect(modal.form.getAttribute('aria-busy')).toBe('true');expect(input.disabled).toBe(true);expect(modal.submit.disabled).toBe(true);
 pending.resolve();await settle(()=>expect(modal.busy).toBe(false));expect(input.disabled).toBe(false);expect(visibleError(modal.dialog)).toBeUndefined();
});

it('keeps typed input on a failed write and recovers the same form for a deliberate retry',async()=>{
 const auth=authFixture(),input=document.createElement('input'),write=vi.fn().mockRejectedValueOnce(new ApiError(412,'VERSION_CONFLICT','内容已更新，请重新确认。')).mockResolvedValueOnce(undefined);
 const modal=createCollaborationDialog({auth},{title:'条目改名',submitLabel:'保存',onSubmit:async()=>{await write(requireName(input.value,'条目名称'));}});
 disposers.push(modal.close);modal.body.append(collaborationField('条目名称',input));input.value='保留我的输入';modal.form.requestSubmit();
 await settle(()=>expect(visibleError(modal.dialog)?.textContent).toContain('内容已更新'));expect(input.value).toBe('保留我的输入');expect(input.disabled).toBe(false);expect(modal.isClosed).toBe(false);
 input.value='确认后的名称';modal.form.requestSubmit();await settle(()=>expect(write).toHaveBeenCalledTimes(2));await settle(()=>expect(modal.busy).toBe(false));expect(visibleError(modal.dialog)).toBeUndefined();
 expect(write.mock.calls.map(([name])=>name)).toEqual(['保留我的输入','确认后的名称']);
});

it.each(['取消','Escape','backdrop'])('closes by %s without a write and returns focus to the connected opener',mode=>{
 const auth=authFixture(),opener=document.createElement('button'),write=vi.fn(async()=>{});opener.textContent='更多操作';document.body.append(opener);opener.focus();
 const modal=createCollaborationDialog({auth},{title:'删除共享条目',onSubmit:write});
 if(mode==='取消')findButton(modal.dialog,'取消').click();
 else if(mode==='Escape')modal.dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 else modal.dialog.dispatchEvent(new MouseEvent('click',{clientX:-20,clientY:-20,bubbles:true}));
 expect(write).not.toHaveBeenCalled();expect(modal.isClosed).toBe(true);expect(modal.dialog.isConnected).toBe(false);expect(document.activeElement).toBe(opener);
});

it.each(['cancel','auth-clear'])('fences a late mutation response after %s, without repaint or cross-account focus',async mode=>{
 const auth=authFixture(),opener=document.createElement('button'),pending=deferred<void>(),after=vi.fn();document.body.append(opener);opener.focus();
 const modal=createCollaborationDialog({auth},{title:'保存条目'}),focus=vi.spyOn(opener,'focus');const task=modal.run(()=>pending.promise,after);
 if(mode==='cancel')modal.close();else{auth.clear();auth.user={id:'fixture-next-actor'};}
 pending.reject(new ApiError(503,'UNAVAILABLE','旧请求不应显示'));await task;
 expect(after).not.toHaveBeenCalled();expect(modal.dialog.isConnected).toBe(false);expect(document.body.textContent).not.toContain('旧请求不应显示');
 if(mode==='auth-clear')expect(focus).not.toHaveBeenCalled();
});

it('does not submit an identity-bound form opened after the session was cleared',async()=>{
 const auth=authFixture();auth.clear();const write=vi.fn(async()=>{}),modal=createCollaborationDialog({auth},{title:'旧入口',onSubmit:write});disposers.push(modal.close);
 modal.form.requestSubmit();await Promise.resolve();expect(write).not.toHaveBeenCalled();expect(modal.active()).toBe(false);
});

/** This in-memory fixture recognizes the registered public HTTP contracts.
 * It is used only by DOM tests: no production session, storage or inference. */
function pageFixture(role:'OWNER'|'EDITOR'|'VIEWER'='OWNER'){
 const auth=authFixture(),root=document.createElement('section');document.body.append(root);
 const entry={id:'entry-a',teamId:'team-a',folderId:null,name:'共享分镜',kind:'NODE',revision:7,content:{nodeType:'TEXT',nodeContent:{type:'TEXT',data:{text:'团队中的原始内容'}}},thumbnailAssetId:null,assets:[]};
 const folders=[{id:'folder-a',teamId:'team-a',parentId:null,name:'目标资料夹',revision:3},{id:'folder-b',teamId:'team-a',parentId:null,name:'另一资料夹',revision:4}];
 const state={entry:structuredClone(entry),members:{teamId:'team-a',revision:8,members:[{userId:'fixture-actual-actor',displayName:'团队所有者',avatarUrl:null,role:'OWNER'},{userId:'existing-member',displayName:'现有同事',avatarUrl:null,role:'VIEWER'}]},failNextPatch:false,intercept:undefined as undefined|((path:string,init:any)=>Response|Promise<Response>|undefined)};
 const team={id:'team-a',name:'本地验收团队',ownerId:'fixture-storage-owner',role,revision:4};
 const project=(id:string,projectRole:'EDITOR'|'VIEWER')=>({id,name:'项目 '+id,ownerId:'fixture-project-owner',teamId:null,coverAssetId:null,pinned:false,revision:1,createdAt:'2026-10-07T00:00:00Z',updatedAt:'2026-10-07T00:00:00Z',role:projectRole});
 const envelope=(data:unknown)=>new Response(JSON.stringify({code:0,message:'OK',requestId:'fixture-only',data}),{status:200});
 const transport=vi.fn((path:string,init:any):Response|Promise<Response>=>{
  const intercepted=state.intercept?.(path,init);if(intercepted)return intercepted;
  const url=new URL(path,'http://fixture.invalid'),method=init.method||'GET',reply=(data:any,status=200,etag?:string)=>contractResponse(path,method,data,status,etag);
  if(url.pathname==='/api/v2/collaboration/teams')return reply({items:[team],page:1,pageSize:100,total:1,hasMore:false});
  if(url.pathname==='/api/v2/collaboration/teams/team-a')return reply(team);
  if(url.pathname==='/api/v2/collaboration/users')return reply({items:[{id:'existing-member',displayName:'现有同事',avatarUrl:null},{id:'new-member',displayName:'待添加同事',avatarUrl:null}]});
  if(url.pathname.startsWith('/api/v2/collaboration/teams/team-a/members')){
   if(method!=='GET'){if(init.headers.get('If-Match')!=='"'+state.members.revision+'"')return reply({},412);if(method==='DELETE')state.members.members=state.members.members.filter(m=>m.userId!==url.pathname.split('/').at(-1));else{const b=JSON.parse(init.body),found=state.members.members.find(m=>m.userId===b.userId);if(found)found.role=b.role;else state.members.members.push({userId:b.userId,displayName:'待添加同事',avatarUrl:null,role:b.role});}state.members.revision++;}
   return reply(structuredClone(state.members),200,'"'+state.members.revision+'"');
  }
  if(url.pathname.endsWith('/folders')&&method==='GET')return reply({records:folders,page:1,size:100,total:folders.length,hasNext:false});
  if(url.pathname.endsWith('/folders')&&method==='POST'){const body=JSON.parse(init.body);return reply({...folders[0],id:'created-folder',name:body.name,parentId:body.parentId,revision:1},201);}
  if(url.pathname==='/api/v2/collaboration/teams/team-a/assets'&&method==='GET')return reply({records:[structuredClone(state.entry)],page:Number(url.searchParams.get('page')||1),size:20,total:1,hasNext:false});
  if(url.pathname==='/api/v2/collaboration/teams/team-a/assets'&&method==='POST'){const body=JSON.parse(init.body);return reply({...entry,id:'published-entry',name:body.name||'默认名称',folderId:body.folderId},201);}
  if(url.pathname.endsWith('/assets/entry-a')&&method==='PATCH'){
   if(state.failNextPatch){state.failNextPatch=false;return reply({},412);}
   if(init.headers.get('If-Match')!=='"'+state.entry.revision+'"')return reply({},412);
   const body=JSON.parse(init.body);state.entry={...state.entry,...body,revision:state.entry.revision+1};return reply(state.entry,200,'"'+state.entry.revision+'"');
  }
  if(url.pathname.endsWith('/assets/entry-a/import')&&method==='POST'){const body=JSON.parse(init.body);return reply({targetProjectId:body.projectId,entry:structuredClone(state.entry),node:{type:'TEXT',data:{text:'独立副本内容'}},assets:[],assetIdMap:{}},201);}
  if(url.pathname==='/api/v2/collaboration/projects'){
   const page=Number(url.searchParams.get('page')||1),items=page===1?[project('readonly-project','VIEWER'),project('editable-first','EDITOR')]:[project('editable-second','EDITOR')];
   return reply({items,page,pageSize:20,total:3,hasMore:page===1});
  }
  if(url.pathname==='/api/v1/assets')return envelope({items:[{id:'own-image',projectId:null,fileName:'个人图片.png',kind:'IMAGE',mimeType:'image/png',byteSize:10,state:'READY',previewUrl:null,downloadUrl:null,urlsExpireAt:null}],page:1,pageSize:100,total:1,hasMore:false});
  if(url.pathname==='/api/v2/library/entries')return envelope({records:[{id:'own-node',name:'个人文字节点',nodeType:'TEXT'}],page:1,size:100,total:1,hasNext:false});
  throw new Error('Unexpected fixture endpoint '+method+' '+url.pathname);
 });
 const api=new ProductClient('/api/v1',transport as any);api.setAccessToken('local-fixture-token');
 const storage:any={wait:vi.fn(async()=>{}),loadProject:vi.fn(async(id:string)=>project(id,id==='readonly-project'?'VIEWER':'EDITOR')),access:()=>({canManageMembers:false}),requirePermission:vi.fn((id:string)=>{if(!auth.user||id==='readonly-project')throw new ApiError(403,'PROJECT_READ_ONLY','目标项目只读。');}),isBlocked:()=>false,resolveAsset:vi.fn(async()=>{}),fixture:()=>({nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}),save:vi.fn(async()=>{})};
 const adapter=new CollaborationAdapter(api,storage,()=>auth.user?.id??null),runtime={auth,collaboration:adapter,storage};auth.onClear(()=>{adapter.clear();api.clearRequests();});
 const navigate=vi.fn();let dispose:()=>void=()=>{};
 const mount=(search='')=>{dispose=mountCollaborationPage(root,'assets',runtime,{pathname:'/projects/team-assets/team-a',search},navigate);disposers.push(()=>dispose());};
 const writes=()=>transport.mock.calls.filter(([,init])=>init.method&&init.method!=='GET');
 return{auth,root,runtime,adapter,storage,transport,state,navigate,mount,writes,dispose:()=>dispose(),update:(search:string,state?:unknown)=>(dispose as any).update({pathname:'/projects/team-assets/team-a',search,state})};
}

it('shows a viewer only readable team content and import, with no publish or team-content write controls',async()=>{
 const f=pageFixture('VIEWER');f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 const labels=[...f.root.querySelectorAll('button')].map(button=>button.textContent?.trim()+' '+button.getAttribute('aria-label'));
 expect(labels.join('|')).toContain('导入项目');expect(labels.join('|')).not.toMatch(/新建文件夹|发布|条目更多操作|改名|移动|删除/);expect(f.writes()).toEqual([]);
});

it.each(['auth-clear','route-dispose'])('does not paint a stale asset list after %s even when transport ignores abort',async mode=>{
 const f=pageFixture(),pending=deferred<Response>();f.state.intercept=(path,init)=>path.includes('/assets?')?pending.promise:undefined;f.mount();
 await settle(()=>expect(f.transport.mock.calls.some(([path])=>path.includes('/assets?'))).toBe(true));
 if(mode==='auth-clear')f.auth.clear();else{f.dispose();f.root.textContent='另一个页面的内容';}
 const expected=f.root.textContent;pending.resolve(contractResponse('/api/v2/collaboration/teams/team-a/assets','GET',{records:[f.state.entry],page:1,size:20,total:1,hasNext:false}));
 await new Promise(resolve=>setTimeout(resolve,20));expect(f.root.textContent).toBe(expected);expect(f.root.textContent).not.toContain('共享分镜');expect(document.querySelector('dialog')).toBeNull();
});

it('creates a folder only through a validated modal, with one trimmed POST and no accidental cancellation write',async()=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));findButton(f.root,'新建文件夹').click();
 let dialog=document.querySelector<HTMLDialogElement>('dialog')!;expect(dialog).toBeTruthy();let name=field<HTMLInputElement>(dialog,'文件夹名称');name.value=' \t ';submit(dialog);
 await settle(()=>expect(visibleError(dialog)?.textContent).toContain('请输入'));expect(f.writes()).toEqual([]);findButton(dialog,'取消').click();expect(f.writes()).toEqual([]);
 findButton(f.root,'新建文件夹').click();dialog=document.querySelector<HTMLDialogElement>('dialog')!;name=field<HTMLInputElement>(dialog,'文件夹名称');name.value='  新资料夹  ';submit(dialog);submit(dialog);
 await settle(()=>expect(f.writes()).toHaveLength(1));const [path,init]=f.writes()[0];expect(path).toBe('/api/v2/collaboration/teams/team-a/folders');expect(JSON.parse(init.body)).toEqual({name:'新资料夹',parentId:null});expect(init.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 await settle(()=>expect(document.querySelector('dialog')).toBeNull());
});

it.each([
 {value:'名'.repeat(121),message:'最多 120'},
 {value:'名称\u007f尾部',message:'不能包含控制字符'},
])('rejects an invalid folder name ($message) before transport and retains it for correction',async test=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));findButton(f.root,'新建文件夹').click();const dialog=document.querySelector<HTMLDialogElement>('dialog')!,name=field<HTMLInputElement>(dialog,'文件夹名称');name.value=test.value;submit(dialog);
 await settle(()=>expect(visibleError(dialog)?.textContent).toContain(test.message));expect(name.value).toBe(test.value);expect(name.disabled).toBe(false);expect(document.activeElement).toBe(name);expect(f.writes()).toEqual([]);
});

it('accepts the server limit of 120 Unicode characters rather than counting emoji UTF-16 units twice',async()=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));findButton(f.root,'新建文件夹').click();const dialog=document.querySelector<HTMLDialogElement>('dialog')!,name=field<HTMLInputElement>(dialog,'文件夹名称'),value='🎬'.repeat(120);name.value=value;submit(dialog);
 await settle(()=>expect(f.writes()).toHaveLength(1));expect(JSON.parse(f.writes()[0][1].body).name).toBe(value);await settle(()=>expect(document.querySelector('dialog')).toBeNull());
});

it('keeps the entry revision displayed by the card when rename fails after an unrelated cache refresh',async()=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 f.state.entry.revision=99;await f.adapter.entries('team-a');f.state.failNextPatch=true;
 findButton(f.root,'条目更多操作').click();findButton(f.root,'重命名').click();const dialog=document.querySelector<HTMLDialogElement>('dialog')!,name=field<HTMLInputElement>(dialog,'条目名称');name.value='  我的新名称  ';submit(dialog);
 await settle(()=>expect(visibleError(dialog)?.textContent).toContain('版本'));expect(name.value).toBe('  我的新名称  ');expect(name.disabled).toBe(false);expect(dialog.isConnected).toBe(true);
 const [path,init]=f.writes()[0];expect(path).toBe('/api/v2/collaboration/teams/team-a/assets/entry-a');expect(init.headers.get('If-Match')).toBe('"7"');expect(JSON.parse(init.body)).toEqual({name:'我的新名称'});expect(f.writes()).toHaveLength(1);
 findButton(dialog,'取消').click();expect(f.writes()).toHaveLength(1);
});

it.each([false,true])('moves the selected entry with its displayed revision and refuses a stale move (stale=%s)',async stale=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 if(stale){f.state.entry.revision=99;await f.adapter.entries('team-a');}
 findButton(f.root,'条目更多操作').click();findButton(f.root,'移动').click();const dialog=document.querySelector<HTMLDialogElement>('dialog')!,folder=field<HTMLSelectElement>(dialog,'目标文件夹');folder.value='folder-b';submit(dialog);
 await settle(()=>expect(f.writes()).toHaveLength(1));const [path,init]=f.writes()[0];expect(path).toBe('/api/v2/collaboration/teams/team-a/assets/entry-a');expect(init.headers.get('If-Match')).toBe('"7"');expect(JSON.parse(init.body)).toMatchObject({folderId:'folder-b'});
 expect(JSON.parse(init.body).name).toBe('共享分镜');if(stale){await settle(()=>expect(visibleError(dialog)?.textContent).toContain('版本'));expect(folder.value).toBe('folder-b');expect(f.state.entry.folderId).toBeNull();findButton(dialog,'取消').click();}else await settle(()=>expect(document.querySelector('dialog')).toBeNull());
});

it('publishes the chosen owned node rather than the first asset, into the currently viewed folder',async()=>{
 const f=pageFixture();f.mount('?folderId=folder-a');await settle(()=>expect(f.root.textContent).toContain('共享分镜'));findButton(f.root,'发布到团队').click();
 const dialog=document.querySelector<HTMLDialogElement>('dialog')!;await settle(()=>expect(dialog.textContent).toContain('个人图片.png'));expect(dialog.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);expect(dialog.textContent).toContain('本地验收团队 / 目标资料夹');findButton(dialog,'已存节点').click();findButton(dialog,'选择 个人文字节点').click();field<HTMLInputElement>(dialog,'共享条目名称（可选）').value='  发布文字  ';submit(dialog);
 await settle(()=>expect(f.writes()).toHaveLength(1));const [path,init]=f.writes()[0];expect(path).toBe('/api/v2/collaboration/teams/team-a/assets');expect(JSON.parse(init.body)).toEqual({sourceNodeId:'own-node',name:'发布文字',folderId:'folder-a'});expect(JSON.parse(init.body)).not.toHaveProperty('sourceAssetId');await settle(()=>expect(document.querySelector('dialog')).toBeNull());
});

it('imports the selected team entry into a paged editable target, excluding viewer targets and preserving the actual actor',async()=>{
 const f=pageFixture('VIEWER');f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));findButton(f.root,'导入项目').click();
 const dialog=document.querySelector<HTMLDialogElement>('dialog')!;await settle(()=>expect(dialog.querySelector('select')).not.toBeNull());const target=field<HTMLSelectElement>(dialog,'目标项目');expect([...target.options].map(option=>option.value).filter(Boolean)).toEqual(['editable-first','editable-second']);target.value='editable-second';submit(dialog);
 await settle(()=>expect(f.storage.save).toHaveBeenCalledOnce());const [path,init]=f.writes()[0];expect(path).toBe('/api/v2/collaboration/teams/team-a/assets/entry-a/import');expect(JSON.parse(init.body)).toEqual({projectId:'editable-second'});expect(init.headers.get('Authorization')).toBe('Bearer local-fixture-token');expect(init.headers.get('X-Router-Subject-Ref')).toBeNull();
 expect(f.storage.save.mock.calls[0][0]).toBe('editable-second');expect(f.storage.save.mock.calls[0][1].nodes).toHaveLength(1);expect(f.storage.save.mock.calls[0][1].nodes[0].data.text).toBe('独立副本内容');
 await settle(()=>expect(dialog.textContent).toContain('已导入'));findButton(dialog,'打开项目').click();expect(f.navigate).toHaveBeenLastCalledWith('/project/canvas/editable-second',undefined);expect(document.querySelector('dialog')).toBeNull();
});

it.each(['cancel','route-dispose','auth-clear'])('closes a pending publish dialog on %s and ignores its late source list without any write',async mode=>{
 const f=pageFixture(),pending=deferred<Response>();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 f.state.intercept=(path)=>path.startsWith('/api/v1/assets?')?pending.promise:undefined;findButton(f.root,'发布到团队').click();const dialog=document.querySelector<HTMLDialogElement>('dialog')!;expect(dialog).toBeTruthy();expect(f.writes()).toEqual([]);
 if(mode==='cancel')findButton(dialog,'取消').click();else if(mode==='route-dispose'){f.dispose();f.root.textContent='新页面';}else f.auth.clear();
 pending.resolve(new Response(JSON.stringify({code:0,message:'OK',requestId:'fixture-only',data:{items:[{id:'late-source',fileName:'不应出现的旧素材',state:'READY'}],page:1,pageSize:100,total:1,hasMore:false}}),{status:200}));
 await new Promise(resolve=>setTimeout(resolve,20));expect(document.querySelector('dialog')).toBeNull();expect(document.body.textContent).not.toContain('不应出现的旧素材');expect(f.writes()).toEqual([]);
});


it('keeps the folder grid mounted across nested member panels, with explicit selection, search-only Enter and CAS writes',async()=>{
 const f=pageFixture();f.mount('?folderId=folder-a');await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 const grid=f.root.querySelector('.studio-collab-grid'),reads=()=>f.transport.mock.calls.filter(([url])=>url.includes('/assets?')).length,readCount=reads();
 findButton(f.root,'团队成员').click();await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('现有同事'));
 findButton(document.querySelector('dialog')!,'添加成员').click();await settle(()=>expect(document.querySelector('input[aria-label="同事姓名"]')).not.toBeNull());
 const d=document.querySelector<HTMLDialogElement>('dialog')!,query=field<HTMLInputElement>(d,'同事姓名');query.value='同事';query.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await settle(()=>expect(d.textContent).toContain('待添加同事'));expect(f.writes()).toEqual([]);expect(findButton(d,'已在团队：现有同事').disabled).toBe(true);expect(d.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
 findButton(d,'选择同事 待添加同事').click();submit(d);await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('3 位成员'));
 expect(f.writes()).toHaveLength(1);expect(JSON.parse(f.writes()[0][1].body)).toEqual({userId:'new-member',role:'VIEWER'});expect(f.writes()[0][1].headers.get('If-Match')).toBe('"8"');expect(f.root.querySelector('.studio-collab-grid')).toBe(grid);expect(reads()).toBe(readCount);expect(document.querySelectorAll('dialog')).toHaveLength(1);
});

it('leaves invalidated member edit panels behind after removal, using persisted modal ancestry',async()=>{
 const f=pageFixture();f.mount('?folderId=folder-a');await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 const base='/projects/team-assets/team-a?folderId=folder-a',members=base+'&panel=members',edit=base+'&panel=edit-member&member=existing-member';
 f.update('?folderId=folder-a&panel=remove-member&member=existing-member',{studioLibraryTrail:[base,members,edit]});await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('对方将无法'));
 submit(document.querySelector('dialog')!);await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('1 位成员'));expect(f.navigate).toHaveBeenLastCalledWith(-2);expect(f.writes()).toHaveLength(1);expect(f.writes()[0][1].headers.get('If-Match')).toBe('"8"');expect(document.querySelectorAll('dialog')).toHaveLength(1);
});

it('creates a child in the displayed folder and rejects a viewer opening the write URL directly',async()=>{
 const f=pageFixture();f.mount('?folderId=folder-a&panel=new-folder');await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('创建位置：本地验收团队 / 目标资料夹'));
 const d=document.querySelector<HTMLDialogElement>('dialog')!;field<HTMLInputElement>(d,'文件夹名称').value='子目录';submit(d);await settle(()=>expect(f.writes()).toHaveLength(1));expect(JSON.parse(f.writes()[0][1].body)).toEqual({name:'子目录',parentId:'folder-a'});await settle(()=>expect(document.querySelector('dialog')).toBeNull());f.dispose();
 const viewer=pageFixture('VIEWER');viewer.mount('?panel=new-folder');await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('只读权限'));expect(viewer.writes()).toEqual([]);expect(document.querySelector('dialog input')).toBeNull();
});

it('ignores an obsolete member response after browser Back without reloading the asset grid',async()=>{
 const f=pageFixture(),pending=deferred<Response>();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));const grid=f.root.querySelector('.studio-collab-grid');
 f.state.intercept=(url,init)=>url.endsWith('/members')&&init.method==='GET'?pending.promise:undefined;
 f.update('?panel=members');await settle(()=>expect(f.transport.mock.calls.some(([url])=>url.endsWith('/members'))).toBe(true));f.update('');
 pending.resolve(contractResponse('/api/v2/collaboration/teams/team-a/members','GET',f.state.members));await new Promise(resolve=>setTimeout(resolve,20));expect(document.querySelector('dialog')).toBeNull();expect(f.root.querySelector('.studio-collab-grid')).toBe(grid);expect(f.writes()).toEqual([]);
});

it('searchable publishing includes later source pages and stops paging after the dialog closes',async()=>{
 const f=pageFixture();f.mount();await settle(()=>expect(f.root.textContent).toContain('共享分镜'));
 f.state.intercept=(path)=>{if(!path.startsWith('/api/v1/assets?'))return;const page=Number(new URL(path,'http://fixture.invalid').searchParams.get('page'));return new Response(JSON.stringify({code:0,message:'OK',requestId:'fixture-only',data:{items:[{id:'source-'+page,fileName:'第'+page+'页.png',state:'READY',kind:'IMAGE'}],page,pageSize:100,total:2,hasMore:page===1}}));};
 findButton(f.root,'发布到团队').click();await settle(()=>expect(document.querySelector('dialog')?.textContent).toContain('第2页.png'));expect(document.querySelectorAll('.studio-library-source')).toHaveLength(2);findButton(document.querySelector('dialog')!,'取消').click();expect(f.writes()).toEqual([]);
 let calls=0;f.state.intercept=(path)=>{if(!path.startsWith('/api/v1/assets?'))return;calls++;return new Response(JSON.stringify({code:0,message:'OK',requestId:'fixture-only',data:{items:[{id:'source',state:'READY',kind:'IMAGE'}],hasMore:true}}));};
 const assets=await f.adapter.personalAssets(undefined,()=>calls===0);expect(assets).toEqual([]);expect(calls).toBe(1);
});
