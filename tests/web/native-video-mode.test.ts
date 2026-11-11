import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {capabilityModel} from '../../apps/web/src/service/execution';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import {resolveSavedVideoMode,savedVideoModeProps} from '../../apps/web/src/service/native-video-mode';
import motion from './fixtures/router-motion-source-capabilities.json';
import h3 from './fixtures/router-h3-capabilities.json';
const cap={...motion.find(row=>row.capabilityRef==='h3-motion-transfer-v1')!,testMode:false},model=capabilityModel(cap),reference=capabilityModel(h3.find(row=>row.capabilityRef==='h3-video-reference-v1')!);
const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
function frozen(name:string,context:any={}){const start=compiled.indexOf('function '+name+'('),end=compiled.indexOf('function ',start+name.length+10);if(start<0||end<0)throw Error('Native mode seam changed');return runInNewContext(compiled.slice(start,end)+';'+name,context);}
const nativeMode=frozen('b1t',{no:(type:string)=>type==='rh-video'}),nativeList=frozen('i0'),nativeFallback=frozen('Bor'),pendingSubtype=frozen('Uor'),nativeInitialMode=frozen('Tor');
const node=()=>({id:'motion',type:'rh-video',data:{modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2',subType:'multimodal-video',params:{prompt:' ',imageUrls:'',videoUrls:'',outputPreset:'landscape-768p-source'},output:[{url:'rhtv-asset:old-result'}],historyStorage:{source:'remote',schemaVersion:1,historyId:'old-history',revision:'8',resultCount:1}}});
function props(){return{targetNode:node(),visible:true,references:[],models:{'multimodal-video':[reference],'video-motion-transfer':[model],'video-video':[model]},videoModelGroups:[{nodeModelList:[{nodeType:'MULTIMODAL_VIDEO',modelList:[reference]},{nodeType:'VIDEO_MOTION_TRANSFER',modelList:[model]}]}],onNodeDataPatch:vi.fn()};}
function repair(input:any){
 const marker='d.useEffect(()=>{if(!g||!p||!m||_||k)return;',start=compiled.indexOf(marker)+ 'd.useEffect(()=>{'.length,end=compiled.indexOf('},[g,y,r,T,o,w,a,s,p,m,_,k,h,J]);',start);if(start<25||end<0)throw Error('Native persisted bucket effect changed');
 const y=input.targetNode.data,w=nativeMode(input.targetNode,[],[],input.initialSubType),T=nativeList(input.models,input.videoModelGroups,w),patch=vi.fn();
 const effect=runInNewContext('(function(){'+compiled.slice(start,end)+'})',{
  g:input.targetNode.id,p:true,m:true,_:false,k:false,y,w,R:{rhModel:y.modelCode},M:{current:null},Uor:pendingSubtype,s:true,a:w,nE:()=>null,IC:(groups:any,ref:string,mode:string)=>nativeList({},groups,mode).some((row:any)=>row.modelCode===ref),oF:(_models:any,ref:string)=>Object.values(input.models).flat().find((row:any)=>row.modelCode===ref),r:input.models,T,o:input.videoModelGroups,Xu:{getState:()=>({get:()=>null})},Bor:nativeFallback,N:{current:null},J:vi.fn(),TR:()=>y,K:{current:{rhModel:y.modelCode,...y.params}},Gu:()=>model,A:model,Vor:(selected:any)=>({rhModel:selected.modelCode,generateNum:1,...selected.params}),Od:(value:any)=>value,E3:vi.fn(),P:vi.fn(),wO:()=>false,kR:"fixture-native-internal",h:patch,
 });effect();return patch;
}
it('reproduces the frozen bucket repair and prevents it by initializing the real selected model mode',()=>{
 const input=props(),before=structuredClone(input.targetNode);expect(repair(input)).toHaveBeenCalledWith(expect.objectContaining({modelCode:reference.modelCode,subType:'multimodal-video'}));
 const view=nativeModelProps(input);expect(view.targetNode.data.subType).toBe('video-motion-transfer');expect(view.initialSubType).toBe('video-motion-transfer');expect(nativeFallback(model.modelCode,nativeList(view.models,view.videoModelGroups,view.initialSubType))).toBeNull();expect(repair(view)).not.toHaveBeenCalled();
 expect(view.models).toBe(input.models);expect(view.videoModelGroups).toBe(input.videoModelGroups);expect(view.targetNode.data.params).toBe(input.targetNode.data.params);expect(input.targetNode).toEqual(before);expect(input.onNodeDataPatch).not.toHaveBeenCalled();expect(nativeModelProps(input).targetNode).toBe(view.targetNode);
});
it('keeps explicit user model/mode changes and current params under the original callback',()=>{
 const input=props(),view=nativeModelProps(input),patch={modelCode:reference.modelCode,subType:'multimodal-video',params:{prompt:'A new authored choice.'}};view.onNodeDataPatch('motion',patch);expect(input.onNodeDataPatch).toHaveBeenCalledWith('motion',patch);
 const next={...input,targetNode:{...input.targetNode,data:{...input.targetNode.data,...patch,capabilityRef:reference.capabilityRef,capabilityVersion:reference.capabilityVersion,parameterSchemaVersion:reference.parameterSchemaVersion}}};expect(savedVideoModeProps(next)).toBe(next);
});
it.each(['version','schema','ref','mode','unavailable','other-kind','other-model','missing-binding'])('does not reinterpret an unverified or deliberately different %s selection',change=>{
 const input=props(),data:any=input.targetNode.data,candidate:any=structuredClone(model);
 if(change==='version')data.capabilityVersion='1';if(change==='schema')data.parameterSchemaVersion='1';if(change==='ref')data.capabilityRef='other';if(change==='mode')data.subType='text-video';if(change==='unavailable')candidate.available=false;if(change==='other-kind')candidate.kind='OMNI_REFERENCE';if(change==='other-model')candidate.model.modelRef='other';if(change==='missing-binding')delete data.capabilityVersion;
 expect(resolveSavedVideoMode(input.targetNode,candidate)).toBeUndefined();
});

it('reopens a saved canonical motion result despite the frozen initial-mode whitelist excluding that mode',()=>{
 const input=props();input.targetNode.data.subType='video-motion-transfer';input.initialSubType=nativeInitialMode(input.targetNode);expect(input.initialSubType).toBe('text-video');const view=nativeModelProps(input);expect(view.initialSubType).toBe('video-motion-transfer');expect(view.targetNode.data.subType).toBe('video-motion-transfer');expect(repair(view)).not.toHaveBeenCalled();expect(input.onNodeDataPatch).not.toHaveBeenCalled();
});
