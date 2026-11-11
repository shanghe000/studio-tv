import {afterEach,expect,it,vi} from 'vitest';
import {nativeModelProps,installNativeModelProjection} from '../../apps/web/src/service/model-selectors';
import {capabilityModel} from '../../apps/web/src/service/execution';
import {modelSelections,type Capability} from '../../apps/web/src/service/model-catalog';
import {ModelBindings} from '../../apps/web/src/service/model-bindings';

const profile=(version:string,kind='LLM'):Capability=>({capabilityRef:`model-${version}-${kind}`,version:'1',kind,available:true,testMode:false,inputKinds:kind==='LLM'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],model:{providerRef:'supplier',modelRef:'m-'+version,title:'Model '+version,version}});
afterEach(()=>{modelSelections.clear();vi.unstubAllGlobals();});
const modelRows=()=>['5.6','6','6.1'].map(version=>capabilityModel(profile(version))).concat(['6','6.1'].map(version=>capabilityModel(profile(version,'IMAGE_UNDERSTANDING'))));
it('projects actual text or image inputs before native model-name deduplication, preserving original callbacks and params',()=>{
 const rows=modelRows(),models={'multimodal-text':rows,'text-text':rows.filter(model=>model.kind==='LLM')},node={id:'text',type:'rh-text',data:{params:{prompt:'<role>original USER template</role>',imageUrls:['rhtv-asset:owned']}}},props={targetNode:node,nodes:[node],edges:[],models,onNodeDataPatch:vi.fn()};const image=nativeModelProps(props);
 expect(image.models['multimodal-text'].map((model:any)=>model.kind)).toEqual(['IMAGE_UNDERSTANDING','IMAGE_UNDERSTANDING']);expect(image.models['multimodal-text'].map((model:any)=>model.model.version)).toEqual(['6','6.1']);expect(image.models['text-text']).toEqual([]);expect(image.targetNode).toBe(node);const patch={modelCode:image.models['multimodal-text'][0].modelCode,params:{prompt:'original user preset'}};image.onNodeDataPatch('text',patch);expect(props.onNodeDataPatch).toHaveBeenCalledWith('text',{...patch,capabilityRef:patch.modelCode,capabilityVersion:'1',parameterSchemaVersion:undefined});expect(patch).not.toHaveProperty('capabilityRef');expect(nativeModelProps(props).models).toBe(image.models);
 const text=nativeModelProps({...props,targetNode:{...node,data:{params:{prompt:'text'}}}});expect(text.models['multimodal-text'].map((model:any)=>model.model.version)).toEqual(['5.6','6','6.1']);expect(props.models['multimodal-text']).toHaveLength(5);expect(node.data.params.prompt).toBe('<role>original USER template</role>');
});
it('uses incoming image edges or references and excludes unsupported VIDEO instead of displaying a fake Codex model',()=>{
 const node={id:'t',type:'rh-text',data:{}},source={id:'img',type:'rh-image',data:{}},models={'multimodal-text':modelRows()},props={targetNode:node,nodes:[node,source],edges:[{source:'img',target:'t'}],models};expect(nativeModelProps(props).models['multimodal-text'].every((model:any)=>model.kind==='IMAGE_UNDERSTANDING')).toBe(true);
 expect(nativeModelProps({...props,edges:[],references:[{kind:'IMAGE'}]}).models['multimodal-text']).toHaveLength(2);expect(nativeModelProps({...props,nodes:[node,{id:'img',type:'rh-entity',data:{imageUrl:'rhtv-asset:rendered'}}]}).models['multimodal-text']).toHaveLength(2);expect(nativeModelProps({...props,nodes:[node,{id:'img',type:'rh-entity',data:{}}]}).models['multimodal-text']).toHaveLength(3);expect(nativeModelProps({...props,nodes:[node,{id:'img',type:'rh-3d',data:{output:[{type:'ASSET',mimeType:'image/png',assetId:'rendered-screenshot'}]}}]}).models['multimodal-text']).toHaveLength(2);expect(nativeModelProps({...props,nodes:[node,{...source,type:'rh-video'}]}).models['multimodal-text']).toEqual([]);
});
it('projects native JSX model props and restores only its own wrappers without changing media widgets',()=>{
 const jsx=vi.fn((type,props)=>({type,props})),jsxs=vi.fn((type,props)=>({type,props})),native={j:{jsx,jsxs}},dispose=installNativeModelProjection(native),props={targetNode:{id:'n',type:'rh-text',data:{}},nodes:[],edges:[],models:{'multimodal-text':modelRows()}},component=()=>null;
 expect(native.j.jsx(component,props).props.models['multimodal-text']).toHaveLength(3);const media={...props,targetNode:{id:'n',type:'rh-image',data:{}}};expect(native.j.jsxs(component,media).props).toBe(media);dispose();expect(native.j.jsx).toBe(jsx);expect(native.j.jsxs).toBe(jsxs);
});
it.each(['jsx','jsxs'] as const)('restores a post-writeback inner image selection before the editable gate through %s without changing catalog or native data',name=>{
 const node={id:'z-owner',type:'rh-image',data:{modelCode:'z-image-turbo-generate-v1',subType:'text-image',status:'finished',params:{prompt:'independent original authored prompt',outputPreset:'1024-square'},sourceObjects:['rhtv-asset:result'],output:[{assetId:'result'}],historyStorage:{source:'remote',historyId:'actual-execution'}}};
 const bindings=new ModelBindings();bindings.seed('project',{nodes:[{...node,data:{...node.data,capabilityRef:node.data.modelCode,capabilityVersion:'1',parameterSchemaVersion:'1'}}],edges:[]});
 const port={node:(n:any)=>bindings.node('project',n),record:vi.fn(),current:()=>true},bindingPort=vi.fn(()=>port);
 const jsx=vi.fn((type,props)=>({type,props})),native={j:{jsx,jsxs:jsx},c5:{getState:()=>({selectedNodeIds:[node.id]})}},dispose=installNativeModelProjection(native,bindingPort);
 const onGenerate=vi.fn(),onNodeDataPatch=vi.fn(),models={'text-image':[{modelCode:node.data.modelCode,capabilityRef:node.data.modelCode,capabilityVersion:'1',parameterSchemaVersion:'1',available:false}]},props={readonly:false,models,imageSelection:{showParams:false,showParamsCard:false,showToolbar:true,isRead:false,targetNode:node,onGenerate,onNodeDataPatch}},before=structuredClone(node);
 const component=()=>null,result=native.j[name](component,props).props;
 expect(result.imageSelection.showParams).toBe(true);expect(result.imageSelection.targetNode.data.capabilityVersion).toBe('1');
 expect(result.models).toBe(models);expect(result.models['text-image'][0].available).toBe(false);expect(bindingPort).toHaveBeenCalledTimes(1);
 expect(result.imageSelection.onGenerate).toBe(onGenerate);expect(result.imageSelection.onNodeDataPatch).toBe(onNodeDataPatch);
 expect(node).toEqual(before);expect(port.record).not.toHaveBeenCalled();expect(onGenerate).not.toHaveBeenCalled();expect(onNodeDataPatch).not.toHaveBeenCalled();
 dispose();expect(native.j.jsx).toBe(jsx);expect(native.j.jsxs).toBe(jsx);
});

it('greys incompatible image model choices with a precise reason while preserving the saved choice and catalog',()=>{
 const raw:any={capabilityRef:'image-model',version:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'supplier',modelRef:'image',title:'Image editor',version:'1'},parameterSchema:{properties:{},'x-media-limits':{IMAGE:1}}},row=capabilityModel(raw),source={id:'video',type:'rh-video',data:{videoUrl:'rhtv-asset:v'}},node={id:'target',type:'rh-image',data:{modelCode:row.modelCode,params:{prompt:'Keep my text'}}},patch=vi.fn(),props={targetNode:node,nodes:[source,node],edges:[{source:source.id,target:node.id}],models:{'image-image':[row]},onNodeDataPatch:patch},before=structuredClone(node);
 const result=nativeModelProps(props),projected=result.models['image-image'][0];expect(projected.disabled).toBe(true);expect(projected.reason).toContain('视频');expect(projected.available).toBe(true);expect(node).toEqual(before);expect(row.disabled).toBe(false);expect(props.models['image-image']).toHaveLength(1);
});
it('greys an image model when the actual number of references exceeds its native control capacity',()=>{
 const row:any={modelCode:'image-model',capabilityRef:'image-model',available:true,kind:'IMAGE_TO_IMAGE',model:{providerRef:'supplier',modelRef:'image'},inputKinds:['TEXT','IMAGE'],config:[{type:'imageUrls',paramName:'imageUrls',maxNum:1}]},node={id:'target',type:'rh-image',data:{params:{imageUrls:['rhtv-asset:a','rhtv-asset:b']}}},result=nativeModelProps({targetNode:node,nodes:[node],edges:[],models:{'image-image':[row]}});
 expect(result.models['image-image'][0]).toMatchObject({disabled:true});expect(result.models['image-image'][0].description).toContain('最多支持 1 项图片');
});
it('keeps an incomplete image edit model selectable and explains which material to add',()=>{
 const row:any={modelCode:'image-model',capabilityRef:'image-model',available:true,kind:'IMAGE_TO_IMAGE',model:{providerRef:'supplier',modelRef:'image'},inputKinds:['TEXT','IMAGE'],config:[{type:'imageUrls',paramName:'imageUrls',maxNum:1}]},node={id:'target',type:'rh-image',data:{params:{prompt:'A fox'}}},result=nativeModelProps({targetNode:node,nodes:[node],edges:[],models:{'image-image':[row]}});
 expect(result.models['image-image'][0].disabled).not.toBe(true);expect(result.models['image-image'][0].description).toContain('先选择模型再添加素材');
});

it('does not infer missing-image hints from an incomplete toolbar graph or clone unchanged model catalogs',()=>{
 const row:any={modelCode:'image-model',capabilityRef:'image-model',available:true,kind:'IMAGE_TO_IMAGE',model:{providerRef:'supplier',modelRef:'image'},inputKinds:['TEXT','IMAGE'],config:[{type:'imageUrls',paramName:'referenceImages'}]},node={id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:owned'],params:{prompt:'Original prompt'}}},models={'image-image':[row]},props={targetNode:node,nodes:[],edges:[],models,onNodeDataPatch:vi.fn()},result=nativeModelProps(props);
 expect(result.models).toBe(models);expect(result.targetNode).toBe(node);result.onNodeDataPatch('source',{text:'Ordinary edit'});expect(props.onNodeDataPatch).toHaveBeenCalledWith('source',{text:'Ordinary edit'});
});
