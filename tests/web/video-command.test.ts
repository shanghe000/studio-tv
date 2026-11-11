import {it,expect} from 'vitest';
import {completeNativeVideoCommand} from '../../apps/web/src/service/video-command';
it('restores only exact native H3 edge projections and original input order',()=>{
 const first={id:'first',type:'rh-image',data:{}},last={id:'last',type:'rh-image',data:{}},target={id:'video',type:'rh-video',data:{modelCode:'h3-first-last-frame-v1'}},base={nodes:[first,last,target],edges:[{id:'a',source:'first',target:'video',sourceHandle:'output',targetHandle:'input'},{id:'b',source:'last',target:'video'}]},command={nodes:[target,first,last],edges:base.edges.map(({source,target})=>({source,target}))};
 expect(completeNativeVideoCommand(command,base,'video')).toEqual(base);
 const stale={...command,edges:[{source:'other',target:'video'},command.edges[1]]};expect(completeNativeVideoCommand(stale,base,'video')).toBe(stale);
 const explicit={...base,edges:base.edges.map(e=>({...e,conditioningRole:'FIRST_FRAME'}))};expect(completeNativeVideoCommand(command,explicit,'video')).toBe(command);
});

import {nativeVideoReferences} from '../../apps/web/src/service/video-command';
it('validates modality-specific references against owned source nodes and saved order',()=>{
 const first={id:'first',type:'rh-image',data:{imageUrl:'rhtv-asset:a',sourceObjects:['rhtv-asset:a']}},last={id:'last',type:'rh-image',data:{imageUrl:'rhtv-asset:b'}},audio={id:'sound',type:'rh-audio',data:{audioUrl:'rhtv-asset:s'}},target={id:'target',type:'rh-video',data:{imageOrder:['last::rhtv-asset:b','first::rhtv-asset:a'],params:{videoUrls:''}}},graph={nodes:[first,last,audio,target],edges:[first,last,audio].map(n=>({source:n.id,target:'target'}))};
 expect(nativeVideoReferences(target,graph,'image')).toEqual(['rhtv-asset:b','rhtv-asset:a']);expect(nativeVideoReferences(target,graph,'audio')).toEqual(['rhtv-asset:s']);expect(nativeVideoReferences(target,graph,'video')).toEqual([]);last.data.imageUrl='https://unowned.invalid/image';expect(nativeVideoReferences(target,graph,'image')).toBeUndefined();
});

import {restoreSavedVideoSourceMetadata} from '../../apps/web/src/service/video-command';
import {canvasMediaInputProjection} from '../../apps/web/src/service/video-command';
it('restores omitted generated video metadata only for the identical durable result',()=>{
 const source={id:'source',type:'rh-video',data:{modelCode:'h3-first-frame-v1',capabilityRef:'h3-first-frame-v1',capabilityVersion:'1',parameterSchemaVersion:'1',historyStorage:{historyId:'exe'},videoUrl:'rhtv-asset:owned'}},target={id:'target',type:'rh-video',data:{}},command={nodes:[source,target],edges:[]},saved=structuredClone(command);
 Object.assign(saved.nodes[0].data,{routerParameters:{outputPreset:'480p-landscape-5s'},userPromptSnapshot:{paramName:'prompt',value:'ball'}});
 expect(restoreSavedVideoSourceMetadata(command,saved,'target').nodes[0].data).toEqual(saved.nodes[0].data);
 for(const patch of [{videoUrl:'rhtv-asset:other'},{capabilityVersion:'2'},{historyStorage:{historyId:'new'}},{routerParameters:{outputPreset:'other'}}]){
  const edited=structuredClone(command);Object.assign(edited.nodes[0].data,patch);const restored=restoreSavedVideoSourceMetadata(edited,saved,'target');
  for(const [k,v]of Object.entries(patch))expect((restored.nodes[0].data as any)[k]).toEqual(v);
  if(!('routerParameters'in patch))expect((restored.nodes[0].data as any).routerParameters).toBeUndefined();
 }
 expect(restoreSavedVideoSourceMetadata(command,saved,'source')).toEqual(command);
});

it.each(['history','output','model'])('does not restore an omitted history cache after changing %s',change=>{
 const baseline:any={nodes:[{id:'n',type:'rh-video',data:{modelCode:'h3-first-frame-v1',nodeOutputHistory:[],historyStorage:{source:'remote',schemaVersion:1,historyId:'old'},output:[{url:'rhtv-asset:old'}]}}],edges:[]},command=structuredClone(baseline);delete command.nodes[0].data.nodeOutputHistory;
 if(change==='history')command.nodes[0].data.historyStorage.historyId='different';if(change==='output')command.nodes[0].data.output[0].url='rhtv-asset:different';if(change==='model')command.nodes[0].data.modelCode='other';
 expect(completeNativeVideoCommand(command,baseline,'n')?.nodes[0].data.nodeOutputHistory).toBeUndefined();
});

it('uses catalog metadata for new H3 profiles without inheriting old outputs or upstream generation references',()=>{
 const target={id:'target',type:'rh-video',data:{capabilityRef:'h3-drama-reference-v1',videoUrl:'rhtv-asset:old'}},source={id:'source',type:'rh-image',data:{imageUrl:'rhtv-asset:current',params:{imageUrls:['rhtv-asset:ancestor']}}},ancestor={id:'ancestor',type:'rh-image',data:{imageUrl:'rhtv-asset:ancestor'}},graph={nodes:[ancestor,source,target],edges:[{source:'ancestor',target:'source'},{source:'source',target:'target'}]},capability:any={capabilityRef:'h3-drama-reference-v1',available:true,testMode:false,kind:'OMNI_REFERENCE',model:{modelRef:'h3'},outputKinds:['VIDEO'],parameterSchema:{'x-video-mode':'OMNI_REFERENCE'}};
 const projected=canvasMediaInputProjection(target,graph,capability);
 expect(projected.nodes.map(node=>node.id)).toEqual(['source','target']);expect(projected.nodes[0].data).toEqual({imageUrl:'rhtv-asset:current'});expect(projected.nodes[1].data.videoUrl).toBeUndefined();
 expect(canvasMediaInputProjection(target,graph,{...capability,model:{modelRef:'other'}})).toBe(graph);
});
