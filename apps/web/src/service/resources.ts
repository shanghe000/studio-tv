import {sketchDictionaries,sketchDictionaryKeys} from './sketchboard';
import {makeupPreview} from './makeup-previews';
import {ApiError,type RequestOptions} from '../api/client';
import type {Asset} from '../api/types';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';
import {decodeGraph,encodeGraph} from './graph';

type Row=Record<string,any>;
type Family='workflows'|'prompts'|'skills'|'apps'|'voices';
export interface ResourceAssetResolver {
 encodeAsset?:(reference:string)=>string;
 resolveAsset?:(reference:string)=>Promise<Asset>;
 nativeConfigs?:Record<string,unknown>;
 registerCatalogMedia?:(url:string,descriptor:{family:string;resourceId:string;revision:number;path:string})=>void;
}
const invalid=(message:string)=>new ApiError(400,'INVALID_RESOURCE_REQUEST',message);
const object=(value:any):Row=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('资源数据格式不正确。');
 return value;
};
const identifier=(value:any)=>{const id=String(value??'').trim();if(!id)throw invalid('缺少资源标识。');return id;};
const idPath=(value:any)=>encodeURIComponent(identifier(value));
const parse=(value:any)=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{throw invalid('资源内容不是有效的 JSON。');}};
const stringIds=(value:any)=>{
 if(!Array.isArray(value))throw invalid('资源筛选标识必须是数组。');
 return value.map(item=>{if(typeof item!=='string'&&(typeof item!=='number'||!Number.isFinite(item)||!Number.isInteger(item)))throw invalid('资源筛选标识不正确。');return identifier(item);});
};
const query=(path:string,values:Row)=>{
 const search=new URLSearchParams();
 for(const [key,input] of Object.entries(values))if(input!==undefined&&input!==null&&input!==''){
  // Native prompt categories and app tags can be numeric; STUDIO query DTOs declare string IDs.
  const value=key==='categoryIds'||key==='sceneIdList'?stringIds(input):input;
  search.set(key,typeof value==='object'?JSON.stringify(value):String(value));
 }
 return path+(search.size?'?'+search:'');
};
const baseOf=(row:Row)=>object(row.resource??row);
const contentOf=(row:Row)=>object(row.content??{});
const own=(row:Row,key:string)=>Object.prototype.hasOwnProperty.call(row,key);
const etagOf=(result:{etag?:string|null;data:any})=>result.etag||(Number.isSafeInteger(result.data?.revision)?'"'+result.data.revision+'"':Number.isSafeInteger(result.data?.resource?.revision)?'"'+result.data.resource.revision+'"':undefined);

/** Projects and model execution remain in their adapters; this owns persisted product resources. */
export class ResourceAdapter {
 private epoch=0;
 private readonly pending=new Set<AbortController>();
 private readonly etags=new Map<string,string>();
 private readonly objects=new Map<string,Row>();
 private readonly skillFiles=new Map<string,Row>();
 constructor(readonly api:ProductClient,readonly assets:ResourceAssetResolver={}){}
 clear(){this.epoch++;for(const controller of this.pending)controller.abort();this.pending.clear();this.etags.clear();this.objects.clear();for(const url of this.skillFiles.keys())URL.revokeObjectURL(url);this.skillFiles.clear();}
 private check(epoch:number){if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次资源操作已取消。');}
 private async request<T=any>(path:string,options:RequestOptions={},v1=false):Promise<T>{
  const controller=new AbortController(),epoch=this.epoch;this.pending.add(controller);
  try{
   const result=await(v1?this.api.request<T>(path,{...options,signal:controller.signal}):this.api.requestV2<T>(path,{...options,signal:controller.signal}));
   this.check(epoch);const key=path.split('?')[0],etag=etagOf(result);if(etag)this.etags.set(key,etag);
   if(result.data&&typeof result.data==='object'&&!Array.isArray(result.data)&&!Array.isArray((result.data as Row).records))this.objects.set(key,result.data as Row);
   return result.data;
  }catch(error){this.check(epoch);throw error;}finally{this.pending.delete(controller);}
 }
 private mutation(path:string,body:any,method='POST',etag?:string,created=false){
  return this.request(path,{method,body,headers:{...(etag?{'If-Match':etag}:{}),...(created?{'Idempotency-Key':randomUuid()}: {})}});
 }
 private async current(path:string){return this.objects.get(path)??object(await this.request(path));}
 private async version(path:string){if(!this.etags.has(path))await this.request(path);const etag=this.etags.get(path);if(!etag)throw new ApiError(502,'MISSING_RESOURCE_REVISION','服务未返回资源版本，无法安全保存。');return etag;}
 private remember(path:string,row:Row){
  const base=baseOf(row),etag=etagOf({data:row});if(etag)this.etags.set(path+'/'+idPath(base.id),etag);
  this.objects.set(path+'/'+idPath(base.id),row);
 }
 private async page(path:string,b:Row,filters:Row={},map:(row:Row)=>Promise<any>|any=row=>row){
  const page=Number(b.page??b.current??1),size=Number(b.size??20);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>10000)throw invalid('分页参数不正确。');
  // Native pickers request 999/9999 rows. Preserve their offsets using bounded real server pages.
  const serverSize=Math.min(size,100),start=(page-1)*size,first=Math.floor(start/serverSize)+1,skip=start%serverSize;
  const records:Row[]=[];let total:number|undefined,hasNext=false,serverPage=first;
  while(records.length<skip+size){
   const result=object(await this.request(query(path,{...filters,page:serverPage,size:serverSize})));
   if(!Array.isArray(result.records)||!Number.isSafeInteger(Number(result.total))||Number(result.total)<0)throw new ApiError(502,'INVALID_RESOURCE_PAGE','服务返回了无效的资源分页。');
   if(total!==undefined&&total!==Number(result.total))throw new ApiError(409,'RESOURCE_PAGE_CHANGED','资源列表已更新，请重新加载。');
   total=Number(result.total);records.push(...result.records);hasNext=result.hasNext===true||serverPage*serverSize<total;
   if(!hasNext)break;if(result.records.length===0)throw new ApiError(502,'INVALID_RESOURCE_PAGE','资源分页缺少下一页记录。');serverPage++;
  }
  const epoch=this.epoch,result=await Promise.all(records.slice(skip,skip+size).map(row=>map(object(row))));this.check(epoch);
  return{records:result,current:page,size,total:total!,pages:Math.ceil(total!/size),hasNext:start+result.length<total!};
 }
 private async asset(reference:string):Promise<Asset>{
  const epoch=this.epoch,encoded=this.assets.encodeAsset?.(reference)??reference;
  const value=this.assets.resolveAsset?await this.assets.resolveAsset(reference):await this.request<Asset>('/assets/'+idPath(encoded.startsWith('rhtv-asset:')?encoded.slice(11):encoded),{},true);
  this.check(epoch);
  if(!value?.id||value.state!=='READY')throw invalid('素材尚未就绪或不能访问。');
  return value;
 }
 private async assetId(reference:any):Promise<string>{
  const raw=identifier(typeof reference==='object'?reference.assetId??reference.imageUrl??reference.url:reference);
  if(/^(?:https?:|blob:|data:|\/)/i.test(raw)&&!this.assets.resolveAsset)throw invalid('请使用已上传到 STUDIO 的素材。');
  return(await this.asset(raw)).id;
 }
 private async optionalAsset(reference:any){return reference===undefined||reference===null||reference===''?null:this.assetId(reference);}
 private async mediaUrl(reference:any){if(!reference)return null;const asset=await this.asset(identifier(reference));const url=asset.downloadUrl||asset.previewUrl;if(!url)throw new ApiError(502,'ASSET_URL_UNAVAILABLE','素材服务未返回授权地址。');return url;}
 private async readAssetBytes(reference:any){
  const asset=await this.asset(identifier(reference)),url=asset.downloadUrl??asset.previewUrl;
  if(!url)throw new ApiError(502,'ASSET_URL_UNAVAILABLE','素材服务未返回授权地址。');
  const origin=globalThis.location?.origin??'http://localhost',parsed=new URL(url,origin);
  if(parsed.origin!==origin||parsed.pathname!=='/api/v1/assets/'+encodeURIComponent(asset.id)+'/content')throw invalid('Skill 文件必须来自本人 STUDIO 素材。');
  const epoch=this.epoch,controller=new AbortController();this.pending.add(controller);
  try{
   const token=this.api.getAccessToken();if(!token)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
   const response=await this.api.transport(url,{method:'GET',headers:{Authorization:'Bearer '+token},signal:controller.signal,credentials:'same-origin',redirect:'error'});
   this.check(epoch);if(!response.ok)throw new ApiError(response.status,'SKILL_FILE_READ_FAILED','Skill 文件读取失败。');
   const bytes=new Uint8Array(await response.arrayBuffer());this.check(epoch);if(bytes.byteLength>8*1024*1024)throw invalid('Skill 文件超过 8 MiB。');return{bytes,mimeType:asset.mimeType};
  }catch(error){this.check(epoch);throw error;}finally{this.pending.delete(controller);}
 }
 private async persistedSkillFiles(files:any){
  if(!Array.isArray(files))throw invalid('Skill 文件必须是数组。');
  return Promise.all(files.map(async(input:any)=>{
   const file=object(input),path=identifier(file.path);
   if(path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>part==='..'||part==='.'||part===''))throw invalid('Skill 文件路径不正确。');
   const saved=this.skillFiles.get(String(file.url));if(saved)return{...saved,path,primary:!!file.primary,type:file.type??saved.type};
   if(typeof file.content==='string')return{path,content:file.content,encoding:file.encoding??'utf8',mimeType:file.mimeType??'text/markdown',type:file.type??(/\.md$/i.test(path)?'md':'file'),primary:!!file.primary};
   const {bytes,mimeType}=await this.readAssetBytes(file.assetId??file.url),text=/^(?:text\/|application\/(?:json|javascript|xml))/.test(mimeType)||/\.(?:md|txt|json|ya?ml|js|ts|css|html|svg)$/i.test(path);
   let content:string;if(text)content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);else{let binary='';for(let start=0;start<bytes.length;start+=32768)binary+=String.fromCharCode(...bytes.slice(start,start+32768));content=btoa(binary);}
   return{path,content,encoding:text?'utf8':'base64',mimeType,type:file.type??(text?'md':'file'),primary:!!file.primary};
  }));
 }
 private nativeSkillFiles(files:any){
  if(!Array.isArray(files))throw new ApiError(502,'INVALID_SKILL_FILES','服务返回了无效的 Skill 文件。');
  return files.map((value:any)=>{
   const file=object(value);if(typeof file.content!=='string')throw new ApiError(502,'INVALID_SKILL_FILES','服务未返回 Skill 文件内容。');
   const bytes=file.encoding==='base64'?Uint8Array.from(atob(file.content),char=>char.charCodeAt(0)):new TextEncoder().encode(file.content);
   const url=URL.createObjectURL(new Blob([bytes],{type:file.mimeType??'text/markdown'}));this.skillFiles.set(url,file);
   return{path:file.path,url,type:file.type??(/\.md$/i.test(file.path)?'md':'file'),primary:!!file.primary,...(file.encoding==='base64'?{}:{content:file.content})};
  });
 }
 private async encodeStored(value:any,key=''):Promise<any>{
  if(typeof value==='string'){
   const encoded=this.assets.encodeAsset?.(value)??value;
   if(encoded.startsWith('rhtv-asset:'))return'rhtv-asset:'+await this.assetId(encoded);
   if(/url|(?:uri|thumbnail|cover|image|video|audio|src|model)$/i.test(key)&&/^(?:https?:|blob:|data:|\/)/i.test(value))return'rhtv-asset:'+await this.assetId(value);
   return value;
  }
  if(Array.isArray(value))return Promise.all(value.map(item=>this.encodeStored(item,key)));
  if(value&&typeof value==='object'){const entries=await Promise.all(Object.entries(value).map(async([k,v])=>[k,await this.encodeStored(v,k)]));return Object.fromEntries(entries);}
  return value;
 }
 private async decodeStored(value:any):Promise<any>{
  if(typeof value==='string'&&value.startsWith('rhtv-asset:'))return this.mediaUrl(value.slice(11));
  if(Array.isArray(value))return Promise.all(value.map(item=>this.decodeStored(item)));
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await this.decodeStored(item)])));
  return value;
 }
 private async categories(namespace:string,b:Row={}){
  const result=await this.request(query('/catalog/categories',{namespace,...b}));if(!Array.isArray(result))throw new ApiError(502,'INVALID_RESOURCE_CATEGORIES','服务返回了无效的资源分类。');return result;
 }
 private listFilters(b:Row,extra:Row={}){return{keyword:String(b.keyword??b.name??b.search??'').trim()||undefined,categoryId:b.categoryId??b.code,categoryIds:b.categoryIds??b.categoryIdsList??b.categoryIdList,...extra};}
 private registerCatalog(family:string,row:Row){
  const base=baseOf(row);if(!this.assets.registerCatalogMedia||base.scope!=='SYSTEM'||!Number.isSafeInteger(base.revision))return;
  const walk=(value:any,path:string,key:string)=>{
   if(typeof value==='string'&&/url|(?:uri|thumbnail|cover|image|video|audio|src|model)$/i.test(key)&&/^(?:https?:|\/)/i.test(value))this.assets.registerCatalogMedia!(value,{family,resourceId:identifier(base.id),revision:base.revision,path});
   else if(Array.isArray(value))value.forEach((item,index)=>walk(item,path+'/'+index,key));
   else if(value&&typeof value==='object')for(const [name,item]of Object.entries(value))walk(item,path+'/'+name.replace(/~/g,'~0').replace(/\//g,'~1'),name);
  };walk(row.content,'','');
 }
 private async nativeResource(family:Family,row:Row):Promise<Row>{
  const resource=baseOf(row),content=contentOf(row),id=identifier(resource.id);this.remember('/'+family,row);
  this.registerCatalog(({workflows:'WORKFLOW',prompts:'PROMPT',skills:'SKILL',apps:'APP',voices:'VOICE'} as const)[family],row);
  const cover=resource.coverAssetId?await this.mediaUrl(resource.coverAssetId):resource.coverUrl??null;
  const common={...resource,id,name:resource.name,description:resource.description??'',thumbnail:cover,coverUrl:cover,favorited:!!resource.favorited,createTime:resource.createdAt,updateTime:resource.updatedAt,resourceVersion:resource.version,resourceRevision:resource.revision};
  if(family==='workflows'){
   const graph=await this.decodeStored(content.graph??content.workflowContent??content);
   return{...common,...content,code:resource.categoryIds?.[0]??content.code??'',workflowContent:graph.schemaVersion==='1'?decodeGraph(graph,value=>value):graph,isOwn:resource.scope==='USER'};
  }
  if(family==='prompts'){
   // Published presets keep their immutable selector and media descriptor in
   // content.preset. USER media remains resolved exclusively through owned assets.
   const preset=resource.scope==='SYSTEM'&&content.preset&&typeof content.preset==='object'?content.preset:null;
   const preview=makeupPreview(resource,preset);
   return{...common,...content,...(preset?{...preset,id,name:resource.name,prefixPrompt:preset.prefixPrompt??'',suffixPrompt:preset.suffixPrompt??'',promptType:preset.promptType??undefined}:{}),...(preview?{coverUrl:preview,thumbnail:preview}:{}),categoryId:resource.categoryIds?.[0]??content.categoryId,referenceImageUrl:content.referenceAssetId?await this.mediaUrl(content.referenceAssetId):preset?.referenceImageUrl??null};
  }
  if(family==='skills')return{...common,...content,content:content.files?this.nativeSkillFiles(content.files):content.content??[],skillId:id,type:resource.scope==='USER'?'USER':'COMMON',isCollect:!!resource.favorited,isPlatform:resource.scope==='SYSTEM',outputContentSample:await this.decodeStored(content.samples??content.outputContentSample??[])};
  if(family==='apps')return{...common,...content,webappId:id,webappName:resource.name,thumbnailUrl:cover,collect:!!resource.favorited,intro:resource.description??'',workflowId:content.workflow?.resourceId??content.workflowId,inputNodes:await this.decodeStored(content.inputNodes??[]),covers:cover?[{url:cover,thumbnailUri:cover}]:content.covers??[]};
  return{...common,...content,voiceId:id,voiceName:resource.name,voiceNameEn:content.nameEn??resource.name,voiceType:content.providerVoiceRef??content.voiceType??id,isCollect:!!resource.favorited,currentVoiceExampleUrl:content.exampleAssetId?await this.mediaUrl(content.exampleAssetId):content.currentVoiceExampleUrl??null,specialLabel:content.labels??[],voiceLabel:content.voiceLabels??[]};
 }
 private resourcePage(family:Family,b:Row,filters:Row={}){return this.page('/'+family,b,this.listFilters(b,filters),row=>this.nativeResource(family,row));}
 private async resourceDetail(family:Family,id:any){return this.nativeResource(family,object(await this.request('/'+family+'/'+idPath(id))));}
 private async resourceWrite(family:Family,b:Row,content:Row){
  const id=b.id??b.skillId,path='/'+family+(id?'/'+idPath(id):''),prior=id?await this.current(path):null,base=prior?baseOf(prior):{},previous=prior?contentOf(prior):{};
  const body={name:b.name??base.name,description:b.description??base.description??'',categoryIds:b.categoryIds??(b.categoryId!==undefined?[String(b.categoryId)]:base.categoryIds??[]),coverAssetId:own(b,'thumbnail')||own(b,'coverUrl')?await this.optionalAsset(b.thumbnail??b.coverUrl):base.coverAssetId??null,content:{...previous,...content}};
  const result=object(await this.mutation(path,body,id?'PUT':'POST',id?await this.version(path):undefined,!id));return this.nativeResource(family,result);
 }
 private async resourceDelete(family:Family,id:any){const path='/'+family+'/'+idPath(id);const result=await this.mutation(path,undefined,'DELETE',await this.version(path));this.objects.delete(path);this.etags.delete(path);return result;}
 private async favorite(family:Family|'characters',id:any,favorited:boolean){
  const path='/'+family+'/'+idPath(id),result=await this.mutation(path+'/favorite',{favorited},'PUT',await this.version(path));
  const revision=this.etags.get(path+'/favorite');if(revision)this.etags.set(path,revision);
  const current=this.objects.get(path);if(current){const base=baseOf(current);base.favorited=favorited;if(revision)base.revision=Number(revision.replace(/"/g,''));}
  return result;
 }
 private usage(family:Family,id:any,b:Row={}){return this.mutation('/'+family+'/'+idPath(id)+'/usage',{...(b.canvasId||b.projectId?{projectId:String(b.canvasId??b.projectId)}:{}),...(b.nodeId?{nodeId:String(b.nodeId)}:{})},'POST',undefined,true);}
 private async nativeGallery(row:Row){
  this.remember('/library/items',row);const ids=row.assetIds;if(!Array.isArray(ids))throw new ApiError(502,'INVALID_GALLERY','服务返回了无效的图库。');
  const images=await Promise.all(ids.map(async(id:string,sortOrder:number)=>({id,assetId:id,imageUrl:await this.mediaUrl(id),isMain:row.mainAssetId===id,sortOrder})));
  return{...row,name:row.title,images,mainImageId:row.mainAssetId,mainImageUrl:images.find(image=>image.isMain)?.imageUrl??null,coverUrl:images.find(image=>image.isMain)?.imageUrl??images[0]?.imageUrl??null,imageCount:images.length};
 }
 private async gallery(path:string,b:Row){
  const match=path.match(/^\/canvas\/(role|scene)\/(.+)$/)!;const kind=match[1]==='role'?'ROLE':'SCENE',action=match[2];
  if(action==='list')return this.page('/library/items',b,{kind,keyword:b.keyword},row=>this.nativeGallery(row));
  const id=b.id??b.galleryId,itemPath=action==='create'?'/library/items':'/library/items/'+idPath(id),prior=action==='create'?null:await this.current(itemPath);
  if(prior&&prior.kind!==kind)throw new ApiError(404,'RESOURCE_NOT_FOUND','图库不存在。');
  if(action==='detail')return this.nativeGallery(prior!);
  if(action==='delete'){const result=await this.mutation(itemPath,undefined,'DELETE',await this.version(itemPath));this.objects.delete(itemPath);this.etags.delete(itemPath);return result;}
  let assetIds:string[]=prior?.assetIds??[],mainAssetId:string|null=prior?.mainAssetId??null;
  if(action==='create'||action==='update'){
   const refs=b.assetIds??b.images??b.imageUrls;
   if(refs!==undefined){if(!Array.isArray(refs))throw invalid('图库图片必须是数组。');assetIds=await Promise.all(refs.map(ref=>this.assetId(ref)));}
   if(own(b,'mainAssetId')||own(b,'mainImageId')||own(b,'mainImageUrl'))mainAssetId=await this.optionalAsset(b.mainAssetId??b.mainImageId??b.mainImageUrl);
  }else if(action==='image/add'){
   const refs=b.assetIds??b.images??b.imageUrls??[b.assetId??b.imageUrl??b.url];if(!Array.isArray(refs))throw invalid('图库图片必须是数组。');
   const added=await Promise.all(refs.map(ref=>this.assetId(ref)));assetIds=[...new Set([...assetIds,...added])];
  }else if(action==='image/delete'){
   const ids=b.imageIds;if(!Array.isArray(ids)||ids.some(id=>!assetIds.includes(String(id))))throw invalid('图片不属于当前图库。');
   assetIds=assetIds.filter(id=>!ids.includes(id));if(mainAssetId&&!assetIds.includes(mainAssetId))mainAssetId=null;
  }else if(action==='image/setMain'){
   mainAssetId=b.imageId===null?null:identifier(b.imageId);if(mainAssetId&&!assetIds.includes(mainAssetId))throw invalid('主图不属于当前图库。');
  }else if(action==='image/sort'){
   if(!Array.isArray(b.items))throw invalid('图片排序必须是数组。');const ordered=[...b.items].sort((a,c)=>Number(a.sortOrder)-Number(c.sortOrder)).map(item=>identifier(item.imageId));
   if(ordered.length!==assetIds.length||new Set(ordered).size!==assetIds.length||ordered.some(id=>!assetIds.includes(id)))throw invalid('图片排序必须包含图库中的全部图片。');assetIds=ordered;
  }else throw new ApiError(501,'NOT_IMPLEMENTED','此图库操作尚未实现。');
  const body={title:b.title??b.name??prior?.title,description:b.description??prior?.description??'',kind,assetIds,mainAssetId};
  const result=object(await this.mutation(action==='create'?'/library/items':itemPath,body,action==='create'?'POST':'PATCH',action==='create'?undefined:await this.version(itemPath),action==='create'));
  return this.nativeGallery(result);
 }
 private async nativeFolder(row:Row){
  this.remember('/library/folders',row);const thumbnails=await Promise.all((row.thumbnailAssetIds??[]).map((id:string)=>this.mediaUrl(id)));
  return{...row,code:row.categoryCode,teamId:null,nodeType:'FOLDER',isFolder:true,type:'FOLDER',thumbnail:thumbnails[0]??null,thumbnails};
 }
 private async nativeLibraryItem(row:Row){
  if(row.kind==='ROLE'||row.kind==='SCENE')return this.nativeGallery(row);
  this.remember('/library/nodes',row);const content=contentOf(row);return{...row,itemName:row.name,nodeType:content.nodeType??row.kind,content:await this.decodeStored(content.nodeContent??content),thumbnail:row.thumbnailAssetId?await this.mediaUrl(row.thumbnailAssetId):null};
 }
 private async folderTarget(code:any){
  const value=identifier(code);if(/^USER_[A-Z_]+$/.test(value))return{categoryCode:value,parentId:null};
  const folder=await this.current('/library/folders/'+idPath(value));return{categoryCode:folder.categoryCode,parentId:identifier(folder.id)};
 }
 private async library(path:string,b:Row){
  const prefix='/canvas/asset/user/',action=path.slice(prefix.length),filters={categoryCode:b.code&&b.code!=='ALL'?b.code:undefined,keyword:b.keyword,afterTime:b.afterTime,beforeTime:b.beforeTime,kind:b.nodeType};
  if(action==='folder/first-level/list'||action==='group/list')return this.page('/library/folders',b,filters,row=>this.nativeFolder(row));
  if(action==='folder/second-level/list'||action==='folder/item/search')return this.page('/library/entries',b,{...filters,parentId:b.parentGroupId,recursive:action.endsWith('/search')||undefined,nodeKind:b.nodeKind,nodeTypes:b.nodeTypes},row=>row.type==='FOLDER'?this.nativeFolder(object(row.folder)):this.nativeLibraryItem(object(row.item)));
  if(action==='folder/second-level/item/list'||action==='group/item/list')return this.page('/library/entries',b,{...filters,parentId:b.groupId,itemType:'NODE'},row=>this.nativeLibraryItem(object(row.item??row)));
  if(action==='folder/create'||action==='group/create'){const target=await this.folderTarget(b.parentCode??b.code);return this.nativeFolder(object(await this.mutation('/library/folders',{name:b.name,kind:'MIXED',...target},'POST',undefined,true)));}
  if(action==='group/rename'||action==='folder/thumbnail/update'){
   const target='/library/folders/'+idPath(b.groupId),body=action==='group/rename'?{name:b.name}:{thumbnailAssetIds:await Promise.all((b.thumbnails??[]).map((ref:any)=>this.assetId(ref)))};
   return this.nativeFolder(object(await this.mutation(target,body,'PATCH',await this.version(target))));
  }
  if(action==='group/item/rename'){
   const target='/library/nodes/'+idPath(b.itemId),prior=await this.current(target);return this.nativeLibraryItem(object(await this.mutation(target,{name:b.itemName,kind:prior.kind,categoryCode:prior.categoryCode,folderId:prior.folderId,itemType:'NODE',content:prior.content,thumbnailAssetId:prior.thumbnailAssetId},'PATCH',await this.version(target))));
  }
  if(action==='folder/batch-delete'||action==='folder/move'||action==='folder/item/batch-add'){
   const state=object(await this.request('/library/state')),expectedCollectionRevision=state.revision;
   if(!Number.isSafeInteger(expectedCollectionRevision)||expectedCollectionRevision<1)throw new ApiError(502,'MISSING_RESOURCE_REVISION','素材库未返回有效版本。');
   if(action==='folder/item/batch-add'){
    if(!Array.isArray(b.nodes)||!b.nodes.length)throw invalid('没有可保存的素材节点。');
    const folder=await this.current('/library/folders/'+idPath(b.folderId)),items=await Promise.all(b.nodes.map(async(node:Row)=>{
     const nodeContent=await this.encodeStored(parse(node.content)),refs=new Set<string>();const scan=(v:any)=>{if(typeof v==='string'&&v.startsWith('rhtv-asset:'))refs.add(v.slice(11));else if(Array.isArray(v))v.forEach(scan);else if(v&&typeof v==='object')Object.values(v).forEach(scan);};scan(nodeContent);
     return{name:node.itemName,kind:node.nodeType,categoryCode:folder.categoryCode,folderId:folder.id,itemType:'NODE',content:{nodeType:node.nodeType,nodeContent,assetIds:[...refs],modelAssetIds:[]},thumbnailAssetId:await this.optionalAsset(node.thumbnail)};
    }));return this.mutation('/library/batch-create',{items,expectedCollectionRevision},'POST',undefined,true);
   }
   const selection={itemIds:(b.itemIds??[]).map(String),folderIds:(b.groupIds??[]).map(String),expectedCollectionRevision};
   if(action==='folder/batch-delete')return this.mutation('/library/batch-delete',selection,'POST',undefined,true);
   const target=await this.folderTarget(b.targetCode);return this.mutation('/library/move',{...selection,targetCategoryCode:target.categoryCode,targetFolderId:target.parentId},'POST',undefined,true);
  }
  throw new ApiError(501,'NOT_IMPLEMENTED','此素材库操作尚未实现。');
 }
 private nativeTags(set:Row):Row[]{
  if(!Array.isArray(set.tags))throw new ApiError(502,'INVALID_TAG_SET','服务返回了无效的标签列表。');
  return set.tags.map((tag:Row)=>{if(tag.status!==0&&tag.status!==1&&typeof tag.visible!=='boolean')throw new ApiError(502,'INVALID_TAG_SET','服务未返回标签显隐状态。');return{...tag,id:String(tag.id),sortOrder:tag.sortOrder??tag.seq,status:tag.status??(tag.visible?1:0)};});
 }
 private async tags(path:string,b:Row){
  const action=path.slice('/canvas/node/tag/'.length);if(action==='list')return this.nativeTags(object(await this.request('/tags')));
  const etag=await this.version('/tags'),previousIds=new Set((this.objects.get('/tags')?.tags??[]).map((tag:Row)=>String(tag.id)));let result:Row;
  if(action==='create')result=object(await this.mutation('/tags',{name:b.name,color:b.color},'POST',etag,true));
  else if(action==='update'||action==='status')result=object(await this.mutation('/tags/'+idPath(b.id),action==='status'?{visible:Number(b.status)===1}:{...(own(b,'name')?{name:b.name}:{}),...(own(b,'color')?{color:b.color}:{})},'PATCH',etag));
  else if(action==='delete')result=object(await this.mutation('/tags/'+idPath(b.id),undefined,'DELETE',etag));
  else if(action==='sort')result=object(await this.mutation('/tags/order',{ids:b.ids},'PUT',etag));
  else if(action==='initPreset')result=object(await this.mutation('/tags/preset',{preset:b.preset,replace:!!b.replace},'POST',etag,true));
  else throw new ApiError(501,'NOT_IMPLEMENTED','此标签操作尚未实现。');
  this.objects.set('/tags',result);const revision=etagOf({data:result});if(revision)this.etags.set('/tags',revision);
  const tags=this.nativeTags(result);if(action==='create'){const added=tags.filter(tag=>!previousIds.has(tag.id));if(added.length!==1)throw new ApiError(502,'INVALID_TAG_SET','服务未返回新建标签的标识。');return added[0];}return tags;
 }
 async handle(path:string,body:any):Promise<any|undefined>{const epoch=this.epoch,result=await this.handleOwned(path,body);this.check(epoch);return result;}
 private async handleOwned(path:string,body:any):Promise<any|undefined>{
  const b=body&&typeof body==='object'?body:{};
  if(/^\/canvas\/(?:role|scene)\//.test(path))return this.gallery(path,b);
  if(path.startsWith('/canvas/asset/user/')){if(b.teamId&&String(b.teamId)!=='0')throw new ApiError(501,'TEAM_LIBRARY_USE_STUDIO_PAGE','请使用 STUDIO 团队资产页管理共享内容。');return this.library(path,b);}
  if(path.startsWith('/canvas/node/tag/'))return this.tags(path,b);
  if(path==='/canvas/character-library/filter/options')return this.request('/characters/filters');
  if(path==='/canvas/character-library/list')return this.page('/characters',b,{keyword:b.keyword,favoriteOnly:!!b.favoriteOnly,filters:b.filters},row=>{const base=baseOf(row),content=row.resource?contentOf(row):row;this.remember('/characters',row);this.registerCatalog('CHARACTER',row);return{...base,...content,id:String(base.id),favorite:!!base.favorited,attributes:Array.isArray(content.attributes)?Object.fromEntries(content.attributes.map((attribute:Row)=>[attribute.categoryCode,{optionCode:attribute.optionCode,name:attribute.optionName??attribute.name,colorValue:attribute.colorValue}])):content.attributes};});
  if(path==='/canvas/character-library/favorite')return this.favorite('characters',b.id,Number(b.action)===1);
  if(path==='/canvas/asset/type/list')return this.categories(b.category==='COMMON'?'ASSET_COMMON':'ASSET_USER');
  if(path==='/canvas/common-workflow/type/list')return this.categories('WORKFLOW');
  if(path==='/canvas/common-workflow/list')return this.resourcePage('workflows',b,{scope:'SYSTEM',recommended:b.recommended});
  if(path==='/canvas/common-workflow/favorite/list')return this.resourcePage('workflows',b,{favoriteOnly:true});
  if(path==='/canvas/common-workflow/favorite')return this.favorite('workflows',b.commonWorkflowId,b.action==='ADD');
  if(path==='/canvas/workflow/list')return this.resourcePage('workflows',b,{scope:'USER'});
  if(path==='/canvas/workflow/detail'||path==='/canvas/admin/common-workflow/detail')return this.resourceDetail('workflows',b.id??b.commonWorkflowId);
  if(path==='/canvas/workflow/delete')return this.resourceDelete('workflows',b.id);
  if(path==='/canvas/workflow/save'){
   const graph=object(await this.encodeStored(parse(b.workflowContent)));return this.resourceWrite('workflows',b,{workflowContent:graph.schemaVersion==='1'?graph:encodeGraph(graph as any,value=>value)});
  }
  if(path==='/canvas/common-workflow/apply')return this.mutation('/workflows/'+idPath(b.commonWorkflowId)+'/apply',{projectId:identifier(b.canvasId)},'POST',undefined,true);
  if(path==='/canvas/prompt/category/tree')return this.categories('PROMPT',{scope:b.scope,menuType:b.menuType});
  if(path==='/canvas/prompt/system/list'||path==='/canvas/prompt/system/batchList')return this.resourcePage('prompts',b,{scope:'SYSTEM',categoryIds:b.categoryIds});
  if(path==='/canvas/prompt/user/list')return this.resourcePage('prompts',b,{scope:'USER',promptType:'PROMPT'});
  if(path==='/canvas/prompt/user/style/list')return this.resourcePage('prompts',b,{scope:'USER',promptType:'STYLE'});
  if(path==='/canvas/prompt/favorite/list')return this.resourcePage('prompts',b,{favoriteOnly:true});
  if(path==='/canvas/prompt/use/record/list')return this.resourcePage('prompts',b,{recentOnly:true});
  if(path==='/canvas/prompt/favorite/add'||path==='/canvas/prompt/favorite/cancel')return this.favorite('prompts',b.promptId,path.endsWith('/add'));
  if(path==='/canvas/prompt/use/record/add')return this.usage('prompts',b.id,b);
  if(path==='/canvas/prompt/user/delete'||path==='/canvas/prompt/user/style/delete')return this.resourceDelete('prompts',b.id);
  if(path==='/canvas/prompt/create'||path==='/canvas/prompt/user/update'||path==='/canvas/prompt/user/style/create'||path==='/canvas/prompt/user/style/update'){
   const content:Row={promptType:path.includes('/style/')?'STYLE':'PROMPT'};
   for(const key of ['prefixPrompt','suffixPrompt'])if(own(b,key))content[key]=b[key];
   if(!b.id){content.prefixPrompt??='';content.suffixPrompt??='';content.mediaScope=b.scope??'IMAGE';content.referenceAssetId=await this.optionalAsset(b.referenceImageUrl);}
   else if(own(b,'referenceImageUrl'))content.referenceAssetId=await this.optionalAsset(b.referenceImageUrl);
   return this.resourceWrite('prompts',b,content);
  }
  if(path==='/canvas/home/hot-skill/query')return(await this.resourcePage('skills',{page:1,size:6},{scope:'SYSTEM',category:'CANVAS_AGENT',sort:'HOTTEST'})).records;
  if(path==='/canvas/skill/category/list'||path==='/canvas/skill/type/list')return this.categories('SKILL',{category:b.category,type:b.type});
  if(path==='/canvas/skill/list')return this.resourcePage('skills',b,{scope:b.type==='USER'?'USER':'SYSTEM',category:b.category,type:b.type,categoryId:b.categoryId,code:b.code,sort:b.querySortBy});
  if(path==='/canvas/skill/collect/list')return this.resourcePage('skills',b,{favoriteOnly:true,category:b.category});
  if(path==='/canvas/skill/detail')return this.resourceDetail('skills',b.skillId);
  if(path==='/canvas/skill/delete')return this.resourceDelete('skills',b.skillId);
  if(path==='/canvas/skill/collect'||path==='/canvas/skill/uncollect')return this.favorite('skills',b.skillId,path.endsWith('/collect'));
  if(path==='/canvas/skill/save'){
   const content:Row={category:b.category??'CANVAS_AGENT'};for(const key of ['intro','useScenario','useGuide','outputContentDesc','presetPrompt','outputType','code'])if(own(b,key))content[key]=b[key];
   if(own(b,'content')||own(b,'files')){content.files=await this.persistedSkillFiles(b.content??b.files);const primary=content.files.find((file:Row)=>file.primary&&file.encoding!=='base64');content.markdown=primary?.content??'';}
   if(own(b,'outputContentSample'))content.samples=await this.encodeStored(b.outputContentSample);return this.resourceWrite('skills',b,content);
  }
  if(path==='/canvas/skill/use/record/add')return Promise.all((b.skillIds??[]).map((id:any)=>this.usage('skills',id,b)));
  if(path==='/canvas/api/skill/list/agent')return(await this.resourcePage('skills',{page:1,size:10000},{scope:'SYSTEM',category:'CANVAS_AGENT'})).records;
  if(path==='/api/portal/tag/tree')return this.categories('APP');
  if(path==='/api/webapp/list')return this.resourcePage('apps',b,{scope:'SYSTEM',sort:b.sort,categoryIds:b.tags,days:b.days});
  if(path==='/api/webapp/user/list')return this.resourcePage('apps',b,{scope:'USER'});
  if(path==='/api/likeOrCollect/webapp/list')return this.resourcePage('apps',b,{favoriteOnly:true});
  if(path==='/api/webapp/detail')return this.resourceDetail('apps',b.webappId);
  if(path==='/api/likeOrCollect/create'||path==='/api/likeOrCollect/cancel'){
   if(b.dataType!=='WEBAPP')return undefined;return this.favorite('apps',b.dataId,path.endsWith('/create'));
  }
  if(path==='/api/likeOrCollect/status2')return(await this.resourceDetail('apps',b.dataId)).collect;
  if(path==='/api/workflow/getDetail'){const workflow=await this.resourceDetail('workflows',b.workflowId);return{...workflow,customNodes:workflow.customNodes??workflow.workflowContent?.nodes};}
  if(path==='/api/portal/creation/list')return this.page('/apps/'+idPath(b.webappId)+'/creations',b,{},row=>this.decodeStored(row));
  if(path==='/canvas/model/voice/lang/list')return this.categories('VOICE_LANGUAGE',{modelCode:b.modelCode});
  if(path==='/canvas/model/voice/scene/list')return this.categories('VOICE_SCENE',{modelCode:b.modelCode});
  if(path==='/canvas/model/voice/record/list')return this.resourcePage('voices',b,{modelCode:b.modelCode,favoriteOnly:b.queryTargetType==='VOICE_USER_COLLECT',keyword:b.voiceName,langId:b.langId,dialectId:b.dialectId,sceneIdList:b.sceneIdList,gender:b.gender});
  if(path==='/canvas/model/voice/record/collect'||path==='/canvas/model/voice/record/uncollect')return this.favorite('voices',b.voiceId,path.endsWith('/collect'));
  if(path==='/canvas/user/detail')return this.request('/preferences');
  if(path==='/canvas/user/update/shortcutKeyConfig')return this.mutation('/preferences',{shortcutKeyConfig:b.shortcutKeyConfig},'PATCH',await this.version('/preferences'));
  if(path==='/canvas/config/query'||path==='/canvas/config/queryByTypes'){
   const types=path.endsWith('/query')?[b.type]:b.types,rows=await this.request(query('/catalog/configs',{types}));
   if(!Array.isArray(rows))throw new ApiError(502,'INVALID_CONFIG_CATALOG','服务返回了无效的界面配置。');
   // Native transport selection is an explicit integration projection, after reading persisted config.
   const native=rows.map((row:Row)=>this.assets.nativeConfigs&&own(this.assets.nativeConfigs,row.type)?{...row,content:this.assets.nativeConfigs[row.type]}:row);return path.endsWith('/query')?native.find((row:Row)=>row.type===b.type)??null:native;
  }
  if(path==='/api/portal/v2/getDictConfig'){
   const keys=b.dictTypes;
   if(Array.isArray(keys)&&keys.some((key:any)=>sketchDictionaryKeys.includes(key))){
    const other=keys.filter((key:string)=>!sketchDictionaryKeys.includes(key));
    const rows=other.length?await this.request(query('/catalog/dictionaries',{types:other})):[];
    return [...rows,...sketchDictionaries(keys)];
   }
   return this.request(query('/catalog/dictionaries',{types:keys}));
  }
  if(path==='/canvas/home/highlight/query')return(await this.page('/catalog/entries',{page:1,size:10000},{namespace:'HOME_HIGHLIGHT'},row=>this.nativeCatalogEntry(row,'HOME_HIGHLIGHT'))).records;
  if(path==='/task/quick-creation/inspiration/tags')return this.categories('INSPIRATION_TAG');
  if(path==='/task/quick-creation/inspiration/templates')return this.page('/catalog/entries',b,{namespace:'INSPIRATION_TEMPLATE',keyword:b.keyword,categoryId:b.tagId},row=>this.nativeCatalogEntry(row,'INSPIRATION_TEMPLATE'));
  if(path==='/task/quick-creation/inspiration/template/detail')return this.nativeCatalogEntry(object(await this.request(query('/catalog/entries/'+idPath(b.id??b.templateId),{namespace:'INSPIRATION_TEMPLATE'}))),'INSPIRATION_TEMPLATE');
  if(path==='/canvas/director/model/list'||path==='/canvas/director/define/list'){const namespace=path.endsWith('/define/list')?'DIRECTOR_DEFINE':'DIRECTOR_MODEL';return(await this.page('/catalog/entries',{page:1,size:10000},{namespace,keys:b.keys},row=>this.nativeCatalogEntry(row,namespace))).records;}
  if(path==='/canvas/animation/category/list')return this.categories('ANIMATION');
  if(path==='/canvas/animation/resource/list')return this.page('/catalog/entries',b,{namespace:'ANIMATION',categoryCode:b.categoryCode,keyword:b.keyword},row=>this.nativeCatalogEntry(row,'ANIMATION'));
  if(path==='/canvas/director/model/user/list')return this.page('/director-models',b,{keyword:b.keyword},async row=>{const base=baseOf(row),content=contentOf(row);this.remember('/director-models',row);return{...base,...content,url:await this.mediaUrl(content.modelAssetId),previewImage:content.previewAssetId?await this.mediaUrl(content.previewAssetId):null};});
  if(path==='/canvas/director/model/user/create'){const result=object(await this.mutation('/director-models',{name:b.name,description:'',categoryIds:[],content:{modelAssetId:await this.assetId(b.modelAssetId??b.url),previewAssetId:await this.optionalAsset(b.previewImage),categoryId:b.categoryId??''}},'POST',undefined,true));return{...baseOf(result),...contentOf(result)};}
  if(path==='/canvas/director/model/user/delete'){const target='/director-models/'+idPath(b.id);return this.mutation(target,undefined,'DELETE',await this.version(target));}
  if(path==='/canvas/director/project/list')return this.page('/director-projects',b,{type:b.type&&b.type!=='ALL'?b.type:undefined},row=>this.nativeDirector(row));
  if(path==='/canvas/director/project/detail')return this.nativeDirector(object(await this.request('/director-projects/'+idPath(b.id))));
  if(path==='/canvas/director/project/create')return this.nativeDirector(object(await this.mutation('/director-projects',{name:b.name,description:'',categoryIds:[],coverAssetId:await this.optionalAsset(b.thumbnail),content:{type:b.type,content:await this.encodeStored(parse(b.content)??{})}},'POST',undefined,true)));
  if(path==='/canvas/director/project/update'){
   const target='/director-projects/'+idPath(b.id),prior=await this.current(target),base=baseOf(prior),content=contentOf(prior),data:Row={name:b.name??base.name,description:base.description??'',categoryIds:base.categoryIds??[],coverAssetId:own(b,'thumbnail')?await this.optionalAsset(b.thumbnail):base.coverAssetId??null,content:{...content,...(own(b,'content')?{content:await this.encodeStored(parse(b.content))}:{})}};
   return this.nativeDirector(object(await this.mutation(target,data,'PUT',await this.version(target))));
  }
  if(path==='/canvas/director/project/delete'){const target='/director-projects/'+idPath(b.id);return this.mutation(target,undefined,'DELETE',await this.version(target));}
  return undefined;
 }
 private async nativeDirector(row:Row){this.remember('/director-projects',row);const base=baseOf(row),content=contentOf(row);return{...base,type:content.type,content:await this.decodeStored(content.content),thumbnail:base.coverAssetId?await this.mediaUrl(base.coverAssetId):base.coverUrl??null};}
 private nativeCatalogEntry(row:Row,namespace:string){this.registerCatalog(namespace,row);const base=baseOf(row),content=contentOf(row);return{...base,...content,id:String(base.id)};}
}
