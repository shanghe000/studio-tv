import {ApiError} from '../api/client';
import type {Asset} from '../api/types';
import {randomUuid} from '../browser-compat';
import type {CollaborationAdapter,TeamImport} from './collaboration';
import type {ServiceStorage} from './storage';

// The frozen canvas registers these individual node renderers. Compound
// groups need a multi-node import contract and are deliberately not guessed.
const supported=new Set(['rh-text','rh-image','rh-video','rh-audio','rh-video-edit','rh-script','rh-video-compose','rh-video-remake','rh-quick-cut','rh-video-analysis','rh-remake-request','rh-entity','rh-role','rh-scene','text-input','image-input','video-input','audio-input','audio','image','video','video-edit','image-gen','video-gen','text-to-image','image-to-image','text-to-video','image-to-video','llm','llm-prompt-enhance','llm-image-describe','llm-content-expand','preview-output','character-card','rh-ai','rh-browser','rh-comment','rh-w3d','rh-3d','rh-director','director']);
const aliases:Record<string,string>={TEXT:'rh-text',IMAGE:'rh-image',VIDEO:'rh-video',AUDIO:'rh-audio'};
function mediaData(type:string,data:any,entry:TeamImport['entry']){
 if(data.url){
  if(type==='rh-image'){if(!data.sourceObjects?.length)data.sourceObjects=[data.url];delete data.url;}
  if(type==='rh-video'){if(!data.videoUrl)data.videoUrl=data.url;delete data.url;}
  if(type==='rh-audio'){if(!data.audioUrl)data.audioUrl=data.url;delete data.url;}
  // Signed content URLs have no filename extension. The model renderer's
  // outputType discriminator must accompany a real model reference.
  if(type==='rh-3d'&&!data.output?.length){const asset=entry.assets.find(asset=>asset.id===entry.content.primaryAssetId)??entry.assets[0],format=asset?.mimeType==='model/gltf-binary'?'glb':asset?.mimeType==='model/gltf+json'?'gltf':null;if(!format)throw new ApiError(422,'TEAM_ASSET_UNSUPPORTED','此模型格式尚不支持加入画布。');data.output=[{url:data.url,outputType:format,name:entry.name}];delete data.url;}
 }
 if(!data.title)data.title=entry.name;return data;
}

/** Import only the server's remapped content; source task/selection state must
 * not be mistaken for an execution owned by the destination project. */
export function importedTeamNode(result:TeamImport,assets:Asset[],id='studio-team-'+randomUuid()){
 const source=result.node??result.entry.content?.nodeContent;
 if(source){const node=typeof source==='string'?JSON.parse(source):structuredClone(source),rawType=node.type??result.entry.content.nodeType,type=aliases[rawType]??rawType;if(typeof type!=='string'||!supported.has(type))throw new ApiError(422,'TEAM_NODE_UNSUPPORTED','此团队节点尚不支持加入画布。');const data={...(node.data??node)};for(const key of ['id','type','position','taskId','estimateTaskId','executionId','generating','isGenerating','errorMsg','selected','outputHistory','groupId','nodeIds'])delete data[key];data.status='idle';return{id,type,position:{x:100,y:100},data:mediaData(type,data,result.entry)};}
 const asset=assets.find(row=>row.id===result.entry.content.primaryAssetId)??assets[0];if(!asset||!['IMAGE','VIDEO','AUDIO'].includes(asset.kind)||!(asset.previewUrl||asset.downloadUrl))throw new ApiError(422,'TEAM_ASSET_UNSUPPORTED','此素材尚不支持加入画布。');
 const key=({IMAGE:'sourceObjects',VIDEO:'videoUrl',AUDIO:'audioUrl'} as const)[asset.kind],url=asset.downloadUrl||asset.previewUrl;return{id,type:'rh-'+asset.kind.toLowerCase(),position:{x:100,y:100},data:{title:result.entry.name,isUpload:true,status:'idle',[key]:asset.kind==='IMAGE'?[url]:url}};
}
export async function importTeamIntoProject(collaboration:CollaborationAdapter,storage:ServiceStorage,teamId:string,entryId:string,projectId:string){
 await storage.wait(projectId);await storage.loadProject(projectId);storage.requirePermission(projectId);
 if(storage.isBlocked(projectId))throw new ApiError(409,'PROJECT_SAVE_CONFLICT','目标项目有未解决的草稿冲突，请先处理。');
 const result=await collaboration.importEntry(teamId,entryId,projectId),assets=await Promise.all(result.assets.map(asset=>storage.resolveAsset(asset.id)));storage.requirePermission(projectId);
 const node=importedTeamNode(result,assets),graph=storage.fixture(projectId);await storage.save(projectId,{...graph,nodes:[...graph.nodes,node]});return{projectId,nodeId:node.id};
}
