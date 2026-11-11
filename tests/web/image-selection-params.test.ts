import {frozenPortraitRequest} from './helpers/frozen-portrait-command';
import {it,expect} from 'vitest';
import {generatedImageSelectionProps} from '../../apps/web/src/service/image-selection-params';
import {ModelBindings} from '../../apps/web/src/service/model-bindings';
const fixture=()=>({readonly:false,imageSelection:{showParams:false,showParamsCard:false,showToolbar:true,isRead:false,targetNode:{id:'n',type:'rh-image',data:{modelCode:'codex-image-generate-v1',params:{prompt:'original'},sourceObjects:['rhtv-asset:result'],output:[{assetId:'result'}],historyStorage:{source:'remote',historyId:'execution'}}},onGenerate:()=>{},onNodeDataPatch:()=>{}}});
it.each(['plain','redraw','connected'])('opens the original generated image composer: %s',kind=>{
 const props:any=fixture();if(kind==='redraw')Object.assign(props.imageSelection.targetNode.data,{modelCode:'codex-image-edit-v1',toolsType:'image-redraw'});if(kind==='connected')props.initialEdges=[{source:'a',target:'n'}];
 const result=generatedImageSelectionProps(props,{selectedNodeIds:['n']});expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode).toBe(props.imageSelection.targetNode);expect(result.imageSelection.onGenerate).toBe(props.imageSelection.onGenerate);expect(props.imageSelection.showParams).toBe(false);
});
it.each(['flux1-dev-generate-v1','flux2-klein-9b-generate-v1','qwen-image-edit-2511-v1','z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('reopens a durable %s owner with its exact saved profile binding',ref=>{
 const props:any=fixture(),data=props.imageSelection.targetNode.data;
 Object.assign(data,{modelCode:ref,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{outputPreset:'1024-square',count:4}});
 const before=structuredClone(data),result=generatedImageSelectionProps(props,{selectedNodeIds:['n']});
 expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode).toBe(props.imageSelection.targetNode);expect(data).toEqual(before);
 // Independent siblings expose the normal image tools, not the owner's
 // generation command/count or a duplicated retry of the original batch.
 data.isUpload=true;data.batchOrigin={taskId:'batch',sourceNodeId:'owner'};
 expect(generatedImageSelectionProps(props,{selectedNodeIds:['n']})).toBe(props);
});
it.each(['missing-ref','mismatched-ref','missing-version','new-version','wrong-schema','upscaler'])('keeps an unsupported Comfy saved binding outside the composer: %s',reason=>{
 const props:any=fixture(),data=props.imageSelection.targetNode.data;
 Object.assign(data,{modelCode:'z-image-turbo-generate-v1',capabilityRef:'z-image-turbo-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 if(reason==='missing-ref')delete data.capabilityRef;
 if(reason==='mismatched-ref')data.modelCode='flux2-klein4b-generate-v1';
 if(reason==='missing-version')delete data.capabilityVersion;
 if(reason==='new-version')data.capabilityVersion='2';
 if(reason==='wrong-schema')data.parameterSchemaVersion='2';
 if(reason==='upscaler')data.modelCode=data.capabilityRef='seedvr2-image-enhance-v1';
 expect(generatedImageSelectionProps(props,{selectedNodeIds:['n']})).toBe(props);
});
it.each(['readonly','selection-readonly','toolbar-hidden','other-node','multi-select','drag','box','upload','reference','promptless','other-model','no-history','no-result','special-card'])('preserves native exclusion: %s',reason=>{
 const props:any=fixture(),s=props.imageSelection,d=s.targetNode.data,state:any={selectedNodeIds:['n']};
 if(reason==='readonly')props.readonly=true;if(reason==='selection-readonly')s.isRead=true;if(reason==='toolbar-hidden')s.showToolbar=false;if(reason==='other-node')state.selectedNodeIds=['other'];if(reason==='multi-select')state.selectedNodeIds=['n','other'];if(reason==='drag')state.isNodeDragging=true;if(reason==='box')state.isSelectionDragging=true;if(reason==='upload')d.isUpload=true;if(reason==='reference')d.isPoseControlReference=true;if(reason==='promptless')d.params.prompt='';if(reason==='other-model')d.modelCode='unknown';if(reason==='no-history')delete d.historyStorage;if(reason==='no-result')d.output=[];if(reason==='special-card')s.showParamsCard=true;
 expect(generatedImageSelectionProps(props,state)).toBe(props);
});
it.each(['flux1-dev-generate-v1','flux2-klein-9b-generate-v1','qwen-image-edit-2511-v1','z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('restores the exact private %s binding before testing a serialized generated selection',ref=>{
 // Actual post-GROUP home/Agent Z evidence: native D1n/wct omits these three
 // version fields while modelCode, authored prompt, output and remote history
 // survive (generated-z-reopen-composer-evidence.json). Restore only the view.
 const props:any=fixture(),node=props.imageSelection.targetNode;
 Object.assign(node.data,{modelCode:ref,subType:'text-image',status:'finished',generateNum:1});
 const bindings=new ModelBindings(),saved={...node,data:{...node.data,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1'}};
 bindings.seed('project',{nodes:[saved],edges:[]});
 const before=structuredClone(node),port={node:(n:any)=>bindings.node('project',n),record:()=>{throw Error('render must not record')},current:()=>true};
 const result=generatedImageSelectionProps(props,{selectedNodeIds:['n']},port);
 expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode).not.toBe(node);
 expect(result.imageSelection.targetNode.data).toMatchObject({modelCode:ref,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1'});
 expect(result.imageSelection.targetNode.data.params).toBe(node.data.params);expect(result.imageSelection.targetNode.data.output).toBe(node.data.output);
 expect(result.imageSelection.onGenerate).toBe(props.imageSelection.onGenerate);expect(result.imageSelection.onNodeDataPatch).toBe(props.imageSelection.onNodeDataPatch);
 expect(node).toEqual(before);expect(props.imageSelection.showParams).toBe(false);
});
it.each(['stale project','missing sidecar','wrong model','wrong type','incomplete schema','explicit newer binding','batch sibling','unowned task','empty result','readonly'])('does not invent editable binding or override the native gate: %s',reason=>{
 const props:any=fixture(),node=props.imageSelection.targetNode;
 Object.assign(node.data,{modelCode:'z-image-turbo-generate-v1'});
 const saved={...node,type:reason==='wrong type'?'rh-video':node.type,data:{...node.data,modelCode:reason==='wrong model'?'flux1-dev-generate-v1':node.data.modelCode,capabilityRef:reason==='wrong model'?'flux1-dev-generate-v1':node.data.modelCode,capabilityVersion:'1',...(reason==='incomplete schema'?{}:{parameterSchemaVersion:'1'})}};
 const bindings=new ModelBindings();bindings.seed('project',{nodes:reason==='missing sidecar'?[]:[saved],edges:[]});
 if(reason==='explicit newer binding')Object.assign(node.data,{capabilityRef:node.data.modelCode,capabilityVersion:'2',parameterSchemaVersion:'2'});
 if(reason==='batch sibling')Object.assign(node.data,{isUpload:true,batchOrigin:{sourceNodeId:'owner',taskId:'batch'}});
 if(reason==='unowned task'){delete node.data.historyStorage;node.data.taskId='unverified-task';}
 if(reason==='empty result')node.data.output=[];
 if(reason==='readonly')props.readonly=true;
 const before=structuredClone(node),port={node:(n:any)=>bindings.node('project',n),record:()=>{throw Error('render must not record')},current:()=>reason!=='stale project'};
 expect(generatedImageSelectionProps(props,{selectedNodeIds:['n']},port)).toBe(props);expect(node).toEqual(before);
});

it.each(['codex-image-generate-v1','codex-image-edit-v1','qwen-image-edit-2511-v1'])('reopens a saved %s copy without restoring old task/history or using its output as input',ref=>{
 const props:any=fixture(),node=props.imageSelection.targetNode,bindings=new ModelBindings(),version=ref.startsWith('codex')?'3':'1';
 delete node.data.historyStorage;Object.assign(node.data,{modelCode:ref,subType:ref==='codex-image-generate-v1'?'text-image':'image-image',status:'idle'});
 bindings.seed('project',{nodes:[{...node,data:{...node.data,capabilityRef:ref,capabilityVersion:version,parameterSchemaVersion:version}}],edges:[]});
 const before=structuredClone(node),port={node:(n:any)=>bindings.node('project',n),record:()=>{throw Error('render must not save')},current:()=>true},result=generatedImageSelectionProps(props,{selectedNodeIds:['n']},port);
 expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode.data).toMatchObject({capabilityRef:ref,capabilityVersion:version,params:before.data.params,output:before.data.output,sourceObjects:before.data.sourceObjects});
 expect(result.imageSelection.targetNode.data.taskId).toBeUndefined();expect(result.imageSelection.targetNode.data.historyStorage).toBeUndefined();expect(node).toEqual(before);
 expect(generatedImageSelectionProps(props,{selectedNodeIds:['n'],localRunningNodeIds:['n']},port)).toBe(props);
});
it('keeps a historical Codex version in the restored selection instead of borrowing the latest catalog version',()=>{
 const props:any=fixture(),node=props.imageSelection.targetNode,bindings=new ModelBindings();
 bindings.seed('project',{nodes:[{...node,data:{...node.data,capabilityRef:node.data.modelCode,capabilityVersion:'1',parameterSchemaVersion:'1'}}],edges:[]});
 props.models={'text-image':[{capabilityRef:node.data.modelCode,modelCode:node.data.modelCode,capabilityVersion:'3',parameterSchemaVersion:'3',available:true}]};
 const result=generatedImageSelectionProps(props,{selectedNodeIds:['n']},{node:n=>bindings.node('project',n),record:()=>{throw Error('no render write')},current:()=>true});
 expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode.data.capabilityVersion).toBe('1');expect(result.imageSelection.targetNode.data.parameterSchemaVersion).toBe('1');expect(result.models).toBe(props.models);expect(node.data).not.toHaveProperty('capabilityVersion');
});


it('keeps the original composer accessible when a newly created face result has no pixels after its first refusal',async()=>{
 const {owner}=await frozenPortraitRequest('face','emotion','studio-portrait-881-v1');
 const props=fixture(),state={selectedNodeIds:[owner.id],localRunningNodeIds:[] as string[]};
 const selection={...props.imageSelection,targetNode:owner,showToolbar:false};
 const mounted={...props,imageSelection:selection};
 expect(owner.data.status).toBe('idle');expect(owner.data.output).toBeUndefined();
 expect(generatedImageSelectionProps(mounted,state).imageSelection).toMatchObject({showParams:true,showToolbar:false,onGenerate:selection.onGenerate});
 expect(generatedImageSelectionProps(mounted,{...state,localRunningNodeIds:[owner.id]})).toBe(mounted);
 owner.data.status='processing';
 expect(generatedImageSelectionProps(mounted,state)).toBe(mounted);
 owner.data.status='failed';
 expect(generatedImageSelectionProps(mounted,state).imageSelection.showParams).toBe(true);
 expect(generatedImageSelectionProps({...mounted,readonly:true},state).imageSelection.showParams).toBe(false);
});
