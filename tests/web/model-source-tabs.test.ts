import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {filterModelSourceGroups,modelExecutionSource,nativeOrdinarySourceMenu,modelTriggerKeyboardHandlers} from '../../apps/web/src/service/video-model-menu';
import {clearModelCatalogView,projectModelCatalogProps,replaceModelCatalogView,subscribeModelCatalogView} from '../../apps/web/src/service/model-catalog-view';
import {capabilityModel} from '../../apps/web/src/service/execution';
import {apiVideoSelectionProps} from '../../apps/web/src/service/model-selectors';

afterEach(clearModelCatalogView);
const model=(ref:string,kind?:string)=>({capabilityRef:ref,modelCode:ref,capabilityVersion:'1',parameterSchemaVersion:'1',config:[{paramName:'old-version-setting'}],available:false,...(kind?{'x-model-source':{kind}}:{})});
const groups=(rows:any[])=>[{modelGroupId:'root',nodeTypeList:['TEXT_VIDEO','START_VIDEO'],modelGroupList:rows.map((row,index)=>({modelGroupId:row.modelCode,nodeTypeList:[index?'START_VIDEO':'TEXT_VIDEO'],nodeModelList:[{nodeType:index?'START_VIDEO':'TEXT_VIDEO',modelList:[row]}]}))}];

it('separates by explicit metadata, preserves category hierarchy and never infers from model names',()=>{
 const local=model('local','SELF_HOSTED'),api=model('api','API'),unknown={...model('unknown'),modelName:'官方 API'};const original=groups([local,api,unknown]);
 expect(modelExecutionSource(unknown)).toBeUndefined();const self=filterModelSourceGroups(original,'SELF_HOSTED'),remote=filterModelSourceGroups(original,'API');
 expect(self[0].modelGroupList.map((row:any)=>row.modelGroupId)).toEqual(['local']);expect(remote[0].modelGroupList.map((row:any)=>row.modelGroupId)).toEqual(['api']);expect(self[0].nodeTypeList).toEqual(['TEXT_VIDEO']);expect(remote[0].nodeTypeList).toEqual(['START_VIDEO']);expect(original[0].modelGroupList).toHaveLength(3);
});

it('refreshes account-specific availability without changing saved versions or versioned configs',()=>{
 const old=model('api','API'),before=groups([old]),props={models:{'text-video':[old]},videoModelGroups:before,targetNode:{id:'saved',data:{modelCode:'api',capabilityVersion:'1',params:{outputPreset:'saved-v1'}}}},changed=vi.fn(),release=subscribeModelCatalogView(changed);
 replaceModelCatalogView(groups([{...model('api','API'),capabilityVersion:'3',config:[{paramName:'new-version-setting'}],available:true,disabled:false,reason:null}]));const projected=projectModelCatalogProps(props);
 expect(projected.models['text-video'][0]).toMatchObject({available:true,capabilityVersion:'1',config:[{paramName:'old-version-setting'}]});expect(projected.targetNode).toBe(props.targetNode);expect(props.models['text-video'][0].available).toBe(false);expect(changed).toHaveBeenCalledOnce();release();
 clearModelCatalogView();expect(projectModelCatalogProps(props)).toBe(props);
});

it('only projects static source identity, keeping actor key status out of native saved model metadata',()=>{
 const native=capabilityModel({capabilityRef:'api',version:'1',kind:'TEXT_TO_VIDEO',available:false,parameterSchema:{properties:{},'x-model-source':{kind:'API',credentialProviderRef:'minimax-official',credentialConfigured:false,unavailableCode:'PROVIDER_CREDENTIAL_REQUIRED'}}});
 expect(native['x-model-source']).toEqual({kind:'API',credentialProviderRef:'minimax-official'});expect(native).not.toHaveProperty('credentialConfigured');
});

it('pins an explicitly selected API model to its public version after a live key refresh',()=>{
 const old=model('api','API'),node={id:'node',type:'rh-video',data:{modelCode:'local',capabilityVersion:'historical',params:{prompt:'keep'}}},patch=vi.fn(),record=vi.fn(),bindings={node:(value:any)=>value,record,current:()=>true},props={targetNode:node,models:{'text-video':[old]},onNodeDataPatch:patch};
 const projected=apiVideoSelectionProps(props,bindings);replaceModelCatalogView(groups([{...old,available:true,disabled:false,capabilityVersion:'1',parameterSchemaVersion:'1'}]));
 projected.onNodeDataPatch('node',{modelCode:'api',params:{prompt:'new'}});expect(patch).toHaveBeenCalledExactlyOnceWith('node',{modelCode:'api',capabilityRef:'api',capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'new'}});expect(record).toHaveBeenCalledOnce();expect(node.data.capabilityVersion).toBe('historical');
 expect(apiVideoSelectionProps(projected,bindings)).toBe(projected);
});

it('switches the actual frozen shared dropdown menu without selecting a model or changing its trigger',()=>{
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=source.indexOf('function Lc('),end=source.indexOf('const SKn=',start);
 const states:any[]=[],refs:any[]=[],element=(type:any,props:any,...children:any[])=>({type,props:{...props,...(children.length?{children:children.length===1?children[0]:children}:{})}});let slot=0;
 const react={useState:(initial:any)=>{const index=slot++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],(value:any)=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef:(initial:any)=>{const index=slot++;return refs[index]??(refs[index]={current:initial});},useMemo:(fn:Function)=>fn(),useEffect:()=>{},createElement:element,isValidElement:(value:any)=>!!value?.props,cloneElement:(value:any,props:any)=>({...value,props:{...value.props,...props}})};
 const native=runInNewContext(source.slice(start,end)+';Lc',{d:react,It:()=>({t:(key:string)=>key,i18n:{}}),GA:()=>({triggerRef:null,onOpenChange:()=>{}}),Eo:()=>({preferEnFields:false}),Q2:(option:any)=>option.label,wKn:()=>'',c:{jsx:element,jsxs:element},Bd:'native-dropdown',ob:'native-content',i0t:'native-label',zm:'native-arrow',rS:1000,oS:()=>{}});
 capabilityModel({capabilityRef:'local',kind:'TEXT_TO_IMAGE',version:'1',available:true,parameterSchema:{'x-model-source':{kind:'SELF_HOSTED'}}});capabilityModel({capabilityRef:'api',kind:'TEXT_TO_IMAGE',version:'1',available:true,parameterSchema:{'x-model-source':{kind:'API'}}});
 const onChange=vi.fn(),input={value:'local',options:[{value:'local',label:'Local image'},{value:'api',label:'Hosted image'}],onChange},wrapper=nativeOrdinarySourceMenu(native,input,react);expect(wrapper).not.toBe(native);
 const render=()=>{slot=0;return wrapper(input);};let rendered=render();expect(rendered.props.menu.items.map((item:any)=>item.key)).toEqual(['local']);const currentTrigger=rendered.props.children;
 const header=rendered.props.dropdownRender('native menu').props.children[0],tabs=header.props.children[0];tabs.props.children[1].props.onClick({stopPropagation:()=>{}});
 rendered=render();expect(rendered.props.menu.items.map((item:any)=>item.key)).toEqual(['api']);const label=(trigger:any)=>trigger.props.children.find((child:any)=>child?.type==='native-label').props.label;expect(label(rendered.props.children)).toBe(label(currentTrigger));expect(onChange).not.toHaveBeenCalled();rendered.props.menu.onClick({key:'api'});expect(onChange).toHaveBeenCalledExactlyOnceWith('api');
 const mixed={...input,options:[...input.options,{value:'unknown',label:'Unclassified model'}]};slot=0;const mixedView=nativeOrdinarySourceMenu(native,mixed,react)(mixed);expect(mixedView.props.menu.items.map((item:any)=>item.key)).toEqual(['local','api','unknown']);
});

it.each(['Enter',' ','Spacebar'])('keeps %s on model triggers from invoking a global generation shortcut without cancelling native click defaults',key=>{
 const original=vi.fn(),handlers=modelTriggerKeyboardHandlers({onKeyDown:original,onKeyUp:original}),stopPropagation=vi.fn(),preventDefault=vi.fn(),event={key,stopPropagation,preventDefault};handlers.onKeyDown(event);handlers.onKeyUp(event);expect(stopPropagation).toHaveBeenCalledTimes(2);expect(original).toHaveBeenCalledTimes(2);expect(preventDefault).not.toHaveBeenCalled();
});

it('leaves model trigger Tab and ordinary navigation keys available to native keyboard handling',()=>{
 const original=vi.fn(),handlers=modelTriggerKeyboardHandlers({onKeyDown:original}),stopPropagation=vi.fn();for(const key of ['Tab','ArrowDown','Escape'])handlers.onKeyDown({key,stopPropagation});expect(original).toHaveBeenCalledTimes(3);expect(stopPropagation).not.toHaveBeenCalled();
});
