import {describe,it,expect} from 'vitest';
import {encodeGraph,decodeGraph,META_NODE,META_TYPE} from '../../apps/web/src/service/graph';
describe('native graph boundary',()=>{
 it('retains groups, native dimensions, edge bindings and metadata through frozen graph schema',()=>{
  const native={nodes:[{id:'g',type:'group',position:{x:1,y:2},style:{width:600,height:400},data:{name:'group'}},{id:'n',type:'rh-image',position:{x:4,y:5},parentId:'g',extent:'parent',width:320,height:240,data:{sources:[{url:'https://media.local/a?token=expired'}],binding:{sourceNodeId:'g'}}}],edges:[{id:'e',source:'g',target:'n',sourceHandle:'out',targetHandle:'in',type:'custom',animated:true,data:{binding:'input'}}],meta:{id:'prj',name:'Demo',description:'保持文本',viewport:{x:3,y:4,zoom:0.8}}};
  const graph=encodeGraph(native,url=>url.startsWith('https://media.local/')?'rhtv-asset:asset_1':url);
  expect(Object.keys(graph)).toEqual(['schemaVersion','nodes','edges','viewport']);
  expect(Object.keys(graph.nodes[1])).toEqual(['id','type','position','data']);
  expect(graph.nodes.at(-1)?.id).toBe(META_NODE);
  const restored=decodeGraph(graph,url=>url==='rhtv-asset:asset_1'?'https://media.local/a?token=new':url);
  expect(restored.nodes[1]).toMatchObject({parentId:'g',extent:'parent',width:320,height:240});
  // Decoding must retain refreshed owned URLs, never recursively scrub them again.
  expect(restored.nodes[1].data.sources[0].url).toBe('https://media.local/a?token=new');
  expect(restored.edges[0]).toMatchObject({type:'custom',animated:true,data:{binding:'input'}});
  expect(restored.meta).toMatchObject({id:'prj',name:'Demo',description:'保持文本'});
 });
 it('strips provider credential strings while preserving boolean schema fields',()=>{
  const graph=encodeGraph({nodes:[{id:'n',type:'app',position:{x:0,y:0},data:{platformKey:'secret-value',password:'secret',needPassword:false,config:{apiKey:'x',enabled:true}}}],edges:[]});
  expect(graph.nodes[0].data).toMatchObject({needPassword:false,config:{enabled:true}});
  expect(JSON.stringify(graph)).not.toContain('secret');
 });
 it('retains preset definitions when the same URL is also an owned model reference',()=>{
  const url='https://catalog.invalid/style.png',preset={key:'styleLibrary',id:'cinematic_realism',prompt:'cinematic realism',coverUrl:url,referenceImageUrl:url};
  const graph=encodeGraph({nodes:[{id:'n',type:'rh-script',position:{x:0,y:0},data:{params:{imageUrls:[url]},presetSelections:[preset],promptSelection:{presetSelections:[preset]}}}],edges:[]},value=>value===url?'rhtv-asset:owned':value);
  expect(graph.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:owned']);
  const restored=decodeGraph(graph,value=>value===url?'rewritten-metadata':value==='rhtv-asset:owned'?'https://studio.invalid/owned':value);
  expect(restored.nodes[0].data.presetSelections).toEqual([preset]);
  expect(restored.nodes[0].data.promptSelection.presetSelections).toEqual([preset]);
  expect(restored.nodes[0].data.params.imageUrls).toEqual(['https://studio.invalid/owned']);
 });
 it('rejects transient media, reserved IDs, duplicate IDs and unsafe prototype data',()=>{
  const base={id:'n',type:'image',position:{x:0,y:0},data:{}};
  expect(()=>encodeGraph({nodes:[{...base,data:{url:'blob:temporary'}}],edges:[]})).toThrow('未上传');
  expect(()=>encodeGraph({nodes:[{...base,id:META_NODE}],edges:[]})).toThrow('保留');
  expect(()=>encodeGraph({nodes:[{...base,type:META_TYPE}],edges:[]})).toThrow('保留');
  expect(()=>encodeGraph({nodes:[base,base],edges:[]})).toThrow('重复');
  expect(()=>encodeGraph({nodes:[{...base,data:JSON.parse('{"__proto__":{"pwned":true}}')}],edges:[]})).toThrow('不允许');
 });
});

it('round-trips native first-last video long edge IDs through the frozen 64-character ID boundary',()=>{
 const edge='e-node_1791386592643_3ll8x0g_first-node_1791386592643_vrv8bk2_video',nodes=['first','video'].map(id=>({id,type:'rh-video',position:{x:0,y:0},data:{}}));
 const native={nodes,meta:{viewport:{x:0,y:0,zoom:1}},edges:[{id:edge,source:'first',target:'video',conditioningRole:'FIRST_FRAME'}]},saved=encodeGraph(native);
 expect(saved.edges[0].id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);expect(decodeGraph(saved).edges[0]).toMatchObject(native.edges[0]);expect(encodeGraph(decodeGraph(saved))).toEqual(saved);
});
