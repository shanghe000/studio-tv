import {expect,it} from 'vitest';
import {generationReadinessNodeIds,inspectCanvasConnection,nodeReadinessMaterials} from '../../apps/web/src/service/connection-readiness';
import {projectNativeVideoInputs} from '../../apps/web/src/service/video-command';
const cap=(kind='IMAGE_TO_IMAGE',inputs=['TEXT','IMAGE'],limits:any={IMAGE:1}):any=>({capabilityRef:'model',version:'1',kind,available:true,testMode:false,inputKinds:inputs,model:{providerRef:'supplier',modelRef:'actual',version:'1'},parameterSchema:{'x-media-limits':limits}});
const node=(id:string,type='rh-image',data:any={}):any=>({id,type,position:{x:0,y:0},data});
const target=(data:any={})=>node('target','rh-image',{modelCode:'model',...data});
const image=(id:string,refs=['rhtv-asset:'+id])=>node(id,'rh-image',{isUpload:true,sourceObjects:refs});
it.each(['self','duplicate','cycle','source-port','target-port'])('rejects invalid %s topology before native mutation',change=>{
 const graph:any={nodes:[image('source'),target(),image('middle')],edges:[]},connection:any={source:'source',target:'target'};
 if(change==='self')connection.target='source';if(change==='duplicate')graph.edges.push({source:'source',target:'target'});if(change==='cycle')graph.edges.push({source:'target',target:'middle'},{source:'middle',target:'source'});if(change==='source-port')connection.sourceHandle='input';if(change==='target-port')connection.targetHandle='output';
 expect(inspectCanvasConnection(connection,graph,[cap()]).allowed).toBe(false);
});
it('rejects audio into a first-frame model although the native node-type matrix permits video targets',()=>{
 const graph:any={nodes:[node('audio','rh-audio',{audioUrl:'rhtv-asset:audio'}),node('target','rh-video',{modelCode:'model'})],edges:[]};
 expect(inspectCanvasConnection({source:'audio',target:'target'},graph,[cap('IMAGE_TO_VIDEO',['TEXT','IMAGE'])])).toMatchObject({allowed:false,code:'MODEL_INPUT_UNSUPPORTED'});
});
it('counts actual source assets, including separate source nodes that point to the same asset',()=>{
 const graph:any={nodes:[image('source',['rhtv-asset:a','rhtv-asset:b']),target()],edges:[]};expect(inspectCanvasConnection({source:'source',target:'target'},graph,[cap()]).allowed).toBe(false);
 graph.nodes=[image('source',['rhtv-asset:a']),image('second',['rhtv-asset:a']),target()];graph.edges=[{source:'source',target:'target'}];expect(inspectCanvasConnection({source:'second',target:'target'},graph,[cap()]).allowed).toBe(false);
});
it('permits adding the missing video when the independent image limit is already full',()=>{
 const graph:any={nodes:[image('image'),node('video','rh-video',{sourceObjects:['rhtv-asset:video']}),node('target','rh-video',{modelCode:'model'})],edges:[{source:'image',target:'target'}]};
 expect(inspectCanvasConnection({source:'video',target:'target'},graph,[cap('VIDEO_TO_VIDEO',['IMAGE','VIDEO'],{IMAGE:1,VIDEO:1})])).toMatchObject({allowed:true,needsInspection:true});
});
it('does not count a stale native parameter cache on top of direct incoming images',()=>{
 const graph:any={nodes:[image('source'),target({params:{imageUrls:['rhtv-asset:old-a','rhtv-asset:old-b']}})],edges:[]};
 expect(inspectCanvasConnection({source:'source',target:'target'},graph,[cap()]).allowed).toBe(true);
});
it('blocks known oversized assets but leaves unknown metadata for the asynchronous inspector',()=>{
 const profile=cap();profile.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576}}};const graph:any={nodes:[image('source'),target()],edges:[]};
 expect(inspectCanvasConnection({source:'source',target:'target'},graph,[profile])).toMatchObject({allowed:true,needsInspection:true});
 expect(inspectCanvasConnection({source:'source',target:'target'},graph,[profile],{assets:new Map([['source',{id:'source',kind:'IMAGE',state:'READY',byteSize:11*1048576} as any]])})).toMatchObject({allowed:false,code:'MEDIA_INPUT_INVALID'});
});
it('does not substitute a latest schema for an unresolved historical selected model',()=>{
 const graph:any={nodes:[image('source'),target({capabilityVersion:'older'})],edges:[]};expect(inspectCanvasConnection({source:'source',target:'target'},graph,[cap()])).toEqual({allowed:true,needsInspection:true});
});
it('preserves unknown selected history as pending inspection',()=>{
 const source=image('source');source.data.selectedOutputHistoryId='history';const graph:any={nodes:[source,target()],edges:[{source:'source',target:'target'}]};expect(nodeReadinessMaterials(graph.nodes[1],graph)[0].pending).toBe(true);
});
it('expands nested generation groups without treating uploaded sources as jobs',()=>{
 const graph:any={nodes:[node('g','group',{nodeIds:['a','nested','upload']}),node('a'),node('nested','group'),{...node('b','rh-video'),parentId:'nested'},image('upload')],edges:[]};expect(generationReadinessNodeIds(graph,'g')).toEqual(['a','b']);
});

it('shares the generation inspector material classifier for unbound legacy sources in groups and direct targets',()=>{
 const legacy=node('legacy','rh-image',{sourceObjects:['rhtv-asset:existing']}),generated=node('generated','rh-image',{sourceObjects:['rhtv-asset:old-result'],modelCode:'model',params:{prompt:'Continue editing'}}),graph:any={nodes:[node('group','group',{nodeIds:['legacy','generated']}),legacy,generated],edges:[]};
 expect(generationReadinessNodeIds(graph,'group')).toEqual(['generated']);expect(generationReadinessNodeIds(graph,'legacy')).toEqual([]);expect(generationReadinessNodeIds(graph,'generated')).toEqual(['generated']);
});

it('allows a new text connection after switching to text-video despite disconnected media execution caches',()=>{
 const video=node('target','rh-video',{modelCode:'model',subType:'text-video',params:{imageUrls:['rhtv-asset:old-image'],videoUrls:['rhtv-asset:old-video']}}),text=node('text','rh-text',{text:'New direction'}),graph:any={nodes:[text,video],edges:[]},profile=cap('TEXT_TO_VIDEO',['TEXT'],{IMAGE:0,VIDEO:0});profile.parameterSchema['x-video-mode']='TEXT_TO_VIDEO';
 expect(nodeReadinessMaterials(video,graph)).toEqual([]);expect(projectNativeVideoInputs(video,graph)?.references).toEqual({image:[],video:[],audio:[]});
 expect(inspectCanvasConnection({source:'text',target:'target'},graph,[profile])).toMatchObject({allowed:true});
});

it.each(['IMAGE','VIDEO','AUDIO'])('counts inline %s references before allowing another connection of that kind',kind=>{
 const source=node('source','rh-'+kind.toLowerCase(),{sourceObjects:['rhtv-asset:new']}),video=node('target','rh-video',{modelCode:'model',mentionAssets:[{type:kind,url:'rhtv-asset:inline'}]}),graph:any={nodes:[source,video],edges:[]};
 expect(inspectCanvasConnection({source:'source',target:'target'},graph,[cap('VIDEO_TO_VIDEO',[kind],{[kind]:1})])).toMatchObject({allowed:false,code:'MODEL_INPUT_UNSUPPORTED'});
});

it.each(['remote','embedded'])('uses the same selected %s output as native generation while checking a proposed edge',history=>{
 const source=image('source');source.data.output=[{url:'rhtv-asset:oversized',historyOutputId:'old'},{url:'rhtv-asset:selected',historyOutputId:'chosen'}];
 if(history==='remote')source.data.selectedHistoryOutputId='chosen';else Object.assign(source.data,{selectedOutputHistoryId:'batch',selectedOutputHistoryIndex:1,nodeOutputHistory:[{id:'batch',outputs:structuredClone(source.data.output)}]});
 const video=node('target','rh-video',{modelCode:'model'}),graph:any={nodes:[source,video],edges:[{source:'source',target:'target'}]};
 expect(nodeReadinessMaterials(video,graph).map(row=>row.reference)).toEqual(projectNativeVideoInputs(video,graph)?.references.image);expect(nodeReadinessMaterials(video,graph)[0].reference).toBe('rhtv-asset:selected');
});

it('blocks the same asset in two frame roles even when the two source nodes are distinct',()=>{
 const profile=cap('IMAGE_TO_VIDEO',['TEXT','IMAGE'],{IMAGE:2});profile.parameterSchema['x-video-mode']='FIRST_LAST_FRAME';
 const graph:any={nodes:[image('a',['rhtv-asset:same']),image('b',['rhtv-asset:same']),node('target','rh-video',{modelCode:'model'})],edges:[{source:'a',target:'target'}]};
 expect(inspectCanvasConnection({source:'b',target:'target'},graph,[profile])).toMatchObject({allowed:false,reason:expect.stringContaining('首尾帧')});graph.nodes[1].data.sourceObjects=['rhtv-asset:different'];expect(inspectCanvasConnection({source:'b',target:'target'},graph,[profile]).allowed).toBe(true);
});

it('identifies an oversized photo or incompatible format before attaching it as a model reference',()=>{
 const graph:any={nodes:[image('source'),target()],edges:[]},connection={source:'source',target:'target'};
 const check=(mimeType:string,byteSize:number)=>inspectCanvasConnection(connection,graph,[cap()],{assets:new Map([['source',{id:'source',kind:'IMAGE',state:'READY',fileName:'素材.jpg',mimeType,byteSize} as any]])});
 expect(check('image/jpeg',11*1048576)).toMatchObject({allowed:false,reason:expect.stringContaining('“素材.jpg”为 11 MiB')});
 expect(check('image/gif',512)).toMatchObject({allowed:false,code:'MEDIA_INPUT_INVALID'});
 expect(check('image/jpeg',10*1048576)).toMatchObject({allowed:true});
});
