import {ApiError,type ApiResult,type RequestOptions} from '../api/client';
import type {Asset,Page,Project} from '../api/types';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';
import type {ServiceStorage} from './storage';
import type {CollaborationRole} from './project-access';

export interface Team {id:string;name:string;ownerId:string;role:CollaborationRole;revision:number}
export interface Collaborator {userId:string;displayName:string;avatarUrl:string|null;role:CollaborationRole}
export interface MemberList {projectId?:string;teamId?:string;revision:number;members:Collaborator[]}
export interface ProjectTeamList {projectId:string;revision:number;teams:{teamId:string;name:string;role:'EDITOR'|'VIEWER'}[]}
export interface RegisteredUser {id:string;displayName:string;avatarUrl:string|null}
export interface TeamFolder {id:string;teamId:string;parentId:string|null;name:string;revision:number}
export interface TeamEntry {id:string;teamId:string;folderId:string|null;name:string;kind:'ASSET'|'NODE';revision:number;content:{nodeType?:string;nodeContent?:any;assetIds?:string[];primaryAssetId?:string;text?:string};thumbnailAssetId:string|null;assets:Array<{id:string;kind:string;mimeType:string;fileName:string}>}
export interface TeamPage<T> {records:T[];page:number;size:number;total:number;hasNext:boolean}
export interface TeamImport {targetProjectId:string;entry:TeamEntry;node:any|null;assets:Array<{id:string}>;assetIdMap:Record<string,string>}
const segment=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,200}$/.test(value))throw new ApiError(400,'INVALID_COLLABORATION_ID','标识不正确。');return encodeURIComponent(value);};
const roles=['OWNER','EDITOR','VIEWER'];
const invalid=()=>new ApiError(502,'INVALID_COLLABORATION_RESPONSE','服务返回了无效的协作数据。');
const revision=(value:any)=>Number.isSafeInteger(value)&&value>=1;
const teamValue=(value:any):Team=>{if(!value||typeof value.id!=='string'||typeof value.name!=='string'||typeof value.ownerId!=='string'||!roles.includes(value.role)||!revision(value.revision))throw invalid();return value;};

/** STUDIO membership state is scoped to the actual signed-in identity. Team
 * selection affects navigation, never the identity sent to the service. */
export class CollaborationAdapter {
 private epoch=0;
 private readonly pending=new Set<AbortController>();
 private readonly versions=new Map<string,string>();
 private readonly listeners=new Set<()=>void>();
 readonly teams=new Map<string,Team>();
 currentTeamId:string|null=null;
 constructor(readonly api:ProductClient,readonly storage:ServiceStorage,private readonly identity:()=>string|null){}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private changed(){for(const listener of this.listeners)listener();}
 clear(){this.epoch++;for(const pending of this.pending)pending.abort();this.pending.clear();this.versions.clear();this.teams.clear();this.currentTeamId=null;this.changed();}
 private async request<T>(path:string,options:RequestOptions={},v1=false):Promise<ApiResult<T>>{
  const identity=this.identity();if(!identity)throw new ApiError(401,'UNAUTHORIZED','请先登录。');
  const epoch=this.epoch,controller=new AbortController();this.pending.add(controller);const check=()=>{if(epoch!==this.epoch||identity!==this.identity()||controller.signal.aborted)throw new ApiError(401,'COLLABORATION_SCOPE_CHANGED','账号或团队已切换，本次操作已取消。');};
  const raw=/^\/collaboration\/teams\/[^/]+\/(?:assets|folders)(?:[/?]|$)/.test(path);
  try{const result=await(v1?this.api.request<T>(path,{...options,signal:controller.signal}):raw?this.api.requestRawJsonV2<T>(path,{...options,signal:controller.signal}):this.api.requestV2<T>(path,{...options,signal:controller.signal}));check();const data:any=result.data;if(revision(data?.revision))this.versions.set(path.split('?')[0],result.etag??'"'+data.revision+'"');return result;}catch(error){check();throw error;}finally{this.pending.delete(controller);}
 }
 private mutate<T>(path:string,body:any,method='POST',versionPath?:string,viewedRevision?:number){
  if(viewedRevision!==undefined&&!revision(viewedRevision))throw new ApiError(428,'VERSION_REQUIRED','请先加载当前版本，再提交修改。');
  const etag=viewedRevision!==undefined?'"'+viewedRevision+'"':versionPath?this.versions.get(versionPath):undefined;if(versionPath&&!etag)throw new ApiError(428,'VERSION_REQUIRED','请先加载当前版本，再提交修改。');
  return this.request<T>(path,{method,body,etag,idempotencyKey:randomUuid()});
 }
 private requireTeam(id:string,owner=false){const team=this.teams.get(id);if(!team||(owner?team.role!=='OWNER':team.role==='VIEWER'))throw new ApiError(403,'TEAM_READ_ONLY',owner?'只有团队所有者可以管理团队。':'当前团队权限为只读。');}
 private manage(kind:'projects'|'teams',id:string){if(kind==='projects')this.storage.requirePermission(id,'canManageMembers');else this.requireTeam(id,true);}
 async users(q:string){const result=await this.request<{items:RegisteredUser[]}>('/collaboration/users?'+new URLSearchParams({q:q.trim()}));if(!Array.isArray(result.data?.items)||result.data.items.some(user=>typeof user.id!=='string'||typeof user.displayName!=='string'))throw invalid();return result.data.items;}
 async projects(scope:'all'|'owned'|'shared'='shared',page=1,q=''){
  const result=await this.request<Page<Project>>('/collaboration/projects?'+new URLSearchParams({scope,page:String(page),pageSize:'20',q}));
  if(!Array.isArray(result.data?.items)||!Number.isSafeInteger(result.data.total)||result.data.items.some(project=>!roles.includes(project.role??'')))throw invalid();return result.data;
 }
 async members(kind:'projects'|'teams',id:string){const path='/collaboration/'+kind+'/'+segment(id)+'/members',result=await this.request<MemberList>(path);if(result.data?.[kind==='projects'?'projectId':'teamId']!==id||!revision(result.data?.revision)||!Array.isArray(result.data.members)||result.data.members.some(member=>typeof member.userId!=='string'||typeof member.displayName!=='string'||!roles.includes(member.role)))throw invalid();return result.data;}
 async setMember(kind:'projects'|'teams',id:string,userId:string,role:'EDITOR'|'VIEWER',viewedRevision?:number){
  this.manage(kind,id);
  if(!['EDITOR','VIEWER'].includes(role))throw new ApiError(400,'INVALID_ROLE','只能添加编辑者或查看者。');const path='/collaboration/'+kind+'/'+segment(id)+'/members',result=await this.mutate<MemberList>(path,{userId,role},'PUT',path,viewedRevision);if(kind==='projects')await this.storage.refreshAccess(id);return result.data;
 }
 async removeMember(kind:'projects'|'teams',id:string,userId:string,viewedRevision?:number){this.manage(kind,id);const path='/collaboration/'+kind+'/'+segment(id)+'/members',result=await this.mutate<MemberList>(path+'/'+segment(userId),undefined,'DELETE',path,viewedRevision);this.versions.set(path,'"'+result.data.revision+'"');if(kind==='projects')await this.storage.refreshAccess(id);return result.data;}
 async projectTeams(projectId:string){const result=await this.request<ProjectTeamList>('/collaboration/projects/'+segment(projectId)+'/teams');if(!revision(result.data?.revision)||!Array.isArray(result.data.teams))throw invalid();return result.data;}
 async setProjectTeam(projectId:string,teamId:string,role:'EDITOR'|'VIEWER',viewedRevision?:number){this.storage.requirePermission(projectId,'canManageMembers');const path='/collaboration/projects/'+segment(projectId)+'/teams';return(await this.mutate<ProjectTeamList>(path,{teamId,role},'PUT',path,viewedRevision)).data;}
 async removeProjectTeam(projectId:string,teamId:string,viewedRevision?:number){this.storage.requirePermission(projectId,'canManageMembers');const path='/collaboration/projects/'+segment(projectId)+'/teams',result=await this.mutate<ProjectTeamList>(path+'/'+segment(teamId),undefined,'DELETE',path,viewedRevision);this.versions.set(path,'"'+result.data.revision+'"');return result.data;}
 async loadTeams(){
  const epoch=this.epoch,all:Team[]=[];for(let page=1;page<=100;page++){const result=await this.request<Page<Team>>('/collaboration/teams?'+new URLSearchParams({page:String(page),pageSize:'100'}));if(epoch!==this.epoch)throw new ApiError(401,'COLLABORATION_SCOPE_CHANGED','团队已切换，请重新加载。');if(!Array.isArray(result.data?.items)||typeof result.data.hasMore!=='boolean')throw invalid();all.push(...result.data.items.map(teamValue));if(!result.data.hasMore){this.teams.clear();for(const team of all){this.teams.set(team.id,team);this.versions.set('/collaboration/teams/'+segment(team.id),'"'+team.revision+'"');}if(this.currentTeamId&&!this.teams.has(this.currentTeamId))this.currentTeamId=null;this.changed();return all;}if(!result.data.items.length)throw invalid();}throw new ApiError(502,'TEAM_PAGE_LIMIT','团队列表超过了可加载范围。');
 }
 async team(id:string){const team=teamValue((await this.request<Team>('/collaboration/teams/'+segment(id))).data);if(team.id!==id)throw invalid();this.teams.set(team.id,team);return team;}
 async selectTeam(id:string|null){if(id!==null)await this.team(id);if(id===this.currentTeamId)return;this.epoch++;for(const controller of this.pending)controller.abort();this.pending.clear();this.versions.clear();this.currentTeamId=id;this.changed();}
 async createTeam(name:string){const team=teamValue((await this.mutate<Team>('/collaboration/teams',{name:name.trim()})).data);this.teams.set(team.id,team);this.changed();return team;}
 async renameTeam(id:string,name:string,viewedRevision?:number){this.requireTeam(id,true);const path='/collaboration/teams/'+segment(id),team=teamValue((await this.mutate<Team>(path,{name:name.trim()},'PATCH',path,viewedRevision)).data);this.teams.set(id,team);this.changed();return team;}
 async deleteTeam(id:string,viewedRevision?:number){this.requireTeam(id,true);const path='/collaboration/teams/'+segment(id);await this.mutate(path,undefined,'DELETE',path,viewedRevision);this.teams.delete(id);if(this.currentTeamId===id)this.currentTeamId=null;this.changed();}
 private teamPath(id:string){return'/collaboration/teams/'+segment(id);}
 async folders(teamId:string){const path=this.teamPath(teamId)+'/folders',records:TeamFolder[]=[];for(let page=1;page<=100;page++){const result=await this.request<TeamPage<TeamFolder>>(path+'?'+new URLSearchParams({page:String(page),size:'100'}));if(!Array.isArray(result.data?.records)||typeof result.data.hasNext!=='boolean')throw invalid();for(const folder of result.data.records){if(folder.teamId!==teamId||!revision(folder.revision))throw invalid();this.versions.set(path+'/'+segment(folder.id),'"'+folder.revision+'"');}records.push(...result.data.records);if(!result.data.hasNext)return{...result.data,records};if(!result.data.records.length)throw invalid();}throw new ApiError(502,'TEAM_PAGE_LIMIT','文件夹列表超过可加载范围。');}
 async createFolder(teamId:string,name:string,parentId:string|null=null){this.requireTeam(teamId);return(await this.mutate<TeamFolder>(this.teamPath(teamId)+'/folders',{name:name.trim(),parentId})).data;}
 async renameFolder(teamId:string,id:string,name:string,viewedRevision?:number){this.requireTeam(teamId);const path=this.teamPath(teamId)+'/folders/'+segment(id);return(await this.mutate<TeamFolder>(path,{name},'PATCH',path,viewedRevision)).data;}
 async deleteFolder(teamId:string,id:string,viewedRevision?:number){this.requireTeam(teamId);const path=this.teamPath(teamId)+'/folders/'+segment(id);await this.mutate(path,undefined,'DELETE',path,viewedRevision);}
 async entries(teamId:string,folderId:string|null=null,page=1){const path=this.teamPath(teamId)+'/assets',result=await this.request<TeamPage<TeamEntry>>(path+'?'+new URLSearchParams({page:String(page),size:'20',...(folderId?{folderId}:{})}));if(!Array.isArray(result.data?.records))throw invalid();for(const entry of result.data.records){if(entry.teamId!==teamId||!revision(entry.revision)||!['ASSET','NODE'].includes(entry.kind))throw invalid();this.versions.set(path+'/'+segment(entry.id),'"'+entry.revision+'"');}return result.data;}
 async publish(teamId:string,source:{sourceAssetId?:string;sourceNodeId?:string},name:string,folderId:string|null){this.requireTeam(teamId);if(!!source.sourceAssetId===!!source.sourceNodeId)throw new ApiError(400,'SOURCE_REQUIRED','请选择一个真实个人素材或节点。');return(await this.mutate<TeamEntry>(this.teamPath(teamId)+'/assets',{...source,name:name.trim()||undefined,folderId})).data;}
 async renameEntry(teamId:string,id:string,name:string,folderId?:string|null,viewedRevision?:number){this.requireTeam(teamId);const path=this.teamPath(teamId)+'/assets/'+segment(id);return(await this.mutate<TeamEntry>(path,{name,...(folderId!==undefined?{folderId}:{})},'PATCH',path,viewedRevision)).data;}
 async deleteEntry(teamId:string,id:string,viewedRevision?:number){this.requireTeam(teamId);const path=this.teamPath(teamId)+'/assets/'+segment(id);await this.mutate(path,undefined,'DELETE',path,viewedRevision);}
 async importEntry(teamId:string,id:string,projectId:string){this.storage.requirePermission(projectId);const result=await this.mutate<TeamImport>(this.teamPath(teamId)+'/assets/'+segment(id)+'/import',{projectId});if(result.data?.targetProjectId!==projectId||!Array.isArray(result.data.assets)||!result.data.assetIdMap)throw invalid();return result.data;}
 async personalNodes(active=()=>true){
  const all:any[]=[];for(let page=1;page<=100&&active();page++){const result=await this.request<TeamPage<any>>('/library/entries?'+new URLSearchParams({itemType:'NODE',recursive:'true',page:String(page),size:'100'}));if(!Array.isArray(result.data?.records)||typeof result.data.hasNext!=='boolean')throw invalid();all.push(...result.data.records.map(row=>row.item??row));if(!result.data.hasNext)return all;if(!result.data.records.length)throw invalid();}
  if(!active())return[];throw new ApiError(502,'LIBRARY_PAGE_LIMIT','个人节点过多，暂时无法完整加载。');
 }
 async personalAssets(projectId?:string,active=()=>true){
  const all:Asset[]=[];for(let page=1;page<=100&&active();page++){const result=await this.request<Page<Asset>>('/assets?'+new URLSearchParams({...(projectId?{projectId}:{}),state:'READY',page:String(page),pageSize:'100'}),{},true);if(!Array.isArray(result.data?.items)||typeof result.data.hasMore!=='boolean')throw invalid();all.push(...result.data.items.filter(asset=>asset.state==='READY'));if(!result.data.hasMore)return all;if(!result.data.items.length)throw invalid();}
  if(!active())return[];throw new ApiError(502,'LIBRARY_PAGE_LIMIT','个人素材过多，暂时无法完整加载。');
 }
 async assetUrl(id:string){const asset=(await this.request<Asset>('/assets/'+segment(id),{},true)).data;if(asset.state!=='READY'||!(asset.previewUrl||asset.downloadUrl))throw new ApiError(409,'ASSET_NOT_READY','共享素材尚未就绪。');return asset.previewUrl||asset.downloadUrl!;}
 nativeTeams(){return[...this.teams.values()].map(team=>({...team,teamId:team.id,isCurrent:team.id===this.currentTeamId,role:team.role==='OWNER'?'ADMIN':team.role}));}
}
