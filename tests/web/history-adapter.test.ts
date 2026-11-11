import {describe,expect,it,vi} from 'vitest';
import {HistoryAdapter,type HistoryOutput} from '../../apps/web/src/service/history';
import {ProductClient} from '../../apps/web/src/service/product-client';

const at='2026-10-05T08:00:00.000Z';
const asset=(id:string,mimeType='image/png'):HistoryOutput=>({id,type:'ASSET',assetId:'asset_'+id,mimeType});
const plan=(id:string,taskId:string,outputs:HistoryOutput[],testMode=false)=>({id,executionId:id,taskId,projectId:'project_real',nodeId:'node_'+id,revision:7,createdAt:at,testMode,outputs,paramsSnapshot:{prompt:'Saved prompt'},nodeConfigSnapshot:{data:{title:'Saved node'}}});
const reply=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200,headers:{'Content-Type':'application/json'}});
const fileName=(mime:string)=>mime.startsWith('image/')?'saved.png':mime.startsWith('video/')?'saved.mp4':mime.startsWith('audio/')?'saved.wav':mime==='model/gltf-binary'?'saved.glb':mime==='model/gltf+json'?'saved.gltf':mime==='application/x-ply'?'saved.ply':mime==='application/x-splat'?'saved.splat':'saved.spz';
function setup(plans:ReturnType<typeof plan>[],options:{pageRevision?:(page:number)=>number;history?:(url:URL,init:RequestInit)=>Response|Promise<Response>;project?:(raw:HistoryOutput,testMode:boolean)=>Promise<any>}={}){
 const mapped=vi.fn(),transport=vi.fn(async(input:any,init:RequestInit={})=>{
  const url=new URL(String(input),'https://studio.invalid');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer owner-a');
  if(url.pathname==='/api/v2/history'){
   if(options.history)return options.history(url,init);
   const page=Number(url.searchParams.get('page'));expect(url.searchParams.get('size')).toBe('100');expect(url.searchParams.has('type')).toBe(false);
   return reply({records:plans.slice((page-1)*100,page*100),page,size:100,total:plans.length,hasNext:page*100<plans.length,revision:options.pageRevision?.(page)??11});
  }
  const output=plans.flatMap(plan=>plan.outputs).find(output=>url.pathname==='/api/v1/assets/'+output.assetId);if(!output)throw new Error('Unexpected '+url.pathname);
  return reply({id:output.assetId,state:'READY',fileName:fileName(output.mimeType!),mimeType:output.mimeType,downloadUrl:'/api/v1/media/'+output.assetId,previewUrl:null});
 });
 const api=new ProductClient('/api/v1',transport as typeof fetch);api.setAccessToken('owner-a');
 const project=vi.fn(options.project|| (async(raw:HistoryOutput,testMode:boolean)=>{
  if(raw.type==='TEXT')return{outputId:raw.id,text:raw.text,testMode};if(raw.type==='STRUCTURED')return{outputId:raw.id,data:raw.data,schemaVersion:raw.schemaVersion,testMode};
  const stored=(await api.request<any>('/assets/'+raw.assetId)).data;return{outputId:raw.id,assetId:stored.id,mimeType:stored.mimeType,fileName:stored.fileName,url:stored.downloadUrl,thumbnailUrl:stored.previewUrl,testMode};
 }));
 return{api,transport,project,mapped,adapter:new HistoryAdapter(api,project,mapped)};
}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

describe('actual output-level history pages',()=>{
 it('separates authorized video posters from original playback/import URLs while preserving real image thumbnails',async()=>{
  const rows=[plan('mixed','task_media',[asset('video','video/mp4'),asset('image')])],video='https://studio.invalid/storage/assets/asset_video?token=real-grant',image='/storage/assets/asset_image?token=image-grant',thumbnail='/storage/assets/image_thumb?token=image-thumb';
  const {adapter}=setup(rows,{project:async raw=>({outputId:raw.id,assetId:raw.assetId,mimeType:raw.mimeType,fileName:fileName(raw.mimeType!),url:raw.id==='video'?video:image,thumbnailUrl:raw.id==='image'?thumbnail:undefined})});
  const records=(await adapter.list({onlyImageVideo:true},true)).records,[v,i]=records;
  expect(v).toMatchObject({resultUrl:video,url:video,fileUrl:video,resultType:'VIDEO',thumbnail:video+'&ci-process=snapshot&time=0&format=jpg&width=240&quality=72&minisize=1'});expect(v.thumbnailUrl).toBe(v.thumbnail);expect(v.thumbnail).not.toBe(video);
  expect(i).toMatchObject({resultUrl:image,url:image,fileUrl:image,thumbnail,thumbnailUrl:thumbnail});
 });
 it('does not turn an unsupported video source into a misleading image thumbnail',async()=>{
  const {adapter}=setup([plan('legacy','task_legacy',[asset('legacy_video','video/mp4')])]);const video=(await adapter.list({type:'VIDEO'})).records[0];
  expect(video.resultUrl).toBe('/api/v1/media/asset_legacy_video');expect(video.thumbnail).toBeUndefined();expect(video.thumbnailUrl).toBeUndefined();
 });
 it('restores manual and realtime 2D history from persisted prompt conditions without inventing modes for unrelated image results',async()=>{
  const manual=plan('manual','task_manual',[asset('manual')]),live=plan('live','task_live',[asset('live')]),ordinary=plan('ordinary','task_ordinary',[asset('ordinary')]);
  manual.nodeConfigSnapshot.data={...manual.nodeConfigSnapshot.data,promptSelection:{schemaVersion:'1',featureCode:'sketchboard.generate',conditions:{generationMode:'manual'}}} as any;
  live.nodeConfigSnapshot.data={...live.nodeConfigSnapshot.data,promptSelection:{schemaVersion:'1',conditions:{generationMode:'live'}}} as any;
  ordinary.nodeConfigSnapshot.data={...ordinary.nodeConfigSnapshot.data,promptSelection:{schemaVersion:'1',conditions:{generationMode:'unexpected'}}} as any;
  const {adapter}=setup([manual,live,ordinary]),page=await adapter.list({canvasId:'project_real',type:'IMAGE'});
  expect(page.records.find(row=>row.taskId==='task_manual')).toMatchObject({generationMode:'manual',id:'manual',resultUrl:'/api/v1/media/asset_manual'});expect(page.records.find(row=>row.taskId==='task_live')).toMatchObject({generationMode:'live'});expect(page.records.find(row=>row.taskId==='task_ordinary')).not.toHaveProperty('generationMode');
  // Frozen SketchStudio's Qg uses exactly this missing-mode-to-live rule.
  expect(page.records.filter(row=>(row.generationMode==='manual'?'manual':'live')==='manual').map(row=>row.id)).toEqual(['manual']);
 });
 it('preserves a valid legacy 2D mode over a newer condition while ignoring invalid values',async()=>{
  const legacy=plan('legacy','task_legacy',[asset('legacy')]);legacy.nodeConfigSnapshot.data={...legacy.nodeConfigSnapshot.data,generationMode:'live',promptSelection:{conditions:{generationMode:'manual'}}} as any;
  const {adapter}=setup([legacy]);expect((await adapter.list({type:'IMAGE'})).records[0].generationMode).toBe('live');
 });
 it('reads all plan pages, counts filtered outputs and resolves only the selected actual assets',async()=>{
  const rows=Array.from({length:102},(_,index)=>plan('execution_'+index,'task_'+index,[asset('image_'+index),asset('video_'+index,'video/mp4')]));
  rows[0].outputs.push({id:'text_0',type:'TEXT',text:'Saved text'},asset('audio_0','audio/wav'));
  const {adapter,transport,project,mapped}=setup(rows),page=await adapter.list({canvasId:'project_real',type:'IMAGE',page:2,size:3});
  expect(page).toMatchObject({total:102,current:2,size:3,pages:34,hasNext:true,revision:'11'});expect(page.records.map(row=>row.id)).toEqual(['image_3','image_4','image_5']);
  expect(project).toHaveBeenCalledTimes(3);expect(transport.mock.calls.filter(([url])=>String(url).startsWith('/api/v2/history'))).toHaveLength(2);expect(transport.mock.calls.filter(([url])=>String(url).startsWith('/api/v1/assets/'))).toHaveLength(3);
  expect(page.records[0]).toMatchObject({id:'image_3',resultUrl:'/api/v1/media/asset_image_3',resultType:'IMAGE',taskId:'task_3',taskPlanId:'execution_3',createTime:Date.parse(at)});
  expect(mapped.mock.calls).toEqual([['image_3',{historyId:'execution_3',outputId:'image_3'}],['image_4',{historyId:'execution_4',outputId:'image_4'}],['image_5',{historyId:'execution_5',outputId:'image_5'}]]);
  expect(new URL(String(transport.mock.calls[0][0]),'https://studio.invalid').searchParams.get('projectId')).toBe('project_real');
 });
 it('maps current mesh and world MIME values to TDM/SPZ without forwarding broken SQL type prefixes',async()=>{
  const rows=[plan('execution_files','task_files',[asset('mesh_glb','model/gltf-binary'),asset('mesh_gltf','model/gltf+json'),asset('world_spz','application/x-spz'),asset('world_ply','application/x-ply'),asset('world_splat','application/x-splat'),asset('audio','audio/mpeg')])];
  const {adapter}=setup(rows),meshes=await adapter.list({type:'GLB'}),worlds=await adapter.list({type:'SPZ'}),audio=await adapter.list({type:'AUDIO'});
  expect(meshes.total).toBe(2);expect(meshes.records.map(row=>row.resultType)).toEqual(['GLB','GLTF']);expect(meshes.records.map(row=>row.nativeType)).toEqual(['TDM','TDM']);expect(worlds.total).toBe(3);expect(worlds.records.map(row=>row.fileName)).toEqual(['saved.spz','saved.ply','saved.splat']);expect(audio.total).toBe(1);expect(audio.records[0].resultType).toBe('AUDIO');
 });
 it('filters onlyImageVideo exactly and preserves persisted text/structured values and TEST MODE markers',async()=>{
  const data={scene:'Saved scene',shots:[1,2]},rows=[plan('execution_mixed','task_mixed',[asset('image'),asset('video','video/mp4'),asset('audio','audio/wav'),{id:'text',type:'TEXT',text:'Saved text'},{id:'structured',type:'STRUCTURED',data,schemaVersion:'1'}],true)];
  const {adapter,project}=setup(rows),media=await adapter.list({onlyImageVideo:true});expect(media.total).toBe(2);expect(media.records.map(row=>row.resultType)).toEqual(['IMAGE','VIDEO']);expect(project).toHaveBeenCalledTimes(2);
  const text=await adapter.list({type:'TEXT'}),structured=await adapter.list({type:'STRUCTURED'});expect(text.records[0]).toMatchObject({id:'text',text:'[TEST MODE] Saved text',testMode:true,customBadgeText:'TEST MODE'});expect(structured.records[0]).toMatchObject({id:'structured',data,schemaVersion:'1',resultType:'STRUCTURED',testMode:true,customBadgeText:'TEST MODE'});expect(structured.records[0]).not.toHaveProperty('resultUrl');
 });
 it('rejects a changed persisted revision between plan pages before resolving or mapping any output',async()=>{
  const rows=Array.from({length:101},(_,index)=>plan('execution_'+index,'task_'+index,[asset('output_'+index)])),{adapter,project,mapped}=setup(rows,{pageRevision:page=>page===1?11:12});
  await expect(adapter.list({type:'IMAGE'})).rejects.toMatchObject({status:409,code:'HISTORY_CHANGED'});expect(project).not.toHaveBeenCalled();expect(mapped).not.toHaveBeenCalled();
 });
 it('returns honest empty output pages for persisted empty plans and never fabricates media for text-only history',async()=>{
  const {adapter,project}=setup([plan('execution_empty','task_empty',[]),plan('execution_text','task_text',[{id:'stored_text',type:'TEXT',text:'Actually stored'}])]);
  expect(await adapter.list({type:'IMAGE'})).toMatchObject({records:[],total:0,pages:0,hasNext:false});expect(project).not.toHaveBeenCalled();
 });
 it('excludes other actual file MIME types from image filters and reports their unsupported native view honestly',async()=>{
  const {adapter,project}=setup([plan('mixed_files','task_files',[asset('image'),asset('markdown','text/markdown')])]);
  expect(await adapter.list({type:'IMAGE'})).toMatchObject({total:1});expect(project).toHaveBeenCalledTimes(1);await expect(adapter.list({})).rejects.toMatchObject({status:501});
 });
 it('stops an oversized persisted plan scan immediately without partial or cached results',async()=>{
  const {adapter,transport,project,mapped}=setup([],{history:()=>reply({records:[],page:1,size:100,total:100001,hasNext:true,revision:11})});
  await expect(adapter.list({type:'IMAGE'})).rejects.toMatchObject({status:413,code:'HISTORY_SCAN_LIMIT'});expect(transport).toHaveBeenCalledTimes(1);expect(project).not.toHaveBeenCalled();expect(mapped).not.toHaveBeenCalled();
 });
});

describe('native import Task cursor',()=>{
 const broadTaskTypes=['API','WEBAPP','WORKFLOW','ExclAPI','CORPAPI','FAST_WEBAPP','SKU_WEBAPP_API','SKU_WORKFLOW_API','FAST_WEBAPP_V2'];
 const input={size:2,current:1,status:['SUCCESS'],taskType:broadTaskTypes,hasOutput:true,fastCreation:null,fromId:'',onlyImageVideo:true};
 it('finishes each Task group across sibling plans and projects the exact native import DTO',async()=>{
  const rows=[plan('a_plan_1','task_a',[asset('a_image'),asset('a_video','video/mp4')]),plan('a_plan_2','task_a',[asset('a_sibling')]),plan('b_plan','task_b',[asset('b_video','video/mp4'),asset('b_image')]),plan('c_plan','task_c',[asset('c_image')])],{adapter}=setup(rows);
  const first=await adapter.list(input,true);expect(first.records.map(row=>row.id)).toEqual(['a_image','a_video','a_sibling']);expect(first).toMatchObject({total:6,current:1,size:2,hasNext:true,nextCursor:'task_a'});
  expect(first.records[1]).toMatchObject({id:'a_video',taskId:'task_a',fileUrl:'/api/v1/media/asset_a_video',outputType:'VIDEO',outputName:'saved.mp4',fileName:'saved.mp4'});
  const second=await adapter.list({...input,fromId:first.records.at(-1)!.taskId},true),third=await adapter.list({...input,fromId:second.records.at(-1)!.taskId},true);
  expect(second.records.map(row=>row.id)).toEqual(['b_video','b_image']);expect(third.records.map(row=>row.id)).toEqual(['c_image']);expect(third.hasNext).toBe(false);expect(new Set([...first.records,...second.records,...third.records].map(row=>row.id)).size).toBe(6);
  expect(await adapter.list({...input,fromId:'task_c'},true)).toMatchObject({records:[],total:6,hasNext:false});
 });
 it('rejects unknown or deleted task cursors instead of silently restarting with duplicate results',async()=>{
  const {adapter,project}=setup([plan('b_plan','task_b',[asset('b_image')])]);
  for(const cursor of ['unknown','deleted_task'])await expect(adapter.list({...input,fromId:cursor},true)).rejects.toMatchObject({status:409,code:'HISTORY_CURSOR_STALE'});expect(project).not.toHaveBeenCalled();
 });
 it('counts actual import batches after completing an oversized Task group',async()=>{
  const {adapter}=setup([plan('large_group','task_a',Array.from({length:5},(_,index)=>asset('a_'+index))),plan('small_group','task_b',[asset('b')])]);
  const first=await adapter.list(input,true);expect(first.records).toHaveLength(5);expect(first).toMatchObject({total:6,pages:2,nextCursor:'task_a'});expect((await adapter.list({...input,fromId:'task_a'},true)).records.map(row=>row.id)).toEqual(['b']);
 });
 it('rejects unsupported filters and provenance subsets before requesting server data',async()=>{
  const {adapter,transport}=setup([]);
  for(const body of [{status:['RUNNING']},{type:'USD'},{toolType:'image-edit'},{fastCreation:true},{hasOutput:false},{taskType:['API']},{taskType:[...broadTaskTypes.slice(0,-1),'UNKNOWN']},{teamId:'original-team'}])await expect(adapter.list(body)).rejects.toMatchObject({status:501});
  await expect(adapter.list({...input,current:2},true)).rejects.toMatchObject({status:400});expect(transport).not.toHaveBeenCalled();
 });
});

describe('history identity cleanup',()=>{
 it('aborts history reads and rejects late server rows after clear without resolving assets or registering IDs',async()=>{
  let finish!:(value:Response)=>void,signal:AbortSignal|undefined;
  const {adapter,project,mapped}=setup([],{history:(_url,init)=>{signal=init.signal!;return new Promise(resolve=>finish=resolve);}}),loading=adapter.list({type:'IMAGE'}),rejected=expect(loading).rejects.toBeDefined();await flush();adapter.clear();expect(signal!.aborted).toBe(true);
  finish(reply({records:[plan('late_plan','late_task',[asset('late')])],page:1,size:100,total:1,hasNext:false,revision:11}));await rejected;expect(project).not.toHaveBeenCalled();expect(mapped).not.toHaveBeenCalled();
 });
 it('does not register an output whose asset projection completes after clear',async()=>{
  let finish!:(value:any)=>void;
  const {adapter,mapped}=setup([plan('stored_plan','stored_task',[asset('stored')])],{project:()=>new Promise(resolve=>finish=resolve)}),loading=adapter.list({type:'IMAGE'}),rejected=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});await flush();adapter.clear();
  finish({outputId:'stored',assetId:'asset_stored',fileName:'saved.png',mimeType:'image/png',url:'/api/v1/media/asset_stored'});await rejected;expect(mapped).not.toHaveBeenCalled();
 });
});
