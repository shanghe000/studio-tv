import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {nativeModelProps,installNativeModelProjection} from '../../apps/web/src/service/model-selectors';
import {capabilityModel} from '../../apps/web/src/service/execution';
import {clearModelCatalogView,consumeNativeModelSelectionIntent,withNativeModelSelectionIntent} from '../../apps/web/src/service/model-catalog-view';

afterEach(clearModelCatalogView);
const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=compiled.indexOf('function xye('),end=compiled.indexOf('const Ux=',start),helpers=compiled.slice(compiled.indexOf('function c2e('),compiled.indexOf('function G9n('))+compiled.slice(compiled.indexOf('function Bor('),compiled.indexOf('function p7e('))+compiled.slice(compiled.indexOf('const Umt=new Set('),compiled.indexOf('function E6n('));
function effect(begin:string,ending:string,component='function nk('){const first=compiled.indexOf(begin,compiled.indexOf(component));return compiled.slice(first,compiled.indexOf(ending,first)+ending.length);}
const initial=effect('d.useEffect(()=>{if(!g||_||!T.length||M.current)return;','},[g,R.rhModel,y,T,o,w,L,_]);'),persisted=effect('d.useEffect(()=>{if(!g||!p||!m||_||k)return;','},[g,y,r,T,o,w,a,s,p,m,_,k,h,J]);'),modeRepair=effect('d.useEffect(()=>{if(C!==l||!mt||!et.length)return;','},[mt,et,C,l,_e,te,hn,_]);','function S3r('),cit=compiled.slice(compiled.indexOf('function cit('),compiled.indexOf('function Ymn('));
// Execute the immutable nk/S3r repair decisions and original lookup guards.
// Parameter assembly and React scheduling are the external collaborators.
const native=new Function('const rn={MULTIMODAL_VIDEO:"multimodal-video"};'+compiled.slice(start,end)+helpers+cit+`;return{list:c2e,group:pu,mount(scope){const {d,g,p,m,_,k,y,r,T,o,w,a,s,h,J,M,N,R,L,K,Xu,P,P1,Ou,_t,TR,Gu,Vor,Od,E3,wO,kR}=scope;${initial}${persisted}},mode(scope){const {d,C,l,mt,et,_e,te,hn,K,pEn,dEn,fEn,b3r,yut,k,window,_}=scope;${modeRepair}}};`)();
function mounted(view:any){
 const node=view.targetNode,mode=view.initialSubType??'text-video',list=native.list(view.models,mode,{allowTextImageFallback:false}),effects:Function[]=[],y=node.data,current=list.find((row:any)=>row.modelCode===y.modelCode)??list[0],commit=vi.fn((patch:any)=>view.onNodeDataPatch(node.id,patch)),params={rhModel:current?.modelCode,...y.params},same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
 native.mount({d:{useEffect:(callback:Function)=>effects.push(callback)},g:node.id,p:true,m:true,_:false,k:false,y,r:view.models,T:list,o:view.videoModelGroups,w:mode,a:mode,s:true,h:commit,J:vi.fn(),M:{current:null},N:{current:null},R:params,L:current?.config??[],K:{current:params},Xu:{getState:()=>({get:()=>null})},P:vi.fn(),P1:(row:any)=>({rhModel:row.modelCode,...y.params}),Ou:()=>undefined,_t:{PROMPT:'prompt'},TR:()=>y,Gu:()=>null,Vor:(row:any)=>({rhModel:row.modelCode,...y.params}),Od:(value:any)=>value,E3:vi.fn(),wO:same,kR:'__promptEnhanceUndo'});for(const run of effects)run();return{commit,list};
}
const model=(ref:string,kind:string,mode:string,available=false)=>capabilityModel({capabilityRef:ref,version:'1',kind,available,testMode:false,title:ref,model:{providerRef:ref==='comfy'?'comfy-local':'minimax-official',modelRef:ref,title:ref,version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE','VIDEO','AUDIO'],outputKinds:['VIDEO'],parameterSchemaVersion:'1',parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['768p-1x1-10s','480p-21x9-15s'],default:'768p-1x1-10s'}},'x-video-mode':mode,'x-model-source':{kind:ref==='comfy'?'SELF_HOSTED':'API',...(ref!=='comfy'?{credentialProviderRef:'minimax-official'}:{})}}});
function groups(rows:{model:any;mode:string}[]){return rows.map(({model,mode})=>({modelGroupId:model.modelCode,modelGroupName:model.modelName,nodeTypeList:[mode.replaceAll('-','_').toUpperCase()],nodeModelList:[{nodeType:mode.replaceAll('-','_').toUpperCase(),modelList:[model]}]}));}
function props(mode='text-video',kind='TEXT_TO_VIDEO',references:any[]=[],missingBucket=false){
 const api=model('saved-api',kind,kind),local=model('comfy','IMAGE_TO_VIDEO','FIRST_FRAME',true),node={id:'video',type:'rh-video',data:{modelCode:api.modelCode,capabilityRef:api.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',subType:mode,status:'idle',params:{prompt:'Saved user prompt',outputPreset:'480p-21x9-15s',...(references.length?{imageUrls:['rhtv-asset:portrait'],videoUrls:references.some(row=>row.kind==='VIDEO')?['rhtv-asset:motion']:[]}:{}),customMetadata:'keep'},metadata:{keep:true}}},models:any={'image-video':[local],...(missingBucket?{}:{[mode]:[api,...(mode==='image-video'?[local]:[])]})},onNodeDataPatch=vi.fn();
 return{visible:true,initialSubType:'image-video',targetNode:node,nodes:[node],edges:[],models,videoModelGroups:groups([{model:local,mode:'image-video'},{model:api,mode}]),references,onNodeDataPatch,onGenerate:vi.fn()};
}

it.each([['text-video','TEXT_TO_VIDEO',[]],['start-video','IMAGE_TO_VIDEO',[{kind:'IMAGE'}]],['multimodal-video','OMNI_REFERENCE',[{kind:'IMAGE'},{kind:'VIDEO'}]]])('preserves %s saved API identity, mode, version and full parameters through actual nk repair effects after key removal', (mode,kind,references)=>{
 const input=props(mode as string,kind as string,references as any[],true),before=JSON.stringify(input.targetNode),view=nativeModelProps(input),mountedView=mounted(view);
 expect(view.initialSubType).toBe(mode);expect(mountedView.list.find((row:any)=>row.modelCode==='saved-api')).toMatchObject({available:false,disabled:true,capabilityVersion:'1',parameterSchemaVersion:'1'});expect(mountedView.list.find((row:any)=>row.modelCode==='saved-api').config).toEqual(input.videoModelGroups[1].nodeModelList[0].modelList[0].config);expect(mountedView.commit).not.toHaveBeenCalled();expect(input.onNodeDataPatch).not.toHaveBeenCalled();expect(JSON.stringify(input.targetNode)).toBe(before);expect(view.videoModelGroups[1].nodeModelList[0].modelList[0].available).toBe(false);
});

it('blocks the real S3r automatic mode fallback and its bundled default parameters while allowing ordinary no-key parameter edits',()=>{
 const input=props(),view=nativeModelProps(input),effects:Function[]=[],fallback={type:'image-video',disabled:false},repair=vi.fn((mode:any)=>view.onNodeDataPatch('video',{modelCode:'comfy',subType:mode.type,params:{prompt:'',outputPreset:'landscape-480p-5s'}}));
 native.mode({d:{useEffect:(run:Function)=>effects.push(run)},C:'text-video',l:'text-video',mt:{},et:[{type:'text-video',disabled:true},fallback],_e:{image:1,video:0,audio:0},te:'video',hn:repair,K:{current:null},dEn:()=>null,pEn:vi.fn(),fEn:()=>0,b3r:0,yut:vi.fn(),k:vi.fn(),window:{},_:0});for(const run of effects)run();expect(repair).toHaveBeenCalledWith(fallback);expect(input.onNodeDataPatch).not.toHaveBeenCalled();
 const edit={modelCode:'saved-api',subType:'text-video',params:{prompt:'New prompt without key',outputPreset:'768p-1x1-10s'}};view.onNodeDataPatch('video',edit);expect(input.onNodeDataPatch).toHaveBeenCalledExactlyOnceWith('video',edit);
});

it('allows one explicit same-node selection back to a self-hosted model, binding its real public version',()=>{
 const input=props(),record=vi.fn(),binding={node:(value:any)=>value,current:()=>true,record},view=nativeModelProps(input,binding),patch={modelCode:'comfy',subType:'image-video',params:{prompt:'Deliberate self-hosted choice',outputPreset:'768p-1x1-10s'}};
 withNativeModelSelectionIntent('another-node','comfy',()=>view.onNodeDataPatch('video',patch));expect(input.onNodeDataPatch).not.toHaveBeenCalled();
 withNativeModelSelectionIntent('video','comfy',()=>{view.onNodeDataPatch('video',patch);view.onNodeDataPatch('video',patch);});expect(input.onNodeDataPatch).toHaveBeenCalledExactlyOnceWith('video',{...patch,capabilityRef:'comfy',capabilityVersion:'1',parameterSchemaVersion:'1'});expect(record).toHaveBeenCalledOnce();expect(consumeNativeModelSelectionIntent('video','comfy')).toBe(false);
});

it('keeps an unavailable complete row when group loading is late and drops unused selection intent immediately',()=>{
 const input=props();input.videoModelGroups=[];const view=nativeModelProps(input);expect(view.videoModelGroups.flatMap((group:any)=>group.nodeModelList.flatMap((row:any)=>row.modelList))).toContainEqual(expect.objectContaining({modelCode:'saved-api',available:false,disabled:true,config:expect.any(Array)}));withNativeModelSelectionIntent('video','comfy',()=>{});view.onNodeDataPatch('video',{modelCode:'comfy',subType:'image-video',params:{prompt:''}});expect(input.onNodeDataPatch).not.toHaveBeenCalled();
});

it('reproduces the actual native persisted-bucket overwrite before projecting a temporarily misplaced API row back into its saved bucket',()=>{
 const input=props(),api=input.videoModelGroups[1].nodeModelList[0].modelList[0],local=model('comfy','TEXT_TO_VIDEO','TEXT_TO_VIDEO',true);input.initialSubType='text-video';input.models={'text-video':[local],'image-video':[api]};input.videoModelGroups=groups([{model:local,mode:'text-video'}]);
 const unsafe=mounted(input);expect(unsafe.commit).toHaveBeenCalledWith(expect.objectContaining({modelCode:'comfy',subType:'text-video'}));expect(input.onNodeDataPatch).toHaveBeenCalledOnce();input.onNodeDataPatch.mockClear();
 const view=nativeModelProps(input),safe=mounted(view);expect(safe.list.find((row:any)=>row.modelCode==='saved-api')?.config).toEqual(api.config);expect(safe.commit).not.toHaveBeenCalled();expect(input.onNodeDataPatch).not.toHaveBeenCalled();
});

it('carries the exact composer node owner through the actual model-selector JSX seam before allowing an explicit self-hosted choice',()=>{
 const input=props(),view=nativeModelProps(input),context={Provider:'owner-provider'},react={createContext:()=>context,useContext:vi.fn(()=>input.targetNode.id),useState:(value:any)=>[typeof value==='function'?value():value,vi.fn()],useEffect:()=>{},cloneElement:(element:any,patch:any)=>({...element,props:{...element.props,...patch}}),createElement:(type:any,props:any,...children:any[])=>({type,props:{...props,...(children.length?{children:children[0]}:{})}})},jsx=vi.fn((type:any,props:any)=>({type,props})),runtime={j:{jsx},r:react},dispose=installNativeModelProjection(runtime);
 const composer=runtime.j.jsx(function TestComposer(){},input),owner=composer.type(composer.props);expect(owner.type).toBe(context.Provider);expect(owner.props.value).toBe('video');
 const first=compiled.indexOf('function Lc('),last=compiled.indexOf('const SKn=',first),lc=new Function(compiled.slice(first,last)+';return Lc;')(),local=input.models['image-video'][0],api=input.videoModelGroups[1].nodeModelList[0].modelList[0],patch={modelCode:local.modelCode,subType:'image-video',params:{prompt:'Explicit choice'}};
 const menu=runtime.j.jsx(lc,{value:'saved-api',options:[local,api].map((row:any)=>({...row,value:row.modelCode,label:row.modelName})),onChange:()=>view.onNodeDataPatch('video',patch)}),rendered=menu.type(menu.props);rendered.props.onChange('comfy');expect(react.useContext).toHaveBeenCalledWith(context);expect(input.onNodeDataPatch).toHaveBeenCalledWith('video',expect.objectContaining({modelCode:'comfy',capabilityRef:'comfy',capabilityVersion:'1'}));dispose();
});
