import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {nativeModelProps,installNativeModelProjection} from '../../apps/web/src/service/model-selectors';
import {capabilityModel} from '../../apps/web/src/service/execution';

// Ror is the immutable video component's actual prepended replica menu. Its
// stored qualityName/config used to bypass the current service catalog.
const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=compiled.indexOf('function xye('),end=compiled.indexOf('const Ux=',start);
const replicaMenu=new Function('const rn={MULTIMODAL_VIDEO:"multimodal-video"};'+compiled.slice(start,end)+';return Ror;')() as (data:any,en?:boolean)=>any[];
const helpers=compiled.slice(compiled.indexOf('function c2e('),compiled.indexOf('function G9n('))+compiled.slice(compiled.indexOf('function Bor('),compiled.indexOf('function p7e('))+compiled.slice(compiled.indexOf('const Umt=new Set('),compiled.indexOf('function E6n('));
const effect=(begin:string,ending:string)=>{const first=compiled.indexOf(begin,compiled.indexOf('function nk('));return compiled.slice(first,compiled.indexOf(ending,first)+ending.length);};
const initialEffect=effect('d.useEffect(()=>{if(!g||_||!T.length||M.current)return;','},[g,R.rhModel,y,T,o,w,L,_]);'),persistedEffect=effect('d.useEffect(()=>{if(!g||!p||!m||_||k)return;','},[g,y,r,T,o,w,a,s,p,m,_,k,h,J]);');
// Mount the two real nk effects, including native c2e/Bor/IC/oF/nE guards.
// Parameter assembly and hook scheduling are external collaborators; repair
// decisions and the persisted h callback execute the immutable native source.
const native=new Function('const rn={MULTIMODAL_VIDEO:"multimodal-video"};'+compiled.slice(start,end)+helpers+`;return {list:c2e,mount(scope){const {d,g,p,m,_,k,y,r,T,o,w,a,s,h,J,M,N,R,L,K,Xu,P,P1,Ou,_t,TR,Gu,Vor,Od,E3,wO,kR}=scope;${initialEffect}${persistedEffect}}};`)() as {list:(models:any,mode:string,options:any)=>any[];mount:(scope:any)=>void};
function mountRepair(view:any){
 const mode=view.initialSubType===undefined?'text-video':view.initialSubType,list=native.list(view.models,mode,{allowTextImageFallback:false}),effects:Function[]=[],y=view.targetNode.data,ref=list.find(row=>row.modelCode===y.modelCode)?.modelCode??list[0]?.modelCode,commit=vi.fn(),state={rhModel:ref,...y.params};
 native.mount({d:{useEffect:(callback:Function)=>effects.push(callback)},g:'video',p:true,m:true,_:false,k:false,y,r:view.models,T:list,o:view.videoModelGroups,w:mode,a:mode,s:true,h:commit,J:vi.fn(),M:{current:null},N:{current:null},R:state,L:[],K:{current:state},Xu:{getState:()=>({get:()=>null})},P:vi.fn(),P1:(row:any)=>({rhModel:row.modelCode,...y.params}),Ou:()=>undefined,_t:{PROMPT:'prompt'},TR:()=>y,Gu:()=>null,Vor:(row:any)=>({rhModel:row.modelCode,...y.params}),Od:(value:any)=>value,E3:vi.fn(),wO:(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b),kR:'__promptEnhanceUndo'});
 for(const callback of effects)callback();return{commit,list};
}
const model=(ref='mock-omni',kind='OMNI_REFERENCE',available=true)=>capabilityModel({capabilityRef:ref,kind,version:'1',available,testMode:true,title:'STUDIO reference video',inputKinds:['TEXT','IMAGE','VIDEO','AUDIO'],outputKinds:['VIDEO'],parameterSchemaVersion:'1',parameterSchema:{type:'object',properties:{scenario:{type:'string',enum:['success','failure'],default:'success'}}}});
const groups=(models:any[])=>[{modelGroupId:'OMNI_REFERENCE',nodeTypeList:['MULTIMODAL_VIDEO'],modelGroupList:models.map(row=>({modelGroupId:row.modelCode,nodeTypeList:['MULTIMODAL_VIDEO'],nodeModelList:[{nodeType:'MULTIMODAL_VIDEO',modelList:[row]}]}))}];
const saved=(code='runninghub-old')=>({modelCode:code,modelName:'RunningHub old',qualityName:'Old vendor quality',qualityNameEn:'Old vendor quality EN',config:[{paramName:'vendor_secret_mode',type:'list'}]});
function props(data:any,models=[model()]){
 const node={id:'video',type:'rh-video',data};
 return{visible:true,initialSubType:'multimodal-video',targetNode:node,nodes:[node],edges:[],models:{'multimodal-video':models},videoModelGroups:groups(models),references:[{kind:'IMAGE'}],onNodeDataPatch:vi.fn(),onGenerate:vi.fn()};
}

it('removes unknown embedded replica menus from the render view while preserving the saved graph, prompt and callbacks',()=>{
 const old=saved(),data={subType:'multimodal-video',modelCode:old.modelCode,viralRemixReplicaModelCode:old.modelCode,viralRemixReplicaModel:old,viralRemixReplicaModels:[old],params:{prompt:'User prompt',imageUrls:['rhtv-asset:owned']},userMetadata:{name:'Untouched'}},input=props(data),before=JSON.stringify(input.targetNode);
 expect(replicaMenu(data)[0].modelGroupName).toBe('Old vendor quality');
 const view=nativeModelProps(input);
 expect(replicaMenu(view.targetNode.data)).toEqual([]);expect(JSON.stringify(input.targetNode)).toBe(before);
 expect(view.targetNode.data.modelCode).toBe('runninghub-old');expect(view.targetNode.data.params).toBe(data.params);expect(view.targetNode.data.userMetadata).toBe(data.userMetadata);
 expect(view.nodes).toBe(input.nodes);expect(view.videoModelGroups).toBe(input.videoModelGroups);expect(view.onGenerate).toBe(input.onGenerate);
 const unavailable=view.models['multimodal-video'].at(-1);expect(unavailable).toMatchObject({modelCode:old.modelCode,available:false,disabled:true,config:[]});expect(unavailable.modelName).toBe('未配置模型');expect(unavailable).not.toHaveProperty('qualityName');
 const patch={params:{prompt:'Only prompt changed'}};view.onNodeDataPatch('video',patch);expect(input.onNodeDataPatch).toHaveBeenCalledWith('video',patch);expect(input.onNodeDataPatch.mock.calls[0][1]).toBe(patch);
});

it('replaces a matched replica with the current public model, parameter config and TEST MODE label',()=>{
 const current=model(),old=saved(current.capabilityRef),data={subType:'MULTIMODAL_VIDEO',modelCode:current.capabilityRef,viralRemixReplicaModelCode:current.capabilityRef,viralRemixReplicaModel:old,viralRemixReplicaModels:[saved(),old],params:{prompt:'Original USER prompt',scenario:'failure'}},input=props(data,[current]),view=nativeModelProps(input),menu=replicaMenu(view.targetNode.data);
 expect(menu).toHaveLength(1);expect(menu[0].modelGroupName).toBe('[TEST MODE] STUDIO reference video');expect(replicaMenu(view.targetNode.data,true)[0].modelGroupNameEn).toBe('[TEST MODE] STUDIO reference video');expect(menu[0].nodeModelList[0].nodeType).toBe('MULTIMODAL_VIDEO');
 expect(menu[0].nodeModelList[0].modelList[0]).toMatchObject({capabilityRef:current.capabilityRef,modelCode:current.capabilityRef,testMode:true,config:current.config});expect(menu[0].nodeModelList[0].modelList[0]).not.toHaveProperty('qualityName');expect(view.targetNode.data.viralRemixReplicaModels).toEqual([current]);
 expect(view.targetNode.data.params).toBe(data.params);expect(data.viralRemixReplicaModel.config[0].paramName).toBe('vendor_secret_mode');expect(data.viralRemixReplicaModels).toHaveLength(2);
 expect(nativeModelProps(input).targetNode).toBe(view.targetNode);input.videoModelGroups=groups([{...current,available:false}]);expect(replicaMenu(nativeModelProps(input).targetNode.data)).toEqual([]);
});

it('does not publish unavailable, wrong-modality or incompatible profiles through an embedded multimodal-video menu',()=>{
 for(const current of [model('unavailable','OMNI_REFERENCE',false),model('text','LLM'),{...model('image-only'),inputKinds:['IMAGE']}]){
  const old=saved(current.capabilityRef),input=props({subType:'multimodal-video',modelCode:current.capabilityRef,viralRemixReplicaModel:old},[current]);input.references=[{kind:'VIDEO'}];
  expect(replicaMenu(nativeModelProps(input).targetNode.data)).toEqual([]);expect(input.targetNode.data.viralRemixReplicaModel).toBe(old);
 }
 const current=model(),input=props({subType:'multimodal-video',modelCode:current.capabilityRef,viralRemixReplicaModel:saved(current.capabilityRef)},[current]);input.videoModelGroups[0].modelGroupList[0].nodeModelList[0].nodeType='TEXT_VIDEO';
 expect(replicaMenu(nativeModelProps(input).targetNode.data)).toEqual([]);
});

it('handles the actual JSX seam and legacy code aliases without modifying other video props or restored wrappers',()=>{
 const current=model(),data={modelCode:current.capabilityRef,viralRemixReplicaModels:[{code:current.capabilityRef,qualityName:'Old SKU'}],params:{prompt:'Keep me'}},input=props(data,[current]),jsx=vi.fn((type,p)=>({type,props:p})),native={j:{jsx}},dispose=installNativeModelProjection(native),component=()=>null;
 expect(replicaMenu(native.j.jsx(component,input).props.targetNode.data)[0].modelGroupName).toBe('[TEST MODE] STUDIO reference video');expect(data.viralRemixReplicaModels[0].qualityName).toBe('Old SKU');
 const ordinary=props({subType:'text-video',params:{prompt:'Ordinary'}});expect(nativeModelProps(ordinary)).toBe(ordinary);dispose();expect(native.j.jsx).toBe(jsx);
});

it('prevents actual native nk effects from committing a default over an unknown saved choice, including a ref in another bucket',()=>{
 for(const selected of ['runninghub-old','codex-text-ref']){
  const old=saved(selected),input=props({subType:'multimodal-video',modelCode:selected,viralRemixReplicaModel:old,params:{prompt:'Saved user prompt',quality:'Saved user quality'}});
  (input.models as any)['text-text']=[model('codex-text-ref','LLM')];
  // Without the unavailable T value, the actual native effect reproduces the
  // overwrite that the previous render-only field deletion accidentally caused.
  const missing={...input,targetNode:{...input.targetNode,data:{...input.targetNode.data,viralRemixReplicaModel:undefined}}};
  expect(mountRepair(missing).commit).toHaveBeenCalledWith(expect.objectContaining({modelCode:'mock-omni'}));
  const view=nativeModelProps(input),mounted=mountRepair(view);expect(mounted.commit).not.toHaveBeenCalled();expect(mounted.list.some(row=>row.modelCode===selected&&row.disabled)).toBe(true);expect(replicaMenu(view.targetNode.data)).toEqual([]);expect(input.targetNode.data.params).toEqual({prompt:'Saved user prompt',quality:'Saved user quality'});
 }
});

it('keeps native Lc fallback sentinel disabled and syncs public refs only for a real model selection',()=>{
 const current=model(),input=props({subType:'multimodal-video',modelCode:'runninghub-old',capabilityRef:'stale-ref',capabilityVersion:'old',viralRemixReplicaModel:saved(),params:{prompt:'Original'}},[current]),view=nativeModelProps(input),list=mountRepair(view).list;
 const first=compiled.indexOf('function Lc('),last=compiled.indexOf('const SKn=',first),lc=new Function('scope',`with(scope){${compiled.slice(first,last)}return Lc;}`)({d:{useState:()=>[false,vi.fn()],useMemo:(factory:Function)=>factory()},It:()=>({t:(key:string)=>key}),Eo:()=>({preferEnFields:false}),GA:()=>({}),Q2:(row:any)=>row.label,wKn:()=>'',c:{jsx:(type:any,p:any)=>({type,props:p}),jsxs:(type:any,p:any)=>({type,props:p})},Bd:()=>null,ob:()=>null,i0t:()=>null,zm:()=>null,rS:1,oS:()=>null});
 const params={prompt:'Selected public prompt',scenario:'failure'},render=lc({value:'runninghub-old',options:list.map(row=>({...row,value:row.modelCode,label:row.modelName})),onChange:(ref:string)=>view.onNodeDataPatch('video',{modelCode:ref,params})});
 expect(render.props.menu.items.find((item:any)=>item.key==='runninghub-old').disabled).toBe(true);render.props.menu.onClick({key:current.modelCode});expect(input.onNodeDataPatch).toHaveBeenCalledWith('video',{modelCode:current.modelCode,params,capabilityRef:current.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1'});expect(input.targetNode.data.capabilityRef).toBe('stale-ref');expect(input.targetNode.data.params.prompt).toBe('Original');
});

it('protects the real default text-video T when initialSubType is omitted and skips the outer KHe props seam',()=>{
 const input=props({subType:'multimodal-video',modelCode:'runninghub-old',viralRemixReplicaModel:saved(),params:{prompt:'Saved'}});delete (input as any).initialSubType;
 (input.models as any)['text-video']=[model('mock-text-video','TEXT_TO_VIDEO')];const view=nativeModelProps(input),mounted=mountRepair(view);
 expect(mounted.commit).not.toHaveBeenCalled();expect(mounted.list.at(-1)).toMatchObject({modelCode:'runninghub-old',disabled:true});expect(view.models['multimodal-video']).toBe(input.models['multimodal-video']);expect(replicaMenu(view.targetNode.data)).toEqual([]);
 const outer={...input};delete (outer as any).visible;expect(nativeModelProps(outer)).toBe(outer);
});
