import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {imageHistoryDisplayProps,installImageHistoryDisplay} from '../../apps/web/src/service/image-history-display';
import captured from './fixtures/native-image-history-count2-preview.json';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),a=frozen.indexOf('function C4('),b=frozen.indexOf('const ev=',a),jsx=(type:any,props:any,...keys:any[])=>({type,props,keys});
const hooks={useState:(value:any)=>[typeof value==='function'?value():value,vi.fn()],useRef:(value:any)=>({current:value}),useMemo:(fn:Function)=>fn(),useCallback:(fn:Function)=>fn,useEffect:vi.fn(),useLayoutEffect:vi.fn()};
const sandbox:any={p:hooks,c:{jsx,jsxs:jsx,Fragment:'fragment'},Xe:()=>({t:(key:string)=>key}),ol:(selector:Function)=>selector({running:false,start:vi.fn()}),k4:()=>2,w4:()=>[],Y0:()=>({min:.25,max:4,step:.1,scale:1}),jc:()=>({width:0,height:0}),S4:()=> '2026-10-22',Set,Map,Math,Number,String,Boolean,Array,Object,Date,undefined,window:{},document:{},console};
const nativeC4=runInNewContext(frozen.slice(a,b)+';C4',new Proxy(sandbox,{get:(target,key)=>key in target?target[key]:typeof key==='string'?function NativeUiStub(){}:undefined}));
function props(){const outputId='out-one',output={historyOutputId:outputId,mediaId:'asset-one',outputType:'image/png',width:1024,height:1024};return{kind:'image',items:[{historyOutputId:outputId,url:'rhtv-asset:asset-one',metadata:{ratio:'16:9',quality:'2K',model:'Z-Image-Turbo',createdAt:1792647243000},historySnapshot:{version:2,id:'batch',params:{aspectRatio:'16:9',outputPreset:'1024-square'},outputs:[output]}}],activeIndex:0,onSelect:vi.fn(),onClose:vi.fn()};}
function nodes(tree:any):any[]{if(!tree||typeof tree!=='object')return[];return[tree,...(Array.isArray(tree)?tree:Object.values(tree.props||{})).flatMap(nodes)];}
function spec(tree:any){return nodes(tree).find(node=>node.props?.className?.includes('is-generation-spec'))?.props.children[1].props.children;}

it('uses the actual frozen C4 body to replace a stale native ratio with bound output dimensions',()=>{
 const input=props(),before=structuredClone(input.items),native={j:{jsx,jsxs:jsx}},release=installImageHistoryDisplay(native),render=native.j.jsx(nativeC4,input);
 try{expect(spec(nativeC4(input))).toBe('16:9 / 2K');expect(render.type).toBe(nativeC4);expect(spec(render.type(render.props))).toBe('1024×1024（实际输出）');expect(input.items).toEqual(before);expect(render.props.items[0].historySnapshot).toBe(input.items[0].historySnapshot);expect(render.props.items[0].url).toBe(input.items[0].url);expect(render.props.onSelect).toBe(input.onSelect);render.props.onSelect(0);expect(input.onSelect).toHaveBeenCalledExactlyOnceWith(0);}finally{release();}expect(native.j.jsx).toBe(jsx);expect(native.j.jsxs).toBe(jsx);
});
it('projects both actual global-history items without inventing output or asset selectors',()=>{
 // The capture retained only the two count2 items from a larger list, with its
 // original activeIndex preserved. Render the first retained item explicitly.
 const input:any={...structuredClone(captured),activeIndex:0,onSelect:vi.fn(),onClose:vi.fn()},before=structuredClone(input.items),native={j:{jsx,jsxs:jsx}},release=installImageHistoryDisplay(native);
 try{expect(spec(nativeC4(input))).toBe('16:9');for(const item of input.items){expect(item).not.toHaveProperty('assetId');expect(item).not.toHaveProperty('historyOutputId');}const rendered=native.j.jsx(nativeC4,input),projected=rendered.props;expect(spec(nativeC4(projected))).toBe('1024×1024（实际输出）');expect(spec(nativeC4({...projected,activeIndex:1}))).toBe('1024×1024（实际输出）');for(let index=0;index<2;index++)expect(projected.items[index].canvasHistoryDetail).toBe(input.items[index].canvasHistoryDetail);expect(input.items).toEqual(before);expect(projected.onSelect).toBe(input.onSelect);}finally{release();}
});
it('uses the exact second native output key instead of an index or sibling guess',()=>{
 const input:any=structuredClone(captured);input.items[1].canvasHistoryDetail=structuredClone(input.items[0].canvasHistoryDetail);const second=input.items[1],detail=second.canvasHistoryDetail;detail.outputs[0].width=512;detail.outputs[0].height=768;
 const result=imageHistoryDisplayProps(input);expect(result.items[0].metadata.ratio).toBe('1024×1024（实际输出）');expect(result.items[1].metadata.ratio).toBe('1024×1024（实际输出）');expect(result.items[1].canvasHistoryDetail).toBe(detail);expect(second.metadata.ratio).toBe('16:9');
});
it('keeps an unhydrated native item untouched and does not borrow the other item detail',()=>{
 const input:any=structuredClone(captured),second=input.items[1];delete second.canvasHistoryDetail;second.canvasHistoryDetailLoaded=false;second.metadata={createdAt:second.metadata.createdAt};expect(imageHistoryDisplayProps(input).items[1]).toBe(second);expect(second.metadata).not.toHaveProperty('ratio');
});
it.each(['wrong-task','wrong-plan','inconsistent-plan','wrong-asset','wrong-output-id','ambiguous-output','non-image','missing-dimensions','conflicting-asset-selectors','wrong-prefix','wrong-output-key','missing-key'])('keeps the captured global-history item unchanged for %s',mode=>{
 const input:any=structuredClone(captured),item=input.items[0],detail=item.canvasHistoryDetail;if(mode==='wrong-task')detail.taskId='other';if(mode==='wrong-plan')item.canvasHistoryTaskPlanId='other';if(mode==='inconsistent-plan')detail.id='other';if(mode==='wrong-asset')item.assetId='rhtv-asset:foreign';if(mode==='wrong-output-id')item.historyOutputId='foreign';if(mode==='ambiguous-output')detail.outputs.push({...detail.outputs[0]});if(mode==='non-image')detail.outputs[0].mimeType='video/mp4';if(mode==='missing-dimensions')delete detail.outputs[0].width;if(mode==='conflicting-asset-selectors')item.mediaId='another';if(mode==='wrong-prefix')item.key=item.key.replace('canvas-history-image-','canvas-history-video-');if(mode==='wrong-output-key')item.key='canvas-history-image-out_foreign';if(mode==='missing-key')delete item.key;
 expect(imageHistoryDisplayProps(input).items[0]).toBe(item);expect(item.metadata.ratio).toBe('16:9');
});
it('receives the actual frozen QJn output shape through the installed JSX seam and gives C4 projected props',()=>{
 const main=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),a=main.indexOf('function QJn('),b=main.indexOf('const ZJn=',a),openPreview=vi.fn(),build=runInNewContext(main.slice(a,b)+';QJn',{XJn:(url:string)=>url,YJn:(date:any)=>Number(date),Ad:{getState:()=>({openPreview})}}),detail=captured.items[0].canvasHistoryDetail;
 const records=detail.outputs.map(output=>({id:output.id,resultUrl:'https://example.test/'+output.assetId,taskId:detail.taskId,taskPlanId:detail.executionId,createTime:captured.items[0].metadata.createdAt}));expect(build({records,activeRecord:records[1],kind:'image',title:'QA count2'})).toBe(true);const original=openPreview.mock.calls[0][0];expect(original.activeIndex).toBe(1);expect(original.items.map((item:any)=>item.key)).toEqual(captured.items.map(item=>item.key));for(const item of original.items){expect(item).not.toHaveProperty('assetId');expect(item).not.toHaveProperty('historyOutputId');}
 // Native detail hydration is asynchronous; retain its exact selected key.
 const hydrated={...original,items:original.items.map((item:any,index:number)=>({...item,metadata:captured.items[index].metadata,canvasHistoryDetail:captured.items[index].canvasHistoryDetail,canvasHistoryDetailLoaded:true}))},base=vi.fn(jsx),native={j:{jsx:base,jsxs:base}},release=installImageHistoryDisplay(native);
 try{const render=native.j.jsx(nativeC4,hydrated);expect(base.mock.calls[0][1].items[1].metadata.ratio).toBe('1024×1024（实际输出）');expect(spec(render.type(render.props))).toBe('1024×1024（实际输出）');expect(hydrated.items[1].metadata.ratio).toBe('16:9');expect(base.mock.calls[0][1].items[1].canvasHistoryDetail).toBe(hydrated.items[1].canvasHistoryDetail);}finally{release();}
});
it.each(['outputId','assetId','unique'])('binds a saved image by %s without using a positional guess',mode=>{
 const input:any=props(),item=input.items[0];if(mode==='assetId'){delete item.historyOutputId;item.assetId='asset-one';item.historySnapshot.outputs.push({historyOutputId:'two',mediaId:'asset-two',outputType:'image/png',width:512,height:768});}if(mode==='unique')delete item.historyOutputId;
 expect(imageHistoryDisplayProps(input).items[0].metadata.ratio).toBe('1024×1024（实际输出）');
});
it.each(['wrong-id','ambiguous-id','ambiguous-asset','wrong-asset','no-selector-multiple','non-image','zero-width','fractional-height','missing-width','string-dimension','no-snapshot','no-outputs'])('keeps unproven or invalid dimensions unchanged: %s',mode=>{
 const input:any=props(),item=input.items[0],output=item.historySnapshot.outputs[0];if(mode==='wrong-id')item.historyOutputId='foreign';if(mode==='ambiguous-id')item.historySnapshot.outputs.push({...output});if(mode==='ambiguous-asset'){delete item.historyOutputId;item.assetId='asset-one';item.historySnapshot.outputs.push({...output,historyOutputId:'two'});}if(mode==='wrong-asset')item.assetId='asset-other';if(mode==='no-selector-multiple'){delete item.historyOutputId;item.historyOutputIndex=0;item.historySnapshot.outputs.push({...output,historyOutputId:'two'});}if(mode==='non-image')output.outputType='video/mp4';if(mode==='zero-width')output.width=0;if(mode==='fractional-height')output.height=512.5;if(mode==='missing-width')delete output.width;if(mode==='string-dimension')output.width='1024';if(mode==='no-snapshot')delete item.historySnapshot;if(mode==='no-outputs')item.historySnapshot.outputs=[];
 expect(imageHistoryDisplayProps(input)).toBe(input);
});
it('does not project video or non-history components and preserves native callbacks',()=>{
 const input:any=props(),native={j:{jsx,jsxs:jsx}},release=installImageHistoryDisplay(native);function C4(){return null;}function Other(){return null;}
 try{expect(native.j.jsx(C4,input).props).toBe(input);expect(native.j.jsx(Other,input).props).toBe(input);input.kind='video';expect(native.j.jsx(nativeC4,input).props).toBe(input);}finally{release();}
});
it('projects newly selected results individually and does not reuse a previous output size',()=>{
 const input:any=props();input.items[0].historySnapshot.outputs.push({historyOutputId:'out-two',mediaId:'asset-two',outputType:'image/png',width:1536,height:1024});input.items.push({...input.items[0],historyOutputId:'out-two'});const result=imageHistoryDisplayProps(input);
 expect(result.items.map((item:any)=>item.metadata.ratio)).toEqual(['1024×1024（实际输出）','1536×1024（实际输出）']);expect(imageHistoryDisplayProps(result)).toBe(result);
});
it('deactivates within a later JSX wrapper and leaves that wrapper owned by its installer',()=>{
 const native={j:{jsx,jsxs:jsx}},release=installImageHistoryDisplay(native),owned=native.j.jsx,outer=vi.fn((...args:any[])=>owned(...args));native.j.jsx=outer;release();expect(native.j.jsx).toBe(outer);expect(native.j.jsx(nativeC4,props()).props.items[0].metadata.ratio).toBe('16:9');
});
