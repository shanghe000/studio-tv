import {ApiError} from '../api/client';
import {canvasProjectFromPath} from './canvas-lifecycle';
import {roleLabel} from './project-access';
import {installPersonalLibraryNavigation} from './personal-library-navigation';
import {mountTeamLibrary} from './team-library';
import {libraryBaseLocation,teamLibraryURL,type LibraryNavigate} from './library-navigation';
import {createCollaborationDialog,collaborationField,requireName} from './collaboration-dialogs';
import {collaborationCss} from './collaboration-style';
import type {CollaborationAdapter} from './collaboration';

type Navigate=LibraryNavigate;
const teamURL=(id?:string)=>'/projects/team-assets'+(id?'/'+encodeURIComponent(id):'');
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
const owned=<T extends HTMLElement>(element:T):T=>{element.setAttribute('data-studio-collaboration','');return element;};
const row=(...children:Node[])=>{const element=node('div',undefined,'studio-collab-row');element.append(...children);return element;};
const button=(text:string,run:()=>void|Promise<unknown>,primary=false)=>{const element=node('button',text,primary?'studio-primary':undefined);element.type='button';element.onclick=()=>{void run();};return element;};
const input=(placeholder:string)=>{const element=node('input');element.placeholder=placeholder;element.autocomplete='off';element.setAttribute('aria-label',placeholder);return element;};
const roleSelect=()=>{const select=node('select');select.setAttribute('aria-label','成员权限');for(const value of ['EDITOR','VIEWER']as const){const option=node('option',roleLabel(value));option.value=value;select.append(option);}return select;};
const badge=(role:any)=>node('span',roleLabel(role)??'权限待确认','studio-collab-role');
const failure=(error:unknown)=>node('p',error instanceof Error?error.message:'请求失败，请重试。','studio-collab-error');
const description=(text:string)=>node('p',text,'studio-collab-muted');
const heading=(title:string,...actions:Node[])=>{const element=node('header',undefined,'studio-collab-heading');element.append(node('h1',title),row(...actions));return element;};
const toolbar=(left:Node,right:Node)=>{const element=node('div',undefined,'studio-collab-toolbar');element.append(left,right);return element;};
function tabs(items:Array<{name:string;to:string;active:boolean}>,navigate:Navigate){const element=node('nav',undefined,'studio-collab-tabs');element.setAttribute('aria-label','资产范围');for(const item of items){const tab=button(item.name,()=>navigate(item.to));if(item.active)tab.setAttribute('aria-current','page');element.append(tab);}return element;}
export async function openCollaborationMembers(runtime:any,kind:'projects'|'teams',id:string,doc:Document=document){
 const adapter:CollaborationAdapter=runtime.collaboration,modal=createCollaborationDialog(runtime,{title:kind==='projects'?'项目成员与权限':'团队成员与权限',doc});modal.dialog.classList.add('studio-collab-dialog--members');let generation=0;
 const render=async()=>{
  const turn=++generation,current=()=>modal.active()&&turn===generation;modal.body.replaceChildren(description('正在读取当前成员…'));
  try{
   let title='',manage=false;if(kind==='projects'){const project=await runtime.storage.loadProject(id);title=project.name;manage=runtime.storage.access(id)?.canManageMembers===true;}else{const team=await adapter.team(id);title=team.name;manage=team.role==='OWNER';}
   const list=await adapter.members(kind,id),grants=kind==='projects'&&manage?await adapter.projectTeams(id):null;if(!current())return;
   modal.dialog.querySelector('h2')!.textContent=title+' · '+(kind==='projects'?'项目成员':'团队成员');modal.body.replaceChildren(description(manage?'可编辑成员可以修改内容；只读成员只能查看。':'当前成员关系由所有者管理。'));
   const table=node('table',undefined,'studio-collab-members');for(const member of list.members){const tr=node('tr'),name=node('td',member.displayName),permissions=node('td');permissions.append(badge(member.role));tr.append(name,permissions);
    if(manage&&member.role!=='OWNER'){const select=roleSelect();select.value=member.role;select.setAttribute('aria-label',member.displayName+'的权限');const cell=node('td');cell.append(row(select,button('保存权限',()=>modal.run(()=>adapter.setMember(kind,id,member.userId,select.value as 'EDITOR'|'VIEWER',list.revision),render)),button('移除',()=>modal.run(()=>adapter.removeMember(kind,id,member.userId,list.revision),render))));tr.append(cell);}table.append(tr);
   }modal.body.append(table);
   if(manage){const query=input('搜索同事'),results=node('div'),role=roleSelect(),search=button('搜索',()=>modal.run(async()=>{const users=await adapter.users(requireName(query.value,'同事姓名',100));if(!current())return;results.replaceChildren();if(!users.length)results.append(description('没有找到已注册用户。'));for(const user of users)results.append(row(node('span',user.displayName),button('添加',()=>modal.run(()=>adapter.setMember(kind,id,user.id,role.value as 'EDITOR'|'VIEWER',list.revision),render))));}));
    query.maxLength=200;const fields=node('div',undefined,'studio-collab-member-search');fields.append(collaborationField('同事姓名',query),collaborationField('成员权限',role),search);query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();search.click();}});modal.body.append(node('h3','添加成员'),fields,results);
    if(grants){const teams=await adapter.loadTeams();if(!current())return;modal.body.append(node('h3','共享给团队'),description('团队成员的权限同时受团队角色限制。'));for(const grant of grants.teams)modal.body.append(row(node('span',grant.name),badge(grant.role),button('移除团队授权',()=>modal.run(()=>adapter.removeProjectTeam(id,grant.teamId,grants.revision),render))));const select=node('select');for(const team of teams)select.append(Object.assign(node('option',team.name),{value:team.id}));const teamRole=roleSelect(),add=button('授予团队权限',()=>modal.run(()=>adapter.setProjectTeam(id,select.value,teamRole.value as 'EDITOR'|'VIEWER',grants.revision),render));add.disabled=!teams.length;const grantFields=node('div',undefined,'studio-collab-member-search');grantFields.append(collaborationField('选择团队',select),collaborationField('团队权限',teamRole),add);modal.body.append(grantFields);}
   }
   if(kind==='projects'){modal.body.append(button('复制内部项目地址',()=>modal.run(()=>navigator.clipboard.writeText(location.origin+'/project/canvas/'+encodeURIComponent(id)))),description('内部地址仍要求登录及项目成员权限，不提供公开访问。'));}modal.body.append(button('重新加载',()=>modal.run(async()=>{},render)));
  }catch(error){if(current()){modal.body.replaceChildren(failure(error),button('重新加载',()=>modal.run(async()=>{},render)));}}
 };
 void render();return modal.close;
}

/** Owned page seam; the native framework router owns navigation and disposal. */
export function mountCollaborationPage(root:HTMLElement,kind:'shared'|'teams'|'assets',runtime:any,location:any,navigate:Navigate){
 if(kind==='teams'){navigate(teamLibraryURL(runtime.collaboration.currentTeamId??undefined)+'?panel=teams',{replace:true});return Object.assign(()=>{}, {update:(_location:any)=>{}});}
 if(kind==='assets')return mountTeamLibrary(root,runtime,location,navigate);
 const adapter:CollaborationAdapter=runtime.collaboration,url=new URL(location.pathname+location.search,window.location.origin),identity=runtime.auth.user?.id;let disposed=false,rendering=0;const dialogs=new Set<()=>void>(),menus=new Set<()=>void>();
 const active=()=>!disposed&&runtime.auth.user?.id===identity&&!!runtime.auth.user;
 const closeTransient=()=>{for(const close of dialogs)close();dialogs.clear();for(const close of menus)close();menus.clear();};
 const track=(close:(()=>void)|Promise<()=>void>)=>{void Promise.resolve(close).then(value=>{if(active())dialogs.add(value);else value();});};
 const release=runtime.auth.onClear(()=>{rendering++;closeTransient();root.replaceChildren(description('请使用飞书登录后继续。'));});
 const paint=(...children:Node[])=>root.replaceChildren(...children);
 const render=async()=>{
  const turn=++rendering,current=()=>active()&&turn===rendering;closeTransient();if(!active())return;paint(heading(kind==='shared'?'与我共享':kind==='teams'?'团队管理':'资产库'),description('正在读取…'));
  try{
   if(kind==='shared'){
    const scope=(['all','owned','shared'].includes(url.searchParams.get('scope')??'')?url.searchParams.get('scope'):'shared')as 'all'|'owned'|'shared',page=Math.max(1,Number(url.searchParams.get('page'))||1),q=url.searchParams.get('q')??'',result=await adapter.projects(scope,page,q);if(!current())return;
    const search=input('搜索项目');search.value=q;const form=node('form',undefined,'studio-collab-search');form.append(search,Object.assign(button('搜索',()=>{}),{type:'submit'}));form.onsubmit=event=>{event.preventDefault();navigate('/projects/shared?'+new URLSearchParams({scope,q:search.value.trim()}));};paint(heading(scope==='shared'?'与我共享':scope==='owned'?'我的项目':'全部项目'),tabs((['all','owned','shared']as const).map(value=>({name:({all:'全部项目',owned:'我的项目',shared:'与我共享'})[value],to:'/projects/shared?scope='+value,active:scope===value})),navigate),toolbar(description('共享项目的编辑权限由项目所有者管理。'),form));
    const grid=node('div',undefined,'studio-collab-grid');for(const project of result.items){const card=node('article',undefined,'studio-collab-card'),cover=node('div','暂无预览','studio-collab-cover studio-collab-cover--empty'),body=node('div',undefined,'studio-collab-card-body'),title=node('h2',project.name,'studio-collab-card-title');title.title=project.name;body.append(title,badge(project.role));const open=async()=>{try{await runtime.storage.loadProject(project.id);if(current())navigate('/project/canvas/'+encodeURIComponent(project.id));}catch(error){if(current())card.append(failure(error));}};body.append(row(button(project.role==='VIEWER'?'查看项目':'打开项目',open,true),button('成员权限',()=>track(openCollaborationMembers(runtime,'projects',project.id)))));card.append(cover,body);grid.append(card);
     if(project.coverAssetId)void adapter.assetUrl(project.coverAssetId).then(src=>{if(!current()||!card.isConnected)return;const image=node('img',undefined,'studio-collab-cover');image.alt=project.name;image.loading='lazy';image.src=src;image.onerror=()=>{if(current())image.replaceWith(cover);};cover.replaceWith(image);}).catch(()=>{});
    }if(!result.items.length)grid.append(node('p',scope==='shared'?'还没有共享给你的项目。':'没有找到项目。','studio-collab-empty'));const prev=button('上一页',()=>navigate('/projects/shared?'+new URLSearchParams({scope,page:String(page-1),q}))),next=button('下一页',()=>navigate('/projects/shared?'+new URLSearchParams({scope,page:String(page+1),q})));prev.disabled=page<=1;next.disabled=!result.hasMore;root.append(grid,Object.assign(row(prev,description(`${page} 页 · ${result.total} 个项目`),next),{className:'studio-collab-pager'}));
   }
  }catch(error){if(current())paint(heading('暂时无法加载'),failure(error),row(button('重新加载',render),button('返回项目',()=>navigate('/projects/'))));}
 };
 void render();return()=>{disposed=true;rendering++;closeTransient();release();};
}

/** Register owned route elements using the existing framework router. Native
 * children/handlers and frozen route definitions remain untouched on disk. */
export function installCollaborationRoutes(router:any,native:any,runtime:any){
 const react=native.r,parent=router.routes.find((route:any)=>route.path==='/projects');if(!parent||typeof router.patchRoutes!=='function'||typeof react?.useEffect!=='function')return false;
 const Page=(kind:'shared'|'teams'|'assets')=>function CollaborationPage(){
  const ref=react.useRef(null),controller=react.useRef(null),location=native.ac(),base=kind==='assets'?libraryBaseLocation(location):location.pathname+location.search;
  react.useEffect(()=>{if(!ref.current)return;const dispose=mountCollaborationPage(ref.current,kind,runtime,location,(to,options)=>{void router.navigate(to,options);});controller.current=dispose;return()=>{dispose();controller.current=null;};},[base]);
  react.useEffect(()=>{controller.current?.update?.(location);},[location.pathname,location.search,location.state]);
  return react.createElement('section',{ref,className:'studio-collab-page','data-studio-collaboration':''});
 };
 const definitions=[{id:'studio-collaboration-shared',path:'shared',element:react.createElement(Page('shared'))},{id:'studio-collaboration-teams',path:'teams',element:react.createElement(Page('teams'))},{id:'studio-collaboration-assets',path:'team-assets/:teamId?',element:react.createElement(Page('assets'))}];
 if(!parent.children?.some((route:any)=>route.id==='studio-collaboration-shared'))router.patchRoutes(parent.id,definitions);
 if(/^\/projects\/(?:shared|teams|team-assets)(?:\/|$)/.test(router.state.location.pathname))void router.navigate(router.state.location.pathname+router.state.location.search+router.state.location.hash,{replace:true,state:router.state.location.state});return true;
}
export function installCollaborationUi(runtime:any,native:any,props:(element:any)=>any[],surface:any=window,doc:Document=document){
 if(!runtime.collaboration||typeof native.r?.useEffect!=='function')return()=>{};let disposed=false,router:any,releaseRouter:(()=>void)|undefined;
 const style=node('style');style.textContent=collaborationCss;doc.head.append(style);const nav=owned(node('span',undefined,'glass-navbar__slot')),link=node('a','与我共享','glass-navbar__item'),permission=owned(node('aside',undefined,'studio-collab-readonly'));link.href='/projects/shared';link.onclick=event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate('/projects/shared');}};nav.append(link);permission.hidden=true;doc.body.append(permission);
 const navigate=(to:string)=>{if(router)void router.navigate(to);};
 const releaseLibraryNavigation=installPersonalLibraryNavigation(native,runtime,()=>router);
 const replacements=new Map<HTMLElement,HTMLElement>();let permissionKey='',permissionClose:(()=>void)|undefined;
 const refresh=()=>{
  if(disposed)return;const path=router?.state?.location.pathname??surface.location.pathname,items=doc.querySelector<HTMLElement>('.glass-navbar__items');if(items&&nav.parentElement!==items){const project=[...items.querySelectorAll<HTMLAnchorElement>('a.glass-navbar__item')].find(item=>/\/projects\/canvas(?:\/(?:me|team))?\/?$/.test(new URL(item.href,window.location.origin).pathname));const slot=project?.closest('.glass-navbar__slot');if(slot?.parentElement===items)items.insertBefore(nav,slot.nextSibling);else items.append(nav);}nav.hidden=!runtime.auth.user;link.classList.toggle('active',path.startsWith('/projects/shared'));link.setAttribute('data-active',String(path.startsWith('/projects/shared')));if(path.startsWith('/projects/shared'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');const id=canvasProjectFromPath(path),access=id?runtime.storage.access(id):null;permission.hidden=!id||!runtime.auth.user;
  const libraryPath=path.startsWith('/projects/team-assets')||path==='/projects/teams';
  for(const item of doc.querySelectorAll<HTMLAnchorElement>('.glass-navbar__items a'))if(new URL(item.href,window.location.origin).pathname==='/projects/canvas/assetLibrary'){
   if(libraryPath){item.classList.add('active');item.setAttribute('data-active','true');item.setAttribute('aria-current','page');item.setAttribute('data-studio-library-current','');}
   else if(item.hasAttribute('data-studio-library-current')){item.removeAttribute('data-studio-library-current');if(path!=='/projects/canvas/assetLibrary'){item.classList.remove('active');item.setAttribute('data-active','false');item.removeAttribute('aria-current');}}
  }
  const key=JSON.stringify([id,access?.role,access?.canRead,!!runtime.auth.user]);if(key!==permissionKey){permissionClose?.();permissionClose=undefined;permissionKey=key;permission.replaceChildren();if(id){permission.append(description(access?roleLabel(access.role):'项目权限待确认'));if(access?.canRead)permission.append(button('项目成员',async()=>{const close=await openCollaborationMembers(runtime,'projects',id);if(disposed||canvasProjectFromPath(router?.state?.location.pathname??surface.location.pathname)!==id)close();else permissionClose=close;}));}}
  for(const [original,replacement]of replacements)if(!original.isConnected){replacement.remove();replacements.delete(original);}
  for(const original of doc.querySelectorAll<HTMLElement>('.asset-library-tab'))if(original.textContent?.trim()==='团队资产'&&!replacements.has(original)&&!original.hasAttribute('data-studio-collaboration')){const replacement=owned(button('团队资产',()=>navigate(teamURL(runtime.collaboration.currentTeamId??undefined))));replacement.className=original.className;replacement.classList.remove('disabled');replacement.removeAttribute('disabled');replacement.setAttribute('data-studio-team-assets-tab','');original.setAttribute('data-studio-team-assets-replaced','');original.after(replacement);replacements.set(original,replacement);}
 };
 const find=()=>{if(disposed||router)return;const root=doc.getElementById('root');if(!root)return;for(const element of [root.firstElementChild,...Array.from(root.children)]){const candidate=props(element).map(p=>p.router??p.value?.router).find(r=>typeof r?.patchRoutes==='function'&&r.state?.location);if(candidate&&installCollaborationRoutes(candidate,native,runtime)){router=candidate;releaseRouter=router.subscribe(refresh);refresh();return;}}};
 const observer=new surface.MutationObserver((records:MutationRecord[])=>{if(records.some(record=>!(record.target instanceof Element&&record.target.closest('[data-studio-collaboration]')))){find();refresh();}});observer.observe(doc.body,{childList:true,subtree:true});const releaseAccess=runtime.storage.subscribeAccess(refresh),releaseTeams=runtime.collaboration.subscribe(refresh),releaseAuth=runtime.auth.onClear(refresh);find();refresh();
 return()=>{disposed=true;releaseLibraryNavigation();observer.disconnect();releaseRouter?.();releaseAccess();releaseTeams();releaseAuth();permissionClose?.();nav.remove();permission.remove();style.remove();for(const [original,replacement]of replacements){original.removeAttribute('data-studio-team-assets-replaced');replacement.remove();}replacements.clear();};
}
