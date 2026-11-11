import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
import {nativeImageComposedPrompt,normalizeNativeImagePrompt} from '../../apps/web/src/service/image-prompt-projection';
const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const fn=(name:string,next:string)=>frozen.slice(frozen.indexOf('function '+name+'('),frozen.indexOf(next,frozen.indexOf('function '+name+'(')));
const compose=runInNewContext([fn('_M','function dw('),fn('iW','function sW('),fn('sW','function DD('),fn('par','const mar=')].join('\n')+';Cye');
it.each([
 {params:{prompt:'  a fox  '}},
 {params:{prompt:'a fox'},presetSelections:[{key:'filter',prompt:'  soft light  '},{key:'camera',prompt:'wide view'}]},
 {params:{prompt:'a fox'},presetSelections:[{key:'customPrompt',prefix:'start',suffix:'end',prompt:'not used'},{key:'styleLibrary',prompt:'paint',suffixPrompt:'brush'}]},
 {params:{prompt:'a fox'},presetSelections:[{key:'roleDesign:face:expression',promptCode:'studio-role-face-smile-v1',prefixPrompt:'not client authority'},{key:'filter',name:'none',prompt:'must be skipped'}]},
 {params:{prompt:''},cameraControl:{chunk:'camera',selection:{cameraId:'A'},presetId:'default'}},
 {params:{prompt:'a fox'},presetSelections:[{key:'filter',prompt:'soft'}],cameraControl:{chunk:'camera'}},
])('matches the frozen composer exactly for public USER conditions %j',data=>{
 const raw=data.params.prompt,result=compose(raw,data.presetSelections),camera=data.cameraControl?.chunk||'';
 expect(nativeImageComposedPrompt(raw,data)).toBe(result+(camera?(result?'\n':'')+camera:''));
 const command={...data,params:{prompt:nativeImageComposedPrompt(raw,data),text:nativeImageComposedPrompt(raw,data)},prompt:nativeImageComposedPrompt(raw,data),userPromptSnapshot:{paramName:'prompt',value:raw}};
 expect(normalizeNativeImagePrompt(command)).toMatchObject({params:{prompt:raw,text:raw},prompt:raw});expect(command.params.prompt).toBe(nativeImageComposedPrompt(raw,data));
});
it('removes only the frozen role-design display block and preserves user text separately',()=>{
 const raw='fox\n\n【角色设计开始】\nsmile\n【角色设计结束】',data={presetSelections:[{key:'roleDesign:face:expression',promptCode:'studio-role-face-smile-v1'}]};
 expect(nativeImageComposedPrompt(raw,data)).toBe('fox');expect(normalizeNativeImagePrompt({...data,userPromptSnapshot:{paramName:'prompt',value:raw},params:{prompt:'fox'}}).params.prompt).toBe(raw);
});
it('does not normalize unknown prompt changes or snapshots',()=>{
 for(const data of [{params:{prompt:'forged'},userPromptSnapshot:{paramName:'prompt',value:'real'}},{params:{prompt:'real'},userPromptSnapshot:{paramName:'text',value:'real'}},{params:{prompt:'real'}}])expect(normalizeNativeImagePrompt(data)).toBe(data);
});
it('disabling camera conditions removes their text instead of retaining a previous chunk',()=>{
 expect(nativeImageComposedPrompt('fox',{cameraControl:{chunk:'',selection:{cameraId:'saved'},presetId:'saved'}})).toBe('fox');
});

const selectedTextFixture=JSON.parse(readFileSync(new URL('./fixtures/native-selected-text-image-command.json',import.meta.url),'utf8'));
const nativeDirectCommand=(graph:any,targetId:string)=>{
 // Run the actual q_ direct-source projection and eQr final prompt aliases.
 // Unrelated media/model adapters are inert in this plain-text fixture.
 const q=runInNewContext(fn('q_','function eQr(')+';q_',{ADe:structuredClone,dw:()=>[],nNn:()=> 'prompt',sd:(id:string,nodes:any[],edges:any[])=>edges.filter(e=>e.target===id).map(e=>nodes.find(n=>n.id===e.source)),As:(type:string)=>type==='rh-text',dJ:(node:any)=>node.data.text||node.data.content||'',cJ:()=>[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],aNn:()=>{},oft:()=>false,eft:()=>false,dNn:(params:any)=>params,hM:()=>'',sft:()=>[],_t:{IMAGE_URLS:'imageUrls'},J1e:()=>false,fNn:new Set()});
 const eQr=runInNewContext(fn('eQr','function tQr(')+';eQr');
 const target=graph.nodes.find((n:any)=>n.id===targetId),own=nativeImageComposedPrompt(target.data.params.prompt,target.data),command=q(targetId,graph.nodes,graph.edges,{promptOverride:own});
 const result=command.nodes.find((n:any)=>n.id===targetId);result.data.userPromptSnapshot={paramName:'prompt',value:target.data.params.prompt};eQr(command,targetId,result.data.params.prompt);return command;
};
it('recomputes the captured selected-text q_ command and restores only the raw target prompt',()=>{
 const {baseline,targetId}=selectedTextFixture,command=nativeDirectCommand(baseline,targetId),target=command.nodes[0];
 expect(target.data.params).toEqual(selectedTextFixture.command.nodes[0].data.params);
 expect(nativeImageComposedPrompt('',baseline.nodes.find((n:any)=>n.id===targetId).data,baseline.nodes.find((n:any)=>n.id===targetId),baseline)).toBe('STUDIOTV生成入口验收通过');
 expect(normalizeNativeImagePrompt(target.data,target,command)).toMatchObject({params:{prompt:'',text:'',outputPreset:'1024-square'},prompt:''});
 expect(target.data.params.prompt).toBe('STUDIOTV生成入口验收通过');
});
it('matches q_ direct order, whitespace and Agent prompt-source suppression with authored presets',()=>{
 const target={id:'target',type:'rh-image',data:{subType:'text-image',params:{prompt:'raw user'},presetSelections:[{key:'filter',prompt:'soft light'}],cameraControl:{chunk:'camera'}}},source=(id:string,text:string,extra:any={})=>({id,type:'rh-text',data:{text,...extra}});
 const graph={nodes:[target,source('b','  second  '),source('a','first'),source('prompt','already included',{_isPromptTextNode:true}),source('agent','already included',{agentCreated:true,title:'电影提示词'})],edges:[{source:'a',target:'target'},{source:'prompt',target:'target'},{source:'b',target:'target'},{source:'agent',target:'target'}]};
 const command=nativeDirectCommand(graph,'target'),composed=nativeImageComposedPrompt('raw user',target.data,target,graph);
 expect(composed).toBe('soft light\nraw user\ncamera\nfirst\n  second  ');expect(command.nodes[0].data.params.prompt).toBe(composed);
 expect(normalizeNativeImagePrompt(command.nodes[0].data,command.nodes[0],command).params.prompt).toBe('raw user');
});
it('includes prompt-text sources when the native user prompt is empty and ignores non-direct ancestors',()=>{
 const target={id:'target',type:'rh-image',data:{subType:'text-image',params:{prompt:''}}},source={id:'direct',type:'rh-text',data:{text:'excerpt',_isPromptTextNode:true}},ancestor={id:'ancestor',type:'rh-text',data:{text:'not appended by q_'}};
 const graph={nodes:[target,source,ancestor],edges:[{source:'ancestor',target:'direct'},{source:'direct',target:'target'}]};
 expect(nativeImageComposedPrompt('',target.data,target,graph)).toBe('excerpt');
});
it.each(['changed-text','changed-edge','conditioned','wrong-handle','duplicate-source','missing-source','rich-text','selected-history','tool','mentions'])('does not normalize an ambiguous or changed %s upstream projection',change=>{
 const {baseline,targetId}=structuredClone(selectedTextFixture),target=baseline.nodes.find((n:any)=>n.id===targetId),source=baseline.nodes.find((n:any)=>n.id===selectedTextFixture.command.nodes[1].id),command=structuredClone(selectedTextFixture.command),submitted=command.nodes[0];
 if(change==='changed-text')source.data.text='new edit';
 if(change==='changed-edge')baseline.edges=baseline.edges.filter((e:any)=>e.target!==targetId);
 if(change==='conditioned')baseline.edges.find((e:any)=>e.target===targetId).conditioningRole='STYLE';
 if(change==='wrong-handle')baseline.edges.find((e:any)=>e.target===targetId).sourceHandle='other';
 if(change==='duplicate-source')baseline.edges.push({...baseline.edges.find((e:any)=>e.target===targetId)});
 if(change==='missing-source')baseline.nodes=baseline.nodes.filter((n:any)=>n.id!==source.id);
 if(change==='rich-text')source.data.text='<p>STUDIOTV生成入口验收通过</p>';
 if(change==='selected-history')source.data.selectedHistoryOutputId='other-output';
 if(change==='tool')target.data.toolsType='IMAGE_IMAGE';
 if(change==='mentions')target.data.mentionAssets=[{type:'TEXT',text:'extra'}];
 // Normalize against the captured source context, never a matching-looking
 // submitted string in isolation. The semantic guard still checks all fields.
 expect(normalizeNativeImagePrompt(submitted.data,{...target,data:{...target.data,...submitted.data}},baseline)).toBe(submitted.data);
});
