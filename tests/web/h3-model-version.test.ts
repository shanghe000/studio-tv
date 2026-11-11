import {expect,it,vi} from 'vitest';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
const model=(ref:string)=>({modelCode:ref,capabilityRef:ref,capabilityVersion:'2',parameterSchemaVersion:'2',available:true,model:{modelRef:'h3'},config:[{paramName:'outputPreset',paramValue:'480p-landscape-5s',optionValue:[5,10,15].map(n=>({value:`480p-landscape-${n}s`,labelCn:`${n} 秒`}))}]});
it('keeps restored v1 nodes at 5s without changing the saved graph or other current models',()=>{
 const first=model('first'),other=model('other'),patch=vi.fn(),node={id:'node',type:'rh-video',data:{modelCode:'first',capabilityVersion:'1',params:{prompt:'original',outputPreset:'480p-landscape-5s'}}},input={targetNode:node,models:{'start-end-video':[first,other]},videoModelGroups:[{nodeModelList:[{nodeType:'START_END_VIDEO',modelList:[first,other]}]}],onNodeDataPatch:patch};
 const result=nativeModelProps(input);expect(result.targetNode).toBe(node);expect(result.models['start-end-video'][0].capabilityVersion).toBe('1');expect(result.models['start-end-video'][0].config[0].optionValue).toHaveLength(1);expect(result.videoModelGroups[0].nodeModelList[0].modelList[0].config[0].optionValue).toHaveLength(1);expect(first.config[0].optionValue).toHaveLength(3);expect(result.models['start-end-video'][1]).toBe(other);
 result.onNodeDataPatch('node',{params:{prompt:'edited'}});expect(patch).toHaveBeenLastCalledWith('node',{params:{prompt:'edited'}});
 result.onNodeDataPatch('node',{modelCode:'other',params:{outputPreset:'480p-landscape-10s'}});expect(patch).toHaveBeenLastCalledWith('node',{modelCode:'other',params:{outputPreset:'480p-landscape-10s'},capabilityRef:'other',capabilityVersion:'2',parameterSchemaVersion:'2'});
 expect(nativeModelProps(input).models).toBe(result.models);
});
it('keeps all advertised options for new and v2 nodes',()=>{for(const version of [undefined,'2']){const input={targetNode:{type:'rh-video',data:{modelCode:'first',capabilityVersion:version}},models:{'start-end-video':[model('first')]}};expect(nativeModelProps(input)).toBe(input);}});
it.each(['h3-drama-reference-v2','h3-action-reference-v2'])('does not fabricate a historical v1 menu for the new %s contract',ref=>{
 const current=model(ref),input={targetNode:{type:'rh-video',data:{modelCode:ref,capabilityVersion:'1'}},models:{'multimodal-video':[current]}};expect(nativeModelProps(input)).toBe(input);expect(current.capabilityVersion).toBe('2');
});
