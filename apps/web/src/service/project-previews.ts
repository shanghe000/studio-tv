import {ApiError} from '../api/client';
import type {Project} from '../api/types';

export interface ProjectPreview {
 project:Project;
 role:'OWNER'|'EDITOR'|'VIEWER';
 nodesCount:number;
 thumbnail:{assetId:string;url:string;urlsExpireAt:string}|null;
}
const idPattern=/^[A-Za-z0-9_-]{1,200}$/;
const validId=(value:any)=>typeof value==='string'&&idPattern.test(value);
const invalid=()=>new ApiError(502,'INVALID_PROJECT_PREVIEW','服务返回了无效的项目预览。');
export function projectPreviewIds(ids:string[]){
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw new ApiError(400,'INVALID_PROJECT_PREVIEW_QUERY','项目预览标识不正确。');
 return ids;
}
/** This DTO is presentation only. It never creates a graph or grants writes. */
export function projectPreviewPage(data:any,requested:string[],origin=globalThis.location?.origin??'http://localhost'):ProjectPreview[]{
 if(!data||!Array.isArray(data.items)||data.items.length!==requested.length)throw invalid();
 return data.items.map((value:any,index:number)=>{
  const project=value?.project,role=value?.role;
  if(!project||project.id!==requested[index]||!validId(project.ownerId)||typeof project.name!=='string'||project.teamId!==null||!['OWNER','EDITOR','VIEWER'].includes(role)||project.role!==role||typeof project.pinned!=='boolean'||!Number.isSafeInteger(project.revision)||project.revision<1||!Number.isFinite(Date.parse(project.createdAt))||!Number.isFinite(Date.parse(project.updatedAt))||project.coverAssetId!==null&&!validId(project.coverAssetId)||!Number.isSafeInteger(value.nodesCount)||value.nodesCount<0)throw invalid();
  if(value.thumbnail!==null){
   const thumbnail=value.thumbnail;if(!thumbnail||!validId(thumbnail.assetId)||typeof thumbnail.url!=='string'||!Number.isFinite(Date.parse(thumbnail.urlsExpireAt)))throw invalid();
   let url:URL;try{url=new URL(thumbnail.url,origin);}catch{throw invalid();}
   if(url.origin!==origin||url.username||url.password||url.hash||url.pathname!=='/storage/assets/'+encodeURIComponent(thumbnail.assetId)||!url.searchParams.get('token'))throw invalid();
  }
  return value as ProjectPreview;
 });
}
export function nativeProjectPreview(value:ProjectPreview){
 const createdTime=Date.parse(value.project.createdAt),updatedTime=Date.parse(value.project.updatedAt),thumbnail=value.thumbnail?.url??'';
 return{...value.project,role:value.role,canvasId:value.project.id,type:'CANVAS',createdTime,updatedTime,createTime:createdTime,updateTime:updatedTime,thumbnail,cover:thumbnail,nodesCount:value.nodesCount};
}
