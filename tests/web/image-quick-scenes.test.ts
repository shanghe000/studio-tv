import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {nativeImageToolbarProps,nativeQuickSceneAlias,quickSceneCodes} from '../../apps/web/src/service/image-quick-scenes';
import {installNativeModelProjection} from '../../apps/web/src/service/model-selectors';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const row=(patch:any={})=>({modelCode:'image-real-v1',capabilityRef:'image-real-v1',capabilityVersion:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,modelName:'Real Image Model',modelNameEn:'Real Image Model',model:{providerRef:'fixture-provider',modelRef:'image-real',title:'Real Image Model',version:'1'},inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],generateNum:[1],config:[{type:'PROMPT',paramName:'instructions',paramValue:''},{type:'imageUrls',paramName:'referenceImages'}],params:{quality:'high'},...patch});
const props=(models:any={'image-image':[row()]})=>({targetNode:{id:'source',type:'rh-image',data:{text:'original user text',sourceObjects:['rhtv-asset:owned'],params:{prompt:'original prompt'}}},nodes:[],edges:[],models,toolbarContext:{canvasId:'project-owned',canvasName:'Original project',models,applyOptimisticGraphAdd:vi.fn()},onNodeDataPatch:vi.fn(),onGenerate:vi.fn(),references:[]});
const slice=(start:string,end:string,after=0)=>{const a=frozen.indexOf(start,after),b=frozen.indexOf(end,a+start.length);expect(a).toBeGreaterThanOrEqual(0);expect(b).toBeGreaterThan(a);return frozen.slice(a,b);};
const lookup=(models:any)=>{
 const expression=slice('it=d.useMemo(', ',st=d.useMemo(',6216945).slice(3);
 return new Function('t','d','rn','_1t','return ('+expression+')')({models},{useMemo:(callback:Function)=>callback()},{IMAGE_IMAGE:'image-image'},nativeQuickSceneAlias);
};
const openBar=(model:any)=>{
 const expression=slice('Ue=d.useCallback(pt=>',',Ye=d.useCallback(',6216945).slice(3),warning=vi.fn(),active=vi.fn();
 const select=new Function('d','N','it','Ie','o','O','we','return ('+expression+')')({useCallback:(callback:Function)=>callback},vi.fn(),model,{warning},(key:string)=>key,active,vi.fn());
 select({id:'multiCamera9Grid',titleKey:'native title',descKey:'native description'});return{warning,active};
};

it('keeps the exact 45 frozen operations synchronized with Go quickSceneTasks',()=>{
 const native=slice('T7e={','},').match(/:"([^"]+)"/g)!.map(value=>value.slice(2,-1));
 const go=readFileSync(new URL('../../apps/api-go/internal/modules/execution/application/prompt_templates.go',import.meta.url),'utf8'),map=go.slice(go.indexOf('var quickSceneTasks = map[string]string{')).split('\n}')[0],keys=[...map.matchAll(/^\s*"([^"]+)":/gm)].map(match=>'canvas-image-quick-create-'+match[1]);
 expect(quickSceneCodes.size).toBe(45);expect([...quickSceneCodes].sort()).toEqual(native.sort());expect([...quickSceneCodes].sort()).toEqual(keys.sort());expect(quickSceneCodes.has('canvas-image-quick-create-unknown')).toBe(false);
});
it('adds only a private toolbar default view while preserving ordinary menus, data and handlers',()=>{
 const model=row(),otherBucket=[{modelCode:'unsupported-layer'}],models={'image-image':Object.freeze([model]),'text-image':[row({kind:'TEXT_TO_IMAGE'})],'image-layer-decomposition':otherBucket},original=props(Object.freeze(models)),before=JSON.stringify(original.targetNode),mapped=nativeImageToolbarProps(original,'N2r');
 expect(mapped.models).toBe(original.models);expect(mapped.toolbarContext.models).not.toBe(models);expect(mapped.toolbarContext.models['image-image']).toHaveLength(4);
 const alias=mapped.toolbarContext.models['image-image'][1];expect(alias.modelCode).toBe(nativeQuickSceneAlias);expect(alias.capabilityRef).toBe(model.capabilityRef);expect(alias.modelName).toBe(model.modelName);expect(alias.config).toBe(model.config);expect(alias.params).toBe(model.params);
 expect(mapped.toolbarContext.models['image-layer-decomposition']).toBe(otherBucket);expect(mapped.toolbarContext.models['text-image']).toBe(models['text-image']);expect(mapped.targetNode).toBe(original.targetNode);expect(mapped.nodes).toBe(original.nodes);expect(mapped.edges).toBe(original.edges);expect(mapped.onNodeDataPatch).toBe(original.onNodeDataPatch);expect(mapped.onGenerate).toBe(original.onGenerate);expect(mapped.toolbarContext.applyOptimisticGraphAdd).toBe(original.toolbarContext.applyOptimisticGraphAdd);expect(JSON.stringify(original.targetNode)).toBe(before);expect(original.models['image-image'].some(model=>model.modelCode===nativeQuickSceneAlias)).toBe(false);
 expect(nativeImageToolbarProps(original,'N2r').toolbarContext).toBe(mapped.toolbarContext);expect(nativeImageToolbarProps(original,'skr').toolbarContext).toBe(mapped.toolbarContext);
});
it('supports uppercase IMAGE_IMAGE input without making it a public catalog alias',()=>{
 const original=props({IMAGE_IMAGE:[row()]}),mapped=nativeImageToolbarProps(original,'skr');
 expect(lookup(mapped.toolbarContext.models)?.capabilityRef).toBe('image-real-v1');expect(mapped.toolbarContext.models.IMAGE_IMAGE.slice(1)).toEqual(mapped.toolbarContext.models['image-image']);expect(original.models).not.toHaveProperty('image-image');expect(mapped.models).toBe(original.models);
});
it.each([
 ['normal params component','P1t',{}],['home composer','X9n',{}],['toolbar child','hEt',{}],['wrong case','n2r',{}],
 ['video target','N2r',{targetNode:{type:'rh-video'}}],['missing target','N2r',{targetNode:null}],['missing graph','N2r',{nodes:null}],['missing context','N2r',{toolbarContext:null}],['missing project','N2r',{toolbarContext:{models:{'image-image':[row()]}}}],
])('does not project %s',(_label,name,patch)=>{const original={...props(),...patch};expect(nativeImageToolbarProps(original,name)).toBe(original);});
it.each([
 ['unavailable',{available:false}],['test model',{testMode:true}],['missing test flag',{testMode:undefined}],['text image',{kind:'TEXT_TO_IMAGE'}],['cutout',{kind:'IMAGE_CUTOUT'}],['layer',{kind:'IMAGE_LAYER_DECOMPOSITION'}],['enhance',{kind:'IMAGE_ENHANCE'}],['missing actual IMAGE',{inputKinds:['TEXT']}],['wrong output',{outputKinds:['TEXT']}],['missing descriptor',{model:undefined}],['empty descriptor',{model:{}}],['legacy code',{modelCode:'old-vendor-code'}],['missing ref',{capabilityRef:undefined}],
])('rejects %s as a compatibility default',(_label,patch)=>{const original=props({'image-image':[row(patch)]});expect(nativeImageToolbarProps(original,'N2r')).toBe(original);});
it('does not source defaults from unsupported buckets or invent candidates',()=>{
 for(const models of [{},{'image-image':[]},{'image-cutout':[row()]},{'image-layer-decomposition':[row()]},{'image-enhance':[row()]},{'text-image':[row()]}]){const original=props(models);expect(nativeImageToolbarProps(original,'skr')).toBe(original);}
});
it('limits quick-scene aliases to exact native toolbars while preserving ordinary model binding and restoring JSX wrappers',()=>{
 const jsx=vi.fn((type:any,value:any)=>({type,props:value})),jsxs=vi.fn((type:any,value:any)=>({type,props:value})),native={j:{jsx,jsxs}},dispose=installNativeModelProjection(native),original=props();
 function N2r(){}function skr(){}function P1t(){}
 try{expect(lookup(native.j.jsx(N2r,original).props.toolbarContext.models)).toBeTruthy();expect(lookup(native.j.jsxs(skr,original).props.toolbarContext.models)).toBeTruthy();const ordinary=native.j.jsx(P1t,original).props;expect(ordinary.toolbarContext).toBe(original.toolbarContext);expect(ordinary.models).toBe(original.models);expect(lookup(ordinary.toolbarContext.models)).toBeNull();expect(ordinary.targetNode).toBe(original.targetNode);expect(ordinary.onGenerate).toBe(original.onGenerate);const patch={text:'ordinary user edit'};ordinary.onNodeDataPatch('source',patch);expect(original.onNodeDataPatch).toHaveBeenCalledWith('source',patch);expect(native.j.jsx('div',original).props).toBe(original);}finally{dispose();}
 expect(native.j.jsx).toBe(jsx);expect(native.j.jsxs).toBe(jsxs);
});
it('executes frozen it lookup and Ue opening guard with real config, without changing selectable models',()=>{
 const original=props(),missing=openBar(lookup(original.toolbarContext.models));expect(missing.warning).toHaveBeenCalledOnce();expect(missing.active).not.toHaveBeenCalled();
 const mapped=nativeImageToolbarProps(original,'N2r'),selected=lookup(mapped.toolbarContext.models),opened=openBar(selected);expect(selected.config).toBe(original.models['image-image'][0].config);expect(opened.warning).not.toHaveBeenCalled();expect(opened.active).toHaveBeenCalledWith({id:'multiCamera9Grid',titleKey:'native title',descKey:'native description'});
 const layerRead=slice('function DCt(', 'function LCr(');const menu=runInNewContext(layerRead+';DCt(models)',{models:mapped.toolbarContext.models});expect(menu).toEqual([]);expect(lookup(mapped.models)).toBeNull();
 const recognition=runInNewContext(slice('function NCr(','function MCr(')+';NCr(models)',{models:mapped.toolbarContext.models,XUe:'native-split-default'});expect(recognition).toBeNull();
 const exact=runInNewContext(slice('function xTe(','const wEr=')+';xTe',{rn:{IMAGE_IMAGE:'image-image'}});expect(exact(mapped.toolbarContext.models,'seedream-v5-pro-image-to-image')?.capabilityRef).toBe('image-real-v1');expect(exact(mapped.toolbarContext.models,'image-image-rhart-image-n-g31-flash-official')?.capabilityRef).toBe('image-real-v1');
});
it('runs the frozen LEr and uEt builders with a real IMAGE field and exact quick scene, without a provider',async()=>{
 const original=props(),mapped=nativeImageToolbarProps(original,'skr');let submitted:any;
 const functions=[slice('function GF(','function jd('),slice('function fEt(','function xEr('),slice('function xTe(','const wEr='),slice('async function uEt(','async function o_('),slice('async function LEr(','async function DEr(')].join('\n');
 const run=runInNewContext(functions+';LEr',{
  rn:{IMAGE_IMAGE:'image-image'},_t:{PROMPT:'PROMPT',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'},_1t:nativeQuickSceneAlias,nv:(model:any,type:string)=>model.config.find((field:any)=>field.type===type)?.paramName,
  Ie:{warning:vi.fn(),error:vi.fn()},pEt:()=>0,jd:()=> 'quick-generated',dEt:()=>({x:10,y:20}),sn:{t:(key:string)=>key},mS:()=>({width:380,height:280}),qp:vi.fn(),$f:vi.fn(),Qye:(node:any)=>structuredClone(node),lEt:(node:any)=>node,
  cEt:async(canvasId:string,targetId:string,graph:any,name:string)=>{submitted={canvasId,targetId,graph,name};return true;},
 });
 expect(await run(mapped.toolbarContext,original.targetNode,'rhtv-asset:owned',{sceneCode:'canvas-image-quick-create-multi-camera-9-grid',titleKey:'native title',paramOverrides:{resolution:'2k'}})).toBe(true);
 const target=submitted.graph.nodes[0];expect(target.type).toBe('rh-image');expect(target.data.modelCode).toBe(nativeQuickSceneAlias);expect(target.data.sceneCode).toBe('canvas-image-quick-create-multi-camera-9-grid');expect(target.data.toolsType).toBe('image-image');expect(target.data.toolsSourceUrl).toBe('rhtv-asset:owned');expect(target.data.params).toEqual({quality:'high',resolution:'2k',instructions:'',referenceImages:['rhtv-asset:owned']});expect(target.data.generateNum).toBe(1);expect(submitted.graph.edges).toEqual([{source:'source',target:'quick-generated'}]);expect(submitted.graph.nodes[1]).toEqual(original.targetNode);expect(submitted.canvasId).toBe('project-owned');expect(original.targetNode.data.params.prompt).toBe('original prompt');expect(original.models['image-image']).toHaveLength(1);
});

it('scopes the native panorama chooser alias to an active panorama composer',()=>{
 const original=props(),panorama={...original,targetNode:{...original.targetNode,data:{...original.targetNode.data,panorama:{isPanoramaNode:true}}}},view=nativeImageToolbarProps(panorama,'P1t');
 expect(view.models['image-image'].some((model:any)=>model.modelCode==='image-image-rhart-image-n-g31-flash-official')).toBe(true);expect(view.models['image-image'][0]).toBe(original.models['image-image'][0]);expect(panorama.models).toBe(original.models);expect(nativeImageToolbarProps(original,'P1t')).toBe(original);
});
