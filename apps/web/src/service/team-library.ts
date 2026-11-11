import {ApiError} from '../api/client';
import {roleLabel} from './project-access';
import {importTeamIntoProject} from './team-import';
import {createCollaborationDialog,collaborationField,requireName,type CollaborationDialog} from './collaboration-dialogs';
import {LibraryNavigation,teamLibraryURL,type LibraryLocation,type LibraryNavigate} from './library-navigation';
import type {CollaborationAdapter,Team,TeamFolder,TeamEntry,MemberList} from './collaboration';

const personalURL='/projects/canvas/assetLibrary';
function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
const row=(...children:Node[])=>{const e=el('div',undefined,'studio-collab-row');e.append(...children);return e;};
const note=(text:string)=>el('p',text,'studio-collab-muted');
const btn=(text:string,run:()=>unknown,primary=false)=>{const b=el('button',text,primary?'studio-primary':undefined);b.type='button';b.onclick=()=>{void run();};return b;};
const input=(label:string)=>{const e=el('input');e.placeholder=label;e.autocomplete='off';e.setAttribute('aria-label',label);return e;};
const badge=(role:string)=>el('span',roleLabel(role as any),'studio-collab-role');
const roles=()=>{const select=el('select');for(const role of ['VIEWER','EDITOR'])select.append(Object.assign(el('option',roleLabel(role as any)),{value:role}));return select;};
function icon(kind='folder'){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','36');svg.setAttribute('height','36');svg.setAttribute('fill','none');svg.setAttribute('aria-hidden','true');
 path.setAttribute('d',kind==='folder'?'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z':kind==='team'?'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z':'M6 3h8l4 4v14H6V3Zm7 1v4h4M9 12h6M9 16h6');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.4');path.setAttribute('stroke-linejoin','round');path.setAttribute('stroke-linecap','round');svg.append(path);return svg;
}
export function teamFolderPath(folders:TeamFolder[],id:string|null){
 const trail:TeamFolder[]=[],seen=new Set<string>();let current=id;
 while(current){if(seen.has(current))throw new ApiError(409,'FOLDER_PATH_INVALID','文件夹路径无效，请返回团队资产。');seen.add(current);const folder=folders.find(f=>f.id===current);if(!folder)throw new ApiError(404,'FOLDER_NOT_FOUND','文件夹不存在或已被删除。');trail.unshift(folder);current=folder.parentId;}
 return trail;
}

/** One asset location remains mounted while the native router moves through
 * dialog steps. URL state makes Back, Forward and refresh deterministic. */
export function mountTeamLibrary(root:HTMLElement,runtime:any,location:LibraryLocation,navigate:LibraryNavigate){
 const adapter:CollaborationAdapter=runtime.collaboration,identity=runtime.auth.user?.id,nav=new LibraryNavigation(location,navigate);
 let disposed=false,version=0,panelVersion=0,ready=false,modal:CollaborationDialog|undefined,menuClose=()=>{},teams:Team[]=[],team:Team|undefined,folders:TeamFolder[]=[],entries:TeamEntry[]=[],total=0,hasNext=false,message='';
 const active=()=>!disposed&&!!identity&&runtime.auth.user?.id===identity;
 const folderId=()=>nav.url.searchParams.get('folderId')||null;
 const page=()=>Math.max(1,Number(nav.url.searchParams.get('page'))||1);
 const selectedId=()=>decodeURIComponent(nav.url.pathname.split('/')[3]??'');
 const pathLabel=()=>[team?.name,...teamFolderPath(folders,folderId()).map(f=>f.name)].filter(Boolean).join(' / ');
 const closePanel=()=>{panelVersion++;modal?.close();modal=undefined;menuClose();};
 const go=(to:string,replace=false)=>{closePanel();navigate(to,replace?{replace:true}:undefined);};
 const routeLink=(label:string,to:string,cls?:string)=>{const a=el('a',label,cls);a.href=to;a.onclick=e=>{if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey){e.preventDefault();go(to);}};return a;};
 const showPanel=(panel:string,values:Record<string,string>={})=>nav.open(panel,values);
 const dismiss=()=>nav.dismiss();
 const status=()=>{if(!message)return;const e=el('p',message,'studio-library-status');e.setAttribute('role','status');root.append(e);};
 const tabs=()=>{const bar=el('nav',undefined,'studio-collab-tabs');bar.setAttribute('aria-label','资产范围');bar.append(routeLink('个人资产',personalURL));const current=routeLink('团队资产',teamLibraryURL(team?.id));current.setAttribute('aria-current','page');bar.append(current);return bar;};
 const more=(label:string,actions:Array<[string,()=>unknown,boolean?]>)=>{
  const wrap=el('div',undefined,'studio-collab-more'),toggle=btn('···',()=>{const opening=menu.hidden;menuClose();if(opening){menu.hidden=false;wrap.classList.remove('studio-collab-more--up');const bounds=menu.getBoundingClientRect(),limit=wrap.closest('dialog')?.getBoundingClientRect().bottom??window.innerHeight;if(bounds.bottom>limit-16)wrap.classList.add('studio-collab-more--up');toggle.setAttribute('aria-expanded','true');menuClose=close;document.addEventListener('pointerdown',outside);menu.querySelector<HTMLElement>('button')?.focus();}}),menu=el('div',undefined,'studio-collab-menu');
  const close=()=>{menu.hidden=true;toggle.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside);};
  const outside=(e:Event)=>{if(!wrap.contains(e.target as Node))close();};
  toggle.setAttribute('aria-label',label);toggle.setAttribute('aria-haspopup','menu');toggle.setAttribute('aria-expanded','false');menu.hidden=true;menu.setAttribute('role','menu');
  for(const [text,run,danger]of actions){const b=btn(text,()=>{close();toggle.focus();return run();});b.setAttribute('role','menuitem');if(danger)b.classList.add('studio-danger');menu.append(b);}
  wrap.onkeydown=e=>{const items=[...menu.querySelectorAll<HTMLButtonElement>('button')];if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();toggle.focus();}else if(!menu.hidden&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const index=items.indexOf(document.activeElement as HTMLButtonElement),next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}};wrap.append(toggle,menu);return wrap;
 };
 const newModal=(title:string,description?:string,submitLabel?:string)=>{
  modal=createCollaborationDialog(runtime,{title,description,submitLabel,onDismiss:dismiss,cancelLabel:submitLabel?'取消':'完成'});return modal;
 };
 const focus=(m:CollaborationDialog)=>queueMicrotask(()=>{if(m.active())m.body.querySelector<HTMLElement>('input,select,button')?.focus();});
 const nameForm=(m:CollaborationDialog,label:string,value:string,save:(name:string)=>Promise<unknown>,success:string)=>{
  const field=input(label);field.value=value;field.maxLength=240;m.body.append(collaborationField(label,field));m.setSubmit(async()=>{const name=requireName(field.value,label);if(!active())return;await save(name);if(!m.active()||!active())return;message=success;dismiss();await render();});focus(m);
 };
 const confirm=(m:CollaborationDialog,run:()=>Promise<unknown>,success:string,after?:()=>void)=>{
  m.submit.classList.add('studio-danger');m.setSubmit(async()=>{if(!active())return;await run();if(!m.active()||!active())return;message=success;if(after){m.close();after();}else{dismiss();await render();}});
 };
 const preview=(entry:TeamEntry,cover:HTMLElement,turn:number)=>{
  if(!entry.thumbnailAssetId)return;void adapter.assetUrl(entry.thumbnailAssetId).then(src=>{if(!active()||version!==turn||!cover.isConnected)return;const img=el('img');img.src=src;img.alt='';img.loading='lazy';img.onerror=()=>img.remove();cover.replaceChildren(img);}).catch(()=>{});
 };
 async function render(){
  const turn=++version;ready=false;closePanel();if(!active())return;root.classList.add('studio-team-library');
  const loading=el('p','正在读取团队资产…','studio-collab-muted');loading.setAttribute('role','status');root.replaceChildren(tabs(),loading);
  try{
   teams=await adapter.loadTeams();if(!active()||turn!==version)return;
   const requested=selectedId(),id=requested||adapter.currentTeamId||teams[0]?.id;
   if(id&&!teams.some(t=>t.id===id))throw new ApiError(403,'TEAM_UNAVAILABLE','该团队不存在，或你已不在该团队中。');
   if(!requested&&id){const to=new URL(teamLibraryURL(id),window.location.origin);for(const [key,value]of nav.url.searchParams)to.searchParams.set(key,value);go(to.pathname+to.search,true);return;}
   team=id?teams.find(t=>t.id===id):undefined;
   if(team){await adapter.selectTeam(team.id);if(!active()||turn!==version)return;team=adapter.teams?.get(team.id)??team;const result=await Promise.all([adapter.folders(team.id),adapter.entries(team.id,folderId(),page())]);if(!active()||turn!==version)return;folders=result[0].records;entries=result[1].records;total=result[1].total;hasNext=result[1].hasNext;teamFolderPath(folders,folderId());}
   root.replaceChildren();const header=el('header',undefined,'studio-library-header');const title=el('h1','资产库','studio-sr-only');header.append(title,tabs(),btn('团队管理',()=>showPanel('teams')));root.append(header);
   if(!team){const empty=el('section',undefined,'studio-library-empty');empty.append(icon('team'),el('h2','还没有加入团队'),note('创建团队后添加同事，一起整理和使用团队资产。'),btn('创建团队',()=>showPanel('create-team'),true));root.append(empty);ready=true;syncPanel();return;}
   const selected=team,writable=selected.role!=='VIEWER',choose=el('select');choose.setAttribute('aria-label','选择团队');for(const t of teams)choose.append(Object.assign(el('option',t.name),{value:t.id}));choose.value=selected.id;choose.onchange=()=>go(teamLibraryURL(choose.value));
   const teamContext=row(choose,badge(selected.role),btn('团队成员',()=>showPanel('members'))),actions=row();if(writable)actions.append(btn(folderId()?'新建子文件夹':'新建文件夹',()=>showPanel('new-folder')),btn('发布到团队',()=>showPanel('publish'),true));
   const toolbar=el('div',undefined,'studio-collab-toolbar');toolbar.append(teamContext,actions);root.append(toolbar);status();
   const trail=teamFolderPath(folders,folderId()),crumb=el('nav',undefined,'studio-collab-breadcrumb');crumb.setAttribute('aria-label','团队资产路径');
   if(trail.length){const back=btn('←',()=>go(teamLibraryURL(selected.id,trail.at(-1)!.parentId)));back.setAttribute('aria-label','返回上一级文件夹');back.className='studio-library-back';crumb.append(back);}
   crumb.append(routeLink('全部资产',teamLibraryURL(selected.id)));for(const f of trail){crumb.append(el('span','/'));const a=routeLink(f.name,teamLibraryURL(selected.id,f.id));a.title=f.name;if(f.id===folderId())a.setAttribute('aria-current','page');crumb.append(a);}
   const current=trail.at(-1);if(current&&writable)crumb.append(more('当前文件夹更多操作',[['重命名',()=>showPanel('rename-folder',{item:current.id})],['删除文件夹',()=>showPanel('delete-folder',{item:current.id}),true]]));root.append(crumb);
   if(!writable)root.append(note('你可以查看和导入这些资产；整理和发布由可编辑成员完成。'));
   const grid=el('div',undefined,'studio-collab-grid');for(const f of folders.filter(f=>f.parentId===folderId())){
    const card=el('article',undefined,'studio-collab-card studio-collab-folder-card'),open=routeLink('',teamLibraryURL(selected.id,f.id),'studio-library-card-link'),cover=el('div',undefined,'studio-collab-cover studio-collab-cover--empty'),body=el('div',undefined,'studio-collab-card-body'),title=el('h2',f.name,'studio-collab-card-title');title.title=f.name;open.setAttribute('aria-label','打开文件夹 '+f.name);cover.append(icon());body.append(title,note('文件夹'));open.append(cover,body);card.append(open);if(writable)card.append(more('文件夹更多操作',[['重命名',()=>showPanel('rename-folder',{item:f.id})],['删除文件夹',()=>showPanel('delete-folder',{item:f.id}),true]]));grid.append(card);
   }
   for(const entry of entries){
    const card=el('article',undefined,'studio-collab-card'),cover=el('div',undefined,'studio-collab-cover studio-collab-cover--empty'),body=el('div',undefined,'studio-collab-card-body'),title=el('h2',entry.name,'studio-collab-card-title');title.title=entry.name;cover.append(icon('asset'));body.append(title,Object.assign(row(note(entry.kind==='NODE'?'节点':'素材'),btn('导入项目',()=>showPanel('import',{item:entry.id}),true)),{className:'studio-collab-card-actions'}));card.append(cover,body);
    if(writable)card.append(more('条目更多操作',[['重命名',()=>showPanel('rename-entry',{item:entry.id})],['移动',()=>showPanel('move-entry',{item:entry.id})],['删除',()=>showPanel('delete-entry',{item:entry.id}),true]]));grid.append(card);preview(entry,cover,turn);
   }
   root.append(grid);if(!grid.children.length){const empty=el('section',undefined,'studio-library-empty');empty.append(icon(),el('h2',folderId()?'这个文件夹还是空的':'团队资产库还是空的'),note(writable?'可以发布个人素材或已保存的节点，供团队成员使用。':'团队成员发布内容后，会显示在这里。'));if(writable)empty.append(btn('发布到团队',()=>showPanel('publish'),true));root.append(empty);}
   if(page()>1||hasNext){const prev=btn('上一页',()=>go(teamLibraryURL(selected.id,folderId(),page()-1))),next=btn('下一页',()=>go(teamLibraryURL(selected.id,folderId(),page()+1)));prev.disabled=page()<=1;next.disabled=!hasNext;root.append(Object.assign(row(prev,note(`第 ${page()} 页 · ${total} 条资产`),next),{className:'studio-collab-pager'}));}
   ready=true;syncPanel();
  }catch(error){if(!active()||turn!==version)return;team=undefined;root.replaceChildren(tabs(),el('p',error instanceof Error?error.message:'暂时无法加载团队资产。','studio-collab-error'),row(btn('重试',render),btn('返回团队资产',()=>go(teamLibraryURL())),btn('团队管理',()=>showPanel('teams'))));ready=true;syncPanel();}
 }
 async function syncPanel(){
  if(!ready||!active())return;closePanel();const turn=panelVersion,panel=nav.url.searchParams.get('panel');if(!panel)return;
  const current=()=>active()&&turn===panelVersion&&!!modal?.active();
  const target=nav.url.searchParams.get('targetTeam')||team?.id,item=nav.url.searchParams.get('item'),memberId=nav.url.searchParams.get('member');
  try{
   if(panel==='teams'){
    const m=newModal('团队管理','选择一个团队查看资产，或管理该团队的成员。');m.dialog.classList.add('studio-collab-dialog--members');m.body.append(note('正在读取团队…'));const list=await adapter.loadTeams();if(!current())return;m.body.replaceChildren();
    const top=el('div',undefined,'studio-collab-toolbar');top.append(note(`我加入的团队 · ${list.length}`),btn('创建团队',()=>showPanel('create-team'),true));m.body.append(top);
    for(const t of list){const e=el('div',undefined,'studio-library-team-row'),info=el('div');info.append(el('strong',t.name),badge(t.role));const actions=row(btn('打开资产',()=>go(teamLibraryURL(t.id))),btn('成员',()=>showPanel('members',{targetTeam:t.id})));if(t.role==='OWNER')actions.append(more(t.name+'更多操作',[['重命名',()=>showPanel('rename-team',{targetTeam:t.id})],['删除团队',()=>showPanel('delete-team',{targetTeam:t.id}),true]]));e.append(info,actions);m.body.append(e);}
    if(!list.length)m.body.append(note('还没有团队。创建后可以添加同事，发布共享资产。'));return;
   }
   if(panel==='create-team'){
    const m=newModal('创建团队','创建后可在团队资产库中添加成员。','创建'),name=input('团队名称');name.maxLength=240;m.body.append(collaborationField('团队名称',name));m.setSubmit(async()=>{const value=requireName(name.value,'团队名称');const created=await adapter.createTeam(value);if(!current())return;m.close();go(teamLibraryURL(created.id),true);});focus(m);return;
   }
   if(['members','add-member','edit-member','remove-member','rename-team','delete-team'].includes(panel)){
    const m=newModal(panel==='members'?'团队成员':panel==='add-member'?'添加成员':panel==='edit-member'?'成员权限':panel==='remove-member'?'移除成员':panel==='rename-team'?'重命名团队':'删除团队',undefined,panel==='members'?undefined:panel==='rename-team'?'保存':'确认');m.body.append(note('正在读取团队…'));
    if(!target)throw new ApiError(400,'TEAM_REQUIRED','请先选择团队。');const selected=await adapter.team(target);if(!current())return;m.body.replaceChildren();
    if(panel==='rename-team'||panel==='delete-team'){
     if(selected.role!=='OWNER')throw new ApiError(403,'TEAM_OWNER_REQUIRED','只有团队所有者可以管理团队。');
     if(panel==='rename-team')nameForm(m,'团队名称',selected.name,name=>adapter.renameTeam(selected.id,name,selected.revision),'团队名称已保存。');
     else{m.body.append(note(`删除“${selected.name}”及其中的共享条目？已经导入项目的副本会保留。`));m.setSubmit(async()=>{} ,'删除团队');confirm(m,()=>adapter.deleteTeam(selected.id,selected.revision),'团队已删除。',()=>go(teamLibraryURL(),true));}return;
    }
    const list=await adapter.members('teams',selected.id);if(!current())return;
    if(panel==='members'){
     m.dialog.classList.add('studio-collab-dialog--members');m.dialog.querySelector('h2')!.textContent=selected.name+' · 团队成员';const top=el('div',undefined,'studio-collab-toolbar');top.append(note(`${list.members.length} 位成员`));if(selected.role==='OWNER')top.append(btn('添加成员',()=>showPanel('add-member',{targetTeam:selected.id}),true));m.body.append(top,note('可编辑成员可以发布和整理资产；只读成员可以查看和导入到项目。'));
     for(const member of list.members){const e=el('div',undefined,'studio-library-member-row'),name=el('div',undefined,'studio-library-member-name'),avatar=el('span',member.displayName.slice(0,1),'studio-library-avatar');avatar.setAttribute('aria-hidden','true');name.append(avatar,el('span',member.displayName+(member.userId===identity?'（我）':'')));e.append(name,badge(member.role));if(selected.role==='OWNER'&&member.role!=='OWNER')e.append(btn('管理',()=>showPanel('edit-member',{targetTeam:selected.id,member:member.userId})));m.body.append(e);}return;
    }
    if(selected.role!=='OWNER')throw new ApiError(403,'TEAM_OWNER_REQUIRED','只有团队所有者可以管理成员。');
    if(panel==='add-member'){addMember(m,selected,list,current);return;}
    const member=list.members.find(v=>v.userId===memberId);if(!member||member.role==='OWNER')throw new ApiError(404,'MEMBER_UNAVAILABLE','此成员已变更，请返回成员列表。');
    if(panel==='remove-member'){m.body.append(note(`移除“${member.displayName}”后，对方将无法继续访问“${selected.name}”的团队资产。`));m.setSubmit(async()=>{},'移除成员');confirm(m,()=>adapter.removeMember('teams',selected.id,member.userId,list.revision),'成员已移除。',()=>{nav.dismiss('members');});return;}
    m.body.append(note(member.displayName));const role=roles();role.value=member.role;m.body.append(collaborationField('成员权限',role),note('只读：查看和导入。可编辑：还可发布、移动和删除团队资产。'));m.setSubmit(async()=>{await adapter.setMember('teams',selected.id,member.userId,role.value as 'EDITOR'|'VIEWER',list.revision);if(!current())return;dismiss();},'保存权限');m.submit.disabled=true;role.onchange=()=>{m.submit.disabled=role.value===member.role;};const remove=btn('移除成员',()=>showPanel('remove-member',{targetTeam:selected.id,member:member.userId}));remove.classList.add('studio-danger','studio-library-remove-member');m.body.append(remove);return;
   }
   if(!team)throw new ApiError(400,'TEAM_REQUIRED','请先选择团队。');
   if(panel!=='import'&&team.role==='VIEWER')throw new ApiError(403,'TEAM_READ_ONLY','你在此团队中拥有只读权限。');
   if(panel==='new-folder'){const m=newModal(folderId()?'新建子文件夹':'新建文件夹','创建位置：'+pathLabel(),'创建');nameForm(m,'文件夹名称','',name=>adapter.createFolder(team!.id,name,folderId()),'文件夹已创建。');return;}
   if(panel==='rename-folder'||panel==='delete-folder'){
    const folder=folders.find(f=>f.id===item);if(!folder)throw new ApiError(404,'FOLDER_NOT_FOUND','文件夹不存在或已被删除。');const m=newModal(panel==='rename-folder'?'重命名文件夹':'删除文件夹',undefined,panel==='rename-folder'?'保存':'删除');
    if(panel==='rename-folder')nameForm(m,'文件夹名称',folder.name,name=>adapter.renameFolder(team!.id,folder.id,name,folder.revision),'文件夹名称已保存。');
    else{m.body.append(note(`删除“${folder.name}”？仅空文件夹可以删除。`));confirm(m,()=>adapter.deleteFolder(team!.id,folder.id,folder.revision),'文件夹已删除。',folder.id===folderId()?()=>go(teamLibraryURL(team!.id,folder.parentId),true):undefined);}return;
   }
   if(panel==='publish'){await publish(current);return;}
   const entry=entries.find(e=>e.id===item);if(!entry)throw new ApiError(404,'ENTRY_NOT_FOUND','资产不存在或已移出当前文件夹，请返回列表刷新。');
   if(panel==='import'){await importEntry(entry,current);return;}
   if(panel==='rename-entry'){const m=newModal('重命名资产',undefined,'保存');nameForm(m,'条目名称',entry.name,name=>adapter.renameEntry(team!.id,entry.id,name,undefined,entry.revision),'资产名称已保存。');return;}
   if(panel==='delete-entry'){const m=newModal('删除团队资产',`删除“${entry.name}”？已导入项目的副本会保留。`,'删除');confirm(m,()=>adapter.deleteEntry(team!.id,entry.id,entry.revision),'团队资产已删除。');return;}
   if(panel==='move-entry'){
    const m=newModal('移动资产',entry.name,'移动'),select=el('select');select.append(Object.assign(el('option',team.name+' / 全部资产'),{value:''}));for(const folder of folders){const path=teamFolderPath(folders,folder.id).map(f=>f.name).join(' / ');select.append(Object.assign(el('option',team.name+' / '+path),{value:folder.id}));}select.value=entry.folderId??'';m.body.append(collaborationField('目标文件夹',select));m.setSubmit(async()=>{if(select.value===(entry.folderId??''))return;await adapter.renameEntry(team!.id,entry.id,entry.name,select.value||null,entry.revision);if(!current())return;message='资产已移动。';dismiss();await render();});m.submit.disabled=true;select.onchange=()=>{m.submit.disabled=select.value===(entry.folderId??'');};focus(m);return;
   }
   throw new ApiError(404,'PANEL_NOT_FOUND','此操作入口已失效，请返回资产库。');
  }catch(error){if(!active()||turn!==panelVersion)return;const m=modal??newModal('暂时无法打开');m.body.replaceChildren(note('请返回上一层后重试。'));m.setError(error);m.complete('返回');}
 }
 function addMember(m:CollaborationDialog,selected:Team,list:MemberList,current:()=>boolean){
  m.body.append(note('添加到 '+selected.name+'。可搜索已通过飞书登录 Studio TV 的同事。'));const query=input('搜索同事姓名'),role=roles(),results=el('div',undefined,'studio-library-member-results'),chosen=note('尚未选择成员');let selectedUser:string|null=null,searchVersion=0;
  const search=btn('搜索',async()=>{const q=query.value.trim();if(!q){results.replaceChildren(note('请输入同事姓名。'));return;}const generation=++searchVersion;search.disabled=true;results.replaceChildren(note('正在搜索…'));try{const users=await adapter.users(requireName(q,'同事姓名',100));if(!current()||generation!==searchVersion)return;const existing=new Set(list.members.map(v=>v.userId));results.replaceChildren();for(const user of users){const added=existing.has(user.id),b=btn(added?'已在团队':'选择',()=>{selectedUser=user.id;chosen.textContent='已选择：'+user.displayName;m.submit.disabled=false;for(const option of results.querySelectorAll('button'))option.setAttribute('aria-pressed',String(option===b));});b.disabled=added;b.setAttribute('aria-label',(added?'已在团队：':'选择同事 ')+user.displayName);b.setAttribute('aria-pressed',String(selectedUser===user.id));const e=row(el('span',user.displayName),b);e.classList.add('studio-library-member-result');results.append(e);}if(!users.length)results.append(note('没有找到同事，可请对方先登录一次 Studio TV。'));}catch(e){if(current())m.setError(e);}finally{if(current())search.disabled=false;}});
  query.oninput=()=>{searchVersion++;selectedUser=null;chosen.textContent='尚未选择成员';m.submit.disabled=true;results.replaceChildren();search.disabled=false;};query.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search.click();}};
  m.body.append(row(collaborationField('同事姓名',query),search),results,chosen,collaborationField('成员权限',role),note('只读成员可以查看和导入；可编辑成员还可以发布和整理。'));
  m.setSubmit(async()=>{if(!selectedUser)throw new ApiError(400,'MEMBER_REQUIRED','请先搜索并选择同事。');await adapter.setMember('teams',selected.id,selectedUser,role.value as 'VIEWER'|'EDITOR',list.revision);if(current())dismiss();},'添加成员');m.submit.disabled=true;focus(m);
 }
 async function publish(current:()=>boolean){
  const m=newModal('发布到团队','发布位置：'+pathLabel()+'。发布后团队成员可使用，个人原件会保留。','发布到团队');m.dialog.classList.add('studio-collab-dialog--picker');m.body.append(note('正在读取个人资产…'));
  const [assets,nodes]=await Promise.all([adapter.personalAssets(undefined,current),adapter.personalNodes(current)]);if(!current())return;
  const sources=[...assets.map(a=>({value:'asset:'+a.id,id:a.id,name:a.fileName,type:'asset',kind:a.kind,thumbnail:a.kind==='IMAGE'?(a.previewUrl||a.downloadUrl):null})),...nodes.map(n=>({value:'node:'+n.id,id:n.id,name:n.name,type:'node',kind:n.nodeType,thumbnail:null}))];
  let kind='asset',selected:string|null=null;const query=input('搜索素材或节点'),scope=el('div',undefined,'studio-library-picker-tabs'),list=el('div',undefined,'studio-library-source-list'),selection=note('请选择要发布的内容'),name=input('不填写则使用原名称');query.type='search';
  const paint=()=>{list.replaceChildren();const filtered=sources.filter(s=>s.type===kind&&s.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()));for(const source of filtered){const item=btn('',()=>{selected=source.value;selection.textContent='已选择：'+source.name;m.submit.disabled=false;paint();});item.className='studio-library-source';item.setAttribute('aria-label','选择 '+source.name);item.setAttribute('aria-pressed',String(selected===source.value));const thumb=el('span',undefined,'studio-library-source-thumb');if(source.thumbnail){const image=el('img');image.src=source.thumbnail;image.alt='';image.loading='lazy';image.onerror=()=>image.replaceWith(icon('asset'));thumb.append(image);}else thumb.append(icon('asset'));const info=el('span',undefined,'studio-library-source-info');info.append(el('strong',source.name),el('span',source.type==='node'?'已保存的节点':({IMAGE:'图片',VIDEO:'视频',AUDIO:'音频',TEXT:'文本'}as Record<string,string>)[source.kind]??'素材'));item.append(thumb,info,el('span',selected===source.value?'✓':''));list.append(item);}if(!filtered.length)list.append(note(query.value?'没有匹配的内容。':kind==='asset'?'暂无可发布的个人素材。':'暂无已保存的库节点，可先从画布保存节点。'));for(const b of scope.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.kind===kind));};
  for(const [value,title]of [['asset','个人素材'],['node','已存节点']]){const b=btn(title,()=>{kind=value;paint();});b.dataset.kind=value;scope.append(b);}query.oninput=paint;
  m.body.replaceChildren(scope,query,list,selection,collaborationField('共享条目名称（可选）',name));m.setSubmit(async()=>{const source=sources.find(s=>s.value===selected);if(!source)throw new ApiError(400,'SOURCE_REQUIRED','请选择要发布的素材或节点。');const value=name.value.trim()?requireName(name.value,'共享条目名称'):'';await adapter.publish(team!.id,source.type==='asset'?{sourceAssetId:source.id}:{sourceNodeId:source.id},value,folderId());if(!current())return;message='已发布到 '+pathLabel()+'。';dismiss();await render();});m.submit.disabled=true;paint();focus(m);
 }
 async function importEntry(entry:TeamEntry,current:()=>boolean){
  const m=newModal('导入项目','将“'+entry.name+'”复制到所选项目。团队原件和项目副本各自独立。','导入项目');m.body.append(note('正在读取可编辑项目…'));const projects:any[]=[];
  for(let page=1;page<=100;page++){const result=await adapter.projects('all',page);if(!current())return;projects.push(...result.items.filter(p=>p.role!=='VIEWER'));if(!result.hasMore)break;if(page===100)throw new ApiError(502,'PROJECT_PAGE_LIMIT','项目过多，请稍后重试。');}
  const select=el('select');select.append(Object.assign(el('option','请选择目标项目'),{value:''}));for(const p of projects)select.append(Object.assign(el('option',p.name),{value:p.id}));m.body.replaceChildren(collaborationField('目标项目',select));if(!projects.length)m.body.append(note('没有可编辑的目标项目。请先创建项目或获取编辑权限。'));
  let imported=false;m.setSubmit(async()=>{if(imported)return;if(!select.value)throw new ApiError(400,'PROJECT_REQUIRED','请选择可编辑的目标项目。');const result=await importTeamIntoProject(adapter,runtime.storage,team!.id,entry.id,select.value);if(!current())return;imported=true;m.body.replaceChildren(note('已导入项目并保存。'));m.complete('留在资产库');m.footer.prepend(btn('打开项目',()=>{m.close();go('/project/canvas/'+encodeURIComponent(result.projectId));},true));});m.submit.disabled=true;select.onchange=()=>{m.submit.disabled=!select.value;};focus(m);
 }
 nav.onChange=()=>{void syncPanel();};
 const release=runtime.auth.onClear(()=>{version++;ready=false;closePanel();root.replaceChildren(note('请使用飞书登录后继续。'));});
 void render();const dispose=()=>{disposed=true;version++;closePanel();release();};
 return Object.assign(dispose,{update:(location:LibraryLocation)=>nav.update(location)});
}
