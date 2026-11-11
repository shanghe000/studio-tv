import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
import {completeNativeVideoCommand,nativeVideoComposedPrompt,nativeVideoReferences,normalizeNativeVideoPrompt,projectNativeVideoInputs} from '../../apps/web/src/service/video-command';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
function frozen(name:string){const start=compiled.indexOf('function '+name+'('),end=compiled.indexOf('function ',start+name.length+10);if(start<0||end<0)throw Error('Frozen video seam changed: '+name);return compiled.slice(start,end);}
// Exercise the actual q_ composition and its captured dJ text choice. These
// cases need no model config, so media-schema/network services are not invoked.
const nativeProject=runInNewContext(frozen('ADe')+frozen('dJ')+frozen('cJ')+frozen('q_')+';q_',{
 W5:(value:any)=>JSON.parse(JSON.stringify(value)),dw:()=>[],nNn:()=> 'prompt',sd:(id:string,nodes:any[],edges:any[])=>edges.filter(edge=>edge.target===id).map(edge=>nodes.find(node=>node.id===edge.source)),As:(type:string)=>['rh-text','text-input','text'].includes(type),Vut:(value:string)=>value.trim(),PA:(data:any)=>data.mentionAssets??[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],aNn:()=>{},oft:()=>false,dNn:(value:any)=>value,hM:()=>null,sft:()=>[],J1e:()=>false,fNn:new Set(),
});
const video=(patch:any={})=>({id:'target',type:'rh-video',position:{x:500,y:0},data:{modelCode:'h3-first-frame-v1',subType:'start-video',params:{prompt:'Move gently.',text:'Earlier text cache',imageUrls:['rhtv-asset:old-image'],videoUrls:['rhtv-asset:old-reference-video'],audioUrls:[]},output:[{url:'rhtv-asset:old-result'}],videoUrl:'rhtv-asset:old-result',historyStorage:{source:'remote',schemaVersion:1,historyId:'old-execution',revision:'4',resultCount:1},nodeOutputHistory:[{id:'old-cache',outputs:[{url:'rhtv-asset:old-result'}]}],...patch}});
const image=(id:string,url:string)=>({id,type:'rh-image',position:{x:0,y:0},data:{sourceObjects:[url]}});
const edge=(source:string)=>({id:'edge-'+source,source,target:'target',sourceHandle:'output',targetHandle:'input'});

it('drops only native reference caches after disconnect while retaining the complete previous result and input draft',()=>{
 const target=video(),graph={nodes:[image('previous','rhtv-asset:old-image'),target],edges:[]},before=structuredClone(graph),native=nativeProject('target',graph.nodes,graph.edges);
 // q_ has no current media to invoke eJ for; the stale cache survives there.
 expect(native.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:old-image']);
 const projected=projectNativeVideoInputs(target,graph)!;expect(projected.error).toBeUndefined();expect(projected.references).toEqual({image:[],video:[],audio:[]});expect(projected.data.params.imageUrls).toEqual([]);expect(projected.data.params.videoUrls).toEqual([]);expect(projected.data.params.prompt).toBe('Move gently.');expect(projected.data.params.text).toBe('Earlier text cache');
 for(const key of ['output','videoUrl','historyStorage','nodeOutputHistory'])expect(projected.data[key]).toEqual((target.data as any)[key]);expect(graph).toEqual(before);
});
it('uses a newly connected source result rather than its ancestor references or the target previous output',()=>{
 const source:any=image('new-source','rhtv-asset:new-image');source.data.params={imageUrls:['rhtv-asset:ancestor']};const target=video(),graph={nodes:[image('ancestor','rhtv-asset:ancestor'),source,target],edges:[{id:'ancestor-edge',source:'ancestor',target:'new-source'},edge('new-source')]},projected=projectNativeVideoInputs(target,graph)!;
 expect(projected.error).toBeUndefined();expect(projected.references.image).toEqual(['rhtv-asset:new-image']);expect(projected.references.video).toEqual([]);expect(projected.data.output).toEqual(target.data.output);
});
it('keeps the direct API parameter fallback while requiring current canvas sources in the native mode',()=>{
 const target=video(),graph={nodes:[target],edges:[]};expect(nativeVideoReferences(target,graph,'image')).toEqual(['rhtv-asset:old-image']);expect(nativeVideoReferences(target,graph,'image',{nativeComposer:true})).toEqual([]);
});
it('does not substitute a stale cache for a connected image with no available output',()=>{
 const source={...image('source','rhtv-asset:current'),data:{}},target=video(),graph={nodes:[source,target],edges:[edge('source')]},projected=projectNativeVideoInputs(target,graph)!;
 expect(projected.error).toContain('图片');expect(projected.error).toContain('重新连接');expect(projected.data).toBe(target.data);source.data={sourceObjects:['rhtv-asset:current']};expect(projectNativeVideoInputs(target,graph)!.references.image).toEqual(['rhtv-asset:current']);
});
it.each(['remote','embedded'])('reads the displayed selected %s image result when reconnecting a generated node',history=>{
 const source:any=image('source','rhtv-asset:unused');source.data.output=[{url:'rhtv-asset:first',historyOutputId:'first-output'},{url:'rhtv-asset:selected',historyOutputId:'selected-output'}];
 if(history==='remote')source.data.selectedHistoryOutputId='selected-output';else Object.assign(source.data,{selectedOutputHistoryId:'local-cache',selectedOutputHistoryIndex:1,nodeOutputHistory:[{id:'local-cache',outputs:structuredClone(source.data.output)}]});
 const target=video(),graph={nodes:[source,target],edges:[edge('source')]};expect(projectNativeVideoInputs(target,graph)!.references.image).toEqual(['rhtv-asset:selected']);
});
it.each([['second::rhtv-asset:b','first::rhtv-asset:a'],['rhtv-asset:b','rhtv-asset:a'],['second','first'],[{nodeId:'second',url:'rhtv-asset:b'},{nodeId:'first',url:'rhtv-asset:a'}]].map(order=>({order})))('keeps the native canvas reference order $order',({order})=>{
 const target=video({imageOrder:order}),graph={nodes:[image('first','rhtv-asset:a'),image('second','rhtv-asset:b'),target],edges:[edge('first'),edge('second')]};expect(projectNativeVideoInputs(target,graph)!.references.image).toEqual(['rhtv-asset:b','rhtv-asset:a']);
});
it('retains explicit native inline references and rejects unuploaded mentions without discarding original data',()=>{
 const target=video({mentionAssets:[{type:'IMAGE',url:'rhtv-asset:inline-image'},{type:'VIDEO',url:'rhtv-asset:inline-video'},{type:'AUDIO',url:'rhtv-asset:inline-audio'},{type:'TEXT',text:'Quiet surroundings.'}]}),graph={nodes:[target],edges:[]},projected=projectNativeVideoInputs(target,graph)!;
 expect(projected.references).toEqual({image:['rhtv-asset:inline-image'],video:['rhtv-asset:inline-video'],audio:['rhtv-asset:inline-audio']});expect(projected.composedPrompt).toBe('Move gently.\nQuiet surroundings.');target.data.mentionAssets[0].url='blob:unuploaded';const blocked=projectNativeVideoInputs(target,graph)!;expect(blocked.error).toContain('图片');expect(blocked.data).toBe(target.data);
});
it('matches the real q_ text composition once, including current direct text, prompt-node filtering and inline text',()=>{
 const target=video({userPromptSnapshot:{paramName:'prompt',value:'Move gently.'},mentionAssets:[{type:'TEXT',text:' Quiet surroundings. '}]}),text={id:'text',type:'rh-text',position:{x:0,y:0},data:{text:'Current connected direction.',content:'Stale content cache'}},filtered={id:'filtered',type:'rh-text',position:{x:0,y:0},data:{text:'Already reflected in authored prompt.',_isPromptTextNode:true}},graph={nodes:[text,filtered,target],edges:[edge('text'),edge('filtered')]},command=nativeProject('target',graph.nodes,graph.edges),composed=command.nodes[0].data.params.prompt;
 expect(nativeVideoComposedPrompt('Move gently.',target,graph)).toBe(composed);expect(composed).toBe('Move gently.\nCurrent connected direction.\nQuiet surroundings.');
 const normalized=normalizeNativeVideoPrompt(command.nodes[0].data,target,graph);expect(normalized.params.prompt).toBe('Move gently.');const projected=projectNativeVideoInputs({...target,data:command.nodes[0].data},graph)!;expect(projected.data.params.prompt).toBe('Move gently.');expect(projected.composedPrompt).toBe(composed);
 // Disconnecting or replacing the text source never imports the old source's
 // prompt; the mounted authored input remains intact throughout both edits.
 const disconnected={...graph,edges:[]};expect(projectNativeVideoInputs(target,disconnected)!.composedPrompt).toBe('Move gently.\nQuiet surroundings.');text.data.text='A replacement connected direction.';expect(projectNativeVideoInputs(target,graph)!.composedPrompt).toBe('Move gently.\nA replacement connected direction.\nQuiet surroundings.');
});
it('preserves a newly authored prompt and fails closed if current rich text cannot use the native serializer',()=>{
 const target=video({userPromptSnapshot:{paramName:'prompt',value:'Earlier input.'}}),text={id:'text',type:'rh-text',position:{x:0,y:0},data:{text:'<p>Current text.</p>'}},graph={nodes:[text,target],edges:[edge('text')]};
 expect(projectNativeVideoInputs(target,graph)!.error).toContain('文字');expect(nativeVideoComposedPrompt('Move gently.',target,graph,()=>{throw Error('serializer unavailable');})).toBeUndefined();const projected=projectNativeVideoInputs(target,graph,()=> 'Current text.')!;expect(projected.data.params.prompt).toBe('Move gently.');expect(projected.composedPrompt).toBe('Move gently.\nCurrent text.');
});
it.each([{isUpload:true},{localVideoEdit:true},{isStoryboard:true},{toolsSourceUrl:'rhtv-asset:direct-tool'},{sourceNodeId:'tool-source'},{autoCreatedByAiApp:true}])('leaves unreviewed direct or specialized video input paths untouched: %j',patch=>{
 const target=video(patch);expect(projectNativeVideoInputs(target,{nodes:[target],edges:[]})).toBeUndefined();
});
it('completes the exact zero-edge native projection after disconnection without accepting a hidden incoming edge',()=>{
 const target=video(),other=image('unconnected','rhtv-asset:other'),baseline={nodes:[other,target],edges:[]},command={nodes:[structuredClone(target)],edges:[]};expect(completeNativeVideoCommand(command,baseline,'target')).toEqual(baseline);
 const connected={...baseline,edges:[edge('unconnected')]};expect(completeNativeVideoCommand(command,connected,'target')).toEqual(command);
});
it('completes current direct native edges including a generated reference ancestor and rejects stale reconnected pairs',()=>{
 const ancestor=image('ancestor','rhtv-asset:ancestor'),source=image('source','rhtv-asset:current'),target=video(),baseline={nodes:[ancestor,source,target],edges:[{id:'ancestor-edge',source:'ancestor',target:'source'},edge('source')]},command={nodes:[structuredClone(target),structuredClone(source)],edges:[{source:'source',target:'target'}]};
 expect(completeNativeVideoCommand(command,baseline,'target')).toEqual(baseline);const stale={...command,edges:[{source:'ancestor',target:'target'}]};expect(completeNativeVideoCommand(stale,baseline,'target')).toEqual(stale);
});
