import {expect,it,vi} from 'vitest';
import {nativeModelProps,installNativeModelProjection} from '../../apps/web/src/service/model-selectors';
import {h3PresetVersion,h3PinnedPresetMetadataMatches} from '../../apps/web/src/service/h3-resolution-presets';
import {h3DisplayRatios,h3ParameterTupleMatches,h3ParameterVersions,h3UpgradeValue,h3VersionPresets} from '../../apps/web/src/service/h3-parameter-contracts';

function fixture(){
 const ref='h3-tr-pika-twopass-ref-v1',rows=structuredClone(h3VersionPresets(ref,h3ParameterVersions[ref])!);
 const model:any={modelCode:ref,capabilityRef:ref,capabilityVersion:h3ParameterVersions[ref],parameterSchemaVersion:h3ParameterVersions[ref],available:true,testMode:false,kind:'OMNI_REFERENCE',model:{providerRef:'minimax',modelRef:'h3'},h3OutputPresets:rows,config:[{paramName:'outputPreset',paramValue:'landscape-1920x1088-8s',optionValue:rows.map(row=>({value:row.value,labelCn:row.title}))}]};
 const node:any={id:'video',type:'rh-video',data:{modelCode:ref,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'Keep this authored prompt',outputPreset:'landscape-1920x1088-8s'},aspectRatio:'30:17'}};
 const patch=vi.fn(),port={node:(value:any)=>value,record:vi.fn(),current:()=>true};
 const props:any={targetNode:node,models:{'multimodal-video':[model]},onNodeDataPatch:patch};
 return{ref,model,node,patch,port,props};
}

it('retains exact old and current versions under one model reference',()=>{
 for(const [ref,version]of Object.entries(h3ParameterVersions)){
  expect(h3PresetVersion(ref,version)).toBe(version);
  expect(h3PresetVersion(ref,'1')).toBe('1');
  expect(h3PresetVersion(ref,'unpublished')).toBeUndefined();
  expect(h3VersionPresets(ref,version)!.some(row=>row.width===3360&&row.height===1440)).toBe(true);
  expect(h3VersionPresets(ref,version)!.some(row=>row.value.includes('-1080p-')&&row.width===1088&&row.height===1920)).toBe(true);
  const previous=h3VersionPresets(ref,String(Number(version)-1))!;
  expect(previous.some(row=>row.value.includes('-1080p-'))).toBe(ref==='h3-video-reference-v1');
  const oldVersion=String(Number(version)-1),portrait=previous.find(row=>row.value.startsWith('portrait-2k-'))!;
  expect(h3ParameterTupleMatches(ref,oldVersion,portrait)).toBe(true);
  expect(h3ParameterTupleMatches(ref,'99',portrait)).toBe(false);
  expect(h3ParameterTupleMatches(ref,oldVersion,{...portrait,width:portrait.width+32})).toBe(false);
  expect(h3DisplayRatios(ref,oldVersion,portrait)).toContain('16:9');
 }
 expect(h3VersionPresets('h3-drama-reference-v1','1')!.find(row=>row.value==='portrait-768p-10s')!.height).toBe(1376);
 expect(h3VersionPresets('h3-drama-reference-v1','2')!.find(row=>row.value==='portrait-768p-10s')!.height).toBe(1344);
});

it('keeps an old node unchanged until a new-parameter option is explicitly chosen',()=>{
 const f=fixture(),before=structuredClone(f.node),view=nativeModelProps(f.props,f.port);
 expect(f.node).toEqual(before);expect(f.patch).not.toHaveBeenCalled();expect(f.port.record).not.toHaveBeenCalled();
 expect(view.models['multimodal-video'][0].capabilityVersion).toBe('1');
 const metadata=view.models['multimodal-video'][0].config[0].studioH3ParameterMetadata;
 expect(metadata).toEqual({capabilityRef:f.ref,version:'1',presets:h3VersionPresets(f.ref,'1')});
 expect(metadata.presets).not.toBe(h3VersionPresets(f.ref,'1'));
 const options=view.models['multimodal-video'][0].config[0].optionValue;
 expect(options.some((row:any)=>row.value==='landscape-1920x1088-8s')).toBe(true);
 const alias=h3UpgradeValue(f.ref,'portrait-2k-8s');expect(options.some((row:any)=>row.value===alias)).toBe(true);
 view.onNodeDataPatch('video',{modelCode:f.ref,params:{prompt:'Keep this authored prompt',outputPreset:alias,aspectRatio:'16:9'}});
 expect(f.patch).toHaveBeenCalledWith('video',expect.objectContaining({capabilityRef:f.ref,capabilityVersion:h3ParameterVersions[f.ref],parameterSchemaVersion:h3ParameterVersions[f.ref],aspectRatio:'9:16',params:{prompt:'Keep this authored prompt',outputPreset:'portrait-2k-8s',aspectRatio:'9:16'}}));
 expect(JSON.stringify(f.patch.mock.calls[0])).not.toContain('__h3_upgrade_');expect(f.port.record).toHaveBeenCalledOnce();expect(f.node).toEqual(before);
});

it('does not upgrade on a prompt edit or accept an unknown upgrade alias',()=>{
 const f=fixture(),view=nativeModelProps(f.props,f.port),edit={params:{prompt:'Edited only'}};
 view.onNodeDataPatch('video',edit);expect(f.patch).toHaveBeenCalledWith('video',edit);expect(f.port.record).not.toHaveBeenCalled();
 f.patch.mockClear();view.onNodeDataPatch('video',{params:{outputPreset:'__h3_upgrade_99__future'}});expect(f.patch).not.toHaveBeenCalled();
});

it('does not treat a changed tuple at the same version as an advertised contract',()=>{
 const f=fixture();expect(h3PinnedPresetMetadataMatches(f.model)).toBe(true);f.model.h3OutputPresets[0].width+=32;expect(h3PinnedPresetMetadataMatches(f.model)).toBe(false);
 const view=nativeModelProps(f.props,f.port);view.onNodeDataPatch('video',{params:{outputPreset:h3UpgradeValue(f.ref,'portrait-2k-8s')}});expect(f.port.record).not.toHaveBeenCalled();
});


it('refreshes only after the upgraded catalog and canonical node have reached the mounted form',()=>{
 const f=fixture(),refresh=vi.fn(),record=vi.fn(),port={...f.port,record},effects:Function[]=[];
 const jsx=(type:any,props:any)=>({type,props}),react={useState:()=>[0,vi.fn()],useEffect:(effect:Function)=>effects.push(effect),createElement:jsx},native={j:{jsx,jsxs:jsx},r:react,cw:refresh};
 const release=installNativeModelProjection(native,()=>port),props={...f.props,visible:true,references:[],videoModelGroups:[]};
 const composer=native.j.jsx(()=>null,props).type;
 const commit=()=>{for(const effect of effects.splice(0))effect();};
 try{
  const view=composer(props).props;commit();
  view.onNodeDataPatch('video',{modelCode:f.ref,params:{prompt:'Keep my latest prompt',outputPreset:h3UpgradeValue(f.ref,'portrait-2k-8s')}});
  const canonical=f.patch.mock.calls[0][1];
  expect(refresh).not.toHaveBeenCalled();
  composer(props);commit();expect(refresh).not.toHaveBeenCalled();
  const updated={...props,targetNode:{...f.node,data:{...f.node.data,...canonical}}};
  composer(updated);expect(refresh).not.toHaveBeenCalled();commit();
  expect(refresh).toHaveBeenCalledExactlyOnceWith('video',updated.targetNode.data);
  expect(refresh.mock.invocationCallOrder[0]).toBeGreaterThan(record.mock.invocationCallOrder[0]);
  expect(canonical.params).toMatchObject({prompt:'Keep my latest prompt',outputPreset:'portrait-2k-8s'});
  expect(JSON.stringify(refresh.mock.calls)).not.toContain('__h3_upgrade_');
  composer(updated);commit();expect(refresh).toHaveBeenCalledOnce();
  expect(f.props.targetNode).toBe(f.node);
 }finally{release();}
});

it.each(['refused','async','revoked'])('does not refresh native parameters for a %s upgrade',mode=>{
 const f=fixture(),refresh=vi.fn(),port={...f.port,current:()=>mode!=='revoked',refreshParameters:refresh};
 if(mode==='refused')f.patch.mockReturnValue(false);
 if(mode==='async')f.patch.mockReturnValue(Promise.resolve());
 const view=nativeModelProps(f.props,port);
 view.onNodeDataPatch('video',{params:{outputPreset:h3UpgradeValue(f.ref,'portrait-2k-8s')}});
 expect(refresh).not.toHaveBeenCalled();
});
