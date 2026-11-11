import {ApiError,type RequestOptions} from '../api/client';
import type {Project} from '../api/types';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';
import type {ServiceStorage} from './storage';
import {nativeProjectPreview,type ProjectPreview} from './project-previews';

type Row=Record<string,any>;
const invalid=(message:string)=>new ApiError(400,'INVALID_ORGANIZATION_REQUEST',message);
const record=(value:any):Row=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(502,'INVALID_ORGANIZATION_RESPONSE','服务返回了无效的项目目录。');return value;};
const id=(value:any)=>{const result=String(value??'').trim();if(!/^[A-Za-z0-9_-]{1,200}$/.test(result))throw invalid('项目或文件夹标识不正确。');return result;};
const optionalId=(value:any)=>value===undefined||value===null||value===''?null:id(value);
const revision=(value:any)=>{if(!Number.isSafeInteger(value)||value<1)throw new ApiError(502,'MISSING_ORGANIZATION_REVISION','服务未返回有效的项目目录版本。');return value as number;};
const query=(path:string,values:Row)=>{const search=new URLSearchParams();for(const [key,value]of Object.entries(values))if(value!==undefined&&value!==null&&value!=='')search.set(key,String(value));return path+(search.size?'?'+search:'');};

/** Persisted project folders and memberships; saved asset-library folders use ResourceAdapter. */
export class OrganizationAdapter {
 private epoch=0;
 private readonly pending=new Set<AbortController>();
 private readonly versions=new Map<string,string>();
 constructor(readonly api:ProductClient,readonly storage:ServiceStorage){}
 clear(){this.epoch++;for(const controller of this.pending)controller.abort();this.pending.clear();this.versions.clear();}
 private check(epoch:number){if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次项目目录操作已取消。');}
 private async request<T=any>(epoch:number,path:string,options:RequestOptions={}){
  this.check(epoch);const controller=new AbortController();this.pending.add(controller);
  try{const result=await this.api.requestV2<T>(path,{...options,signal:controller.signal});this.check(epoch);return result;}
  catch(error){this.check(epoch);throw error;}finally{this.pending.delete(controller);}
 }
 private remember(row:Row,etag?:string|null){const key='/project-folders/'+encodeURIComponent(id(row.id));this.versions.set(key,etag??'"'+revision(row.revision)+'"');}
 private nativeFolder(row:Row){this.remember(row);return{...row,id:String(row.id),type:'FOLDER',createTime:Date.parse(row.createdAt),updateTime:Date.parse(row.updatedAt),createdTime:Date.parse(row.createdAt),updatedTime:Date.parse(row.updatedAt)};}
 private async version(epoch:number,path:string){
  const saved=this.versions.get(path);if(saved)return saved;
  const result=await this.request<Row>(epoch,path),row=record(result.data);this.check(epoch);this.remember(row,result.etag);return this.versions.get(path)!;
 }
 private mutate(epoch:number,path:string,body:any,method:string,etag?:string){return this.request(epoch,path,{method,body,idempotencyKey:randomUuid(),...(etag?{etag}:{})});}
 private listQuery(body:Row){
  const scope=String(body.queryScope??'ALL');if(!['ALL','FOLDER','CANVAS'].includes(scope))throw invalid('项目列表范围不正确。');
  const nativeSort=body.querySortBy?String(body.querySortBy)+'_'+String(body.querySortOrder??'DESC'):null;
  const sort=nativeSort?({UPDATE_TIME_DESC:'UPDATED_DESC',UPDATE_TIME_ASC:'UPDATED_ASC',CREATE_TIME_DESC:'CREATED_DESC',CREATE_TIME_ASC:'CREATED_ASC',NAME_ASC:'NAME_ASC',NAME_DESC:'NAME_DESC',FILE_SIZE_ASC:'SIZE_ASC',FILE_SIZE_DESC:'SIZE_DESC'} as Row)[nativeSort]:body.sort??'UPDATED_DESC';
  if(!['UPDATED_DESC','UPDATED_ASC','CREATED_DESC','CREATED_ASC','NAME_ASC','NAME_DESC','SIZE_ASC','SIZE_DESC'].includes(sort))throw invalid('项目排序方式不正确。');
  return{folderId:optionalId(body.folderId),queryScope:scope,sort,keyword:String(body.keyword??'').trim()||undefined};
 }
 async list(body:Row={}){
  const epoch=this.epoch,page=Number(body.page??body.current??1),size=Number(body.size??20),filters=this.listQuery(body);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>10000)throw invalid('项目分页参数不正确。');
  const serverSize=Math.min(size,100),start=(page-1)*size,skip=start%serverSize,rows:Row[]=[];let serverPage=Math.floor(start/serverSize)+1,total:number|undefined,collectionRevision:number|undefined;
  while(rows.length<skip+size){
   const response=await this.request<Row>(epoch,query('/project-folders/entries',{...filters,page:serverPage,size:serverSize})),result=record(response.data);
   if(!Array.isArray(result.records)||!Number.isSafeInteger(result.total)||result.total<0)throw new ApiError(502,'INVALID_ORGANIZATION_PAGE','服务返回了无效的项目分页。');
   const currentRevision=revision(result.revision);
   if(total!==undefined&&(total!==result.total||collectionRevision!==currentRevision))throw new ApiError(409,'ORGANIZATION_PAGE_CHANGED','项目目录已更新，请重新加载。');
   total=result.total;collectionRevision=currentRevision;rows.push(...result.records);
   if(result.hasNext!==true&&serverPage*serverSize>=result.total)break;
   if(!result.records.length)throw new ApiError(502,'INVALID_ORGANIZATION_PAGE','项目分页缺少下一页记录。');serverPage++;
  }
  this.check(epoch);
  const selected=rows.slice(skip,skip+size),projects=selected.filter(row=>row.type==='CANVAS').map(row=>record(row.project));
  const previews=new Map<string,ProjectPreview>(),controller=new AbortController();this.pending.add(controller);
  try{for(let offset=0;offset<projects.length;offset+=100){
   const batch=await this.storage.loadProjectPreviews(projects.slice(offset,offset+100).map(project=>id(project.id)),{signal:controller.signal});this.check(epoch);
   for(const [key,value]of batch)previews.set(key,value);
  }}finally{this.pending.delete(controller);}this.check(epoch);
  const records=selected.map(row=>{
   if(row.type==='FOLDER')return this.nativeFolder(record(row.folder));
   if(row.type!=='CANVAS')throw new ApiError(502,'INVALID_ORGANIZATION_PAGE','服务返回了未知项目条目。');
   const project=record(row.project),preview=previews.get(id(project.id));if(!preview)throw new ApiError(502,'PROJECT_PREVIEW_MISSING','服务未返回项目预览。');
   return{...nativeProjectPreview(preview),folderId:optionalId(row.folderId),...(row.byteSize!==undefined?{byteSize:row.byteSize}:{})};
  });
  this.check(epoch);return{records,current:page,page,size,total:total!,pages:Math.ceil(total!/size),hasNext:start+records.length<total!,revision:collectionRevision!};
 }
 async create(body:Row={}){
  const epoch=this.epoch,name=String(body.name??'Untitled').trim();if(!name)throw invalid('项目名称不能为空。');
  const result=await this.mutate(epoch,'/project-folders/projects',{name,folderId:optionalId(body.folderId)},'POST'),project=record(result.data);
  this.check(epoch);await this.storage.loadProject(id(project.id));this.check(epoch);
  const loaded=this.storage.projects.get(String(project.id));if(!loaded)throw new ApiError(502,'PROJECT_NOT_LOADED','项目尚未从服务器加载。');return loaded as Project;
 }
 async handle(path:string,body:Row={},_method='POST'):Promise<any|undefined>{
  const epoch=this.epoch,b=body&&typeof body==='object'?body:{};
  if(path==='/canvas/folder/getConfig'){
   const result=record((await this.request(epoch,'/project-folders/config')).data);
   if(!Number.isSafeInteger(result.maxLevel)||result.maxLevel<1||!Number.isSafeInteger(result.maxFolders)||result.maxFolders<1)throw new ApiError(502,'INVALID_FOLDER_CONFIG','服务返回了无效的项目文件夹配置。');return result;
  }
  if(path==='/canvas/folder/create'){
   const result=await this.mutate(epoch,'/project-folders',{name:b.name,parentId:optionalId(b.folderId??b.parentId)},'POST');this.check(epoch);const row=record(result.data);this.remember(row,result.etag);return this.nativeFolder(row);
  }
  if(path==='/canvas/folder/update'||path==='/canvas/folder/delete'){
   const folderId=id(b.folderId??b.id),target='/project-folders/'+encodeURIComponent(folderId),etag=await this.version(epoch,target);this.check(epoch);
   const deleting=path.endsWith('/delete'),result=await this.mutate(epoch,target,deleting?undefined:{name:b.name},deleting?'DELETE':'PATCH',etag);this.check(epoch);const row=record(result.data);
   if(!deleting){this.remember(row,result.etag);return this.nativeFolder(row);}
   if(!Array.isArray(row.deletedFolderIds)||!Array.isArray(row.deletedProjectIds))throw new ApiError(502,'INVALID_FOLDER_DELETION','服务未返回删除的项目目录标识。');
   for(const value of row.deletedFolderIds)this.versions.delete('/project-folders/'+encodeURIComponent(id(value)));
   for(const value of row.deletedProjectIds){const projectId=id(value);this.storage.projects.delete(projectId);this.storage.snapshots.delete(projectId);this.storage.etags.delete(projectId);this.storage.forgetProjectPreview(projectId);}return row;
  }
  if(path==='/canvas/move/v1/targetList'){
   const result=record((await this.request(epoch,query('/project-folders/tree',{projectId:id(b.canvasId)}))).data);revision(result.revision);
   if(!Array.isArray(result.records))throw new ApiError(502,'INVALID_PROJECT_TREE','服务返回了无效的项目树。');
   const visit=(value:any):Row=>{const row=record(value);if(!['ROOT','FOLDER','CANVAS'].includes(row.type)||!Array.isArray(row.childList))throw new ApiError(502,'INVALID_PROJECT_TREE','服务返回了无效的项目树。');if(row.type==='FOLDER')this.remember(row);return{...row,childList:row.childList.map(visit)};};
   this.check(epoch);return result.records.map(visit);
  }
  if(path==='/canvas/move/v1/submit'){
   const projectId=id(b.canvasId);await this.storage.wait(projectId);this.check(epoch);
   if(this.storage.isBlocked(projectId))throw new ApiError(409,'PROJECT_SAVE_CONFLICT','项目存在未解决的保存冲突，请重新加载后再移动。');
   const target='/projects/'+encodeURIComponent(projectId)+'/folder',current=await this.request<Row>(epoch,target),membership=record(current.data);
   if(id(membership.projectId)!==projectId)throw new ApiError(502,'INVALID_PROJECT_MEMBERSHIP','服务返回了其他项目的目录信息。');
   const etag=current.etag??'"'+revision(membership.revision)+'"';this.check(epoch);
   const result=await this.mutate(epoch,target,{folderId:optionalId(b.targetFolderId)},'PUT',etag);this.check(epoch);
   await this.storage.refreshProjectMetadata(projectId);this.check(epoch);return result.data;
  }
  return undefined;
 }
}
