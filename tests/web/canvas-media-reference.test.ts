import {expect,it} from 'vitest';
import {canvasSourceMediaReferences} from '../../apps/web/src/service/canvas-media-reference';
import {inspectCanvasConnection,nodeReadinessMaterials} from '../../apps/web/src/service/connection-readiness';
import {projectNativeVideoInputs} from '../../apps/web/src/service/video-command';
const image=(id:string,data:any={}):any=>({id,type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:'+id],...data}});
const cap:any={capabilityRef:'image-edit',version:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,inputKinds:['TEXT','IMAGE'],parameterSchema:{'x-media-limits':{IMAGE:2}}};
it.each(['rh-image','rh-video'])('counts style after the actual imageOrder projection on %s targets',type=>{
 const target:any={id:'target',type,position:{x:500,y:0},data:{modelCode:cap.capabilityRef,imageOrder:['second','first'],presetSelections:[{key:'styleLibrary',referenceImageUrl:'rhtv-asset:first'}]}};
 const graph:any={nodes:[image('first'),image('second'),target],edges:[{id:'first-edge',source:'first',target:'target'}]};
 expect(inspectCanvasConnection({source:'second',target:'target'},graph,[cap])).toMatchObject({allowed:true});
 graph.edges.push({id:'second-edge',source:'second',target:'target'});expect(nodeReadinessMaterials(target,graph)).toHaveLength(2);
 target.data.imageOrder=['first','second'];expect(nodeReadinessMaterials(target,graph)).toHaveLength(3);
});
it('compares a registered style URL in canonical asset form after native object ordering',()=>{
 const target:any={id:'target',type:'rh-image',position:{x:0,y:0},data:{imageOrder:[{nodeId:'second',url:'rhtv-asset:second'},{nodeId:'first',url:'rhtv-asset:first'}],presetSelections:[{key:'styleLibrary',referenceImageUrl:'https://owned.invalid/first'}]}},graph:any={nodes:[image('first'),image('second'),target],edges:['first','second'].map(source=>({source,target:'target'}))};
 expect(nodeReadinessMaterials(target,graph,value=>value==='https://owned.invalid/first'?'rhtv-asset:first':value)).toHaveLength(2);
});
it.each(['remote','embedded','embedded-output-missing','empty-history-output'] as const)('keeps unresolved %s history pending instead of silently using another output',history=>{
 const source=image('source',{sourceObjects:['rhtv-asset:old'],output:[{url:'rhtv-asset:old',historyOutputId:'old'}],...(history==='remote'||history==='empty-history-output'?{selectedHistoryOutputId:'unresolved'}:{selectedOutputHistoryId:'unresolved',selectedOutputHistoryIndex:0})});
 if(history==='embedded-output-missing')source.data.nodeOutputHistory=[{id:'unresolved',outputs:[{url:'rhtv-asset:not-displayed'}]}];
 if(history==='empty-history-output')source.data.output.push({assetId:'unknown',historyOutputId:'unresolved'});
 const target:any={id:'target',type:'rh-video',position:{x:500,y:0},data:{modelCode:'h3-first-frame-v1',params:{imageUrls:['rhtv-asset:cached']}}},graph:any={nodes:[source,target],edges:[{id:'edge',source:'source',target:'target'}]};
 expect(canvasSourceMediaReferences(source,'image')).toBeUndefined();expect(nodeReadinessMaterials(target,graph)).toEqual([{kind:'IMAGE',reference:'node:source',sourceNodeId:'source',pending:true}]);
 const projected=projectNativeVideoInputs(target,graph)!;expect(projected.error).toMatch(/图片参考连线或素材尚不可用/);expect(projected.data).toBe(target.data);expect(projected.references.image).toEqual([]);
});
it('retains the native selected embedded result after the output list was reduced to its displayed first entry',()=>{
 const source=image('source',{output:[{url:'rhtv-asset:chosen'}],selectedOutputHistoryId:'batch',selectedOutputHistoryIndex:1,nodeOutputHistory:[{id:'batch',outputs:[{url:'rhtv-asset:old'},{url:'rhtv-asset:chosen'}]}]});
 expect(canvasSourceMediaReferences(source,'image')).toEqual(['rhtv-asset:chosen']);
});
it('includes explicit native sourceVideo and audioUrl contributions while retaining a displayed output',()=>{
 expect(canvasSourceMediaReferences({data:{output:[{url:'rhtv-asset:displayed'}],sourceVideo:'rhtv-asset:motion'}},'video')).toEqual(['rhtv-asset:displayed','rhtv-asset:motion']);
 expect(canvasSourceMediaReferences({data:{output:[{url:'rhtv-asset:displayed'}],audioUrl:'rhtv-asset:voice'}},'audio')).toEqual(['rhtv-asset:displayed','rhtv-asset:voice']);
});
