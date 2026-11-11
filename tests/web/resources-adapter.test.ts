import {describe,it,expect,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ResourceAdapter,type ResourceAssetResolver} from '../../apps/web/src/service/resources';

type Call={path:string;method:string;body:any;headers:Headers;signal:AbortSignal};
const reply=(data:any,etag?:string,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});
const failure=(status:number,code:string)=>new Response(JSON.stringify({code,message:code}),{status,headers:{'Content-Type':'application/json'}});
const resource=(id:string,content:any,revision=1,scope='USER')=>({resource:{id,name:'Saved '+id,description:'real persisted content',scope,revision,version:String(revision),categoryIds:[],coverAssetId:null,coverUrl:null,favorited:false,createdAt:'2026-10-05T00:00:00Z',updatedAt:'2026-10-05T00:00:00Z'},content});
const ownedAsset=(id:string)=>({id,state:'READY',projectId:'project-1',kind:'IMAGE' as const,fileName:id+'.png',mimeType:'image/png',byteSize:10,previewUrl:'/api/v1/assets/'+id+'/content?preview=1',downloadUrl:'/api/v1/assets/'+id+'/content?download=1',urlsExpireAt:'2026-10-05T00:10:00Z'});
function setup(handler:(call:Call)=>Response|Promise<Response>,resolver:ResourceAssetResolver={}){
 const calls:Call[]=[],transport=vi.fn(async(path:any,options:any={})=>{const call={path:String(path),method:options.method??'GET',body:options.body===undefined?undefined:JSON.parse(options.body),headers:new Headers(options.headers),signal:options.signal};calls.push(call);return handler(call);});
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('current-studio-session');return{adapter:new ResourceAdapter(api,resolver),api,calls,transport};
}
const resolver:ResourceAssetResolver={encodeAsset:ref=>ref.startsWith('/owned/')?'rhtv-asset:'+ref.slice(7):ref,resolveAsset:async ref=>ownedAsset(ref.startsWith('rhtv-asset:')?ref.slice(11):ref.replace('/owned/',''))};

describe('persisted resource native adapter',()=>{
 it('decodes actual app creation records to session-authorized asset URLs without altering task identity or pagination',async()=>{
  const {adapter,calls}=setup(()=>reply({records:[{id:'real-output',taskId:'real-task',creationShowreelInfo:{fileUrl:'rhtv-asset:ast-1',fileType:'png'},outputs:[{fileUrl:'rhtv-asset:ast-2'}]}],page:1,size:20,total:1,hasNext:false}),resolver);
  const result=await adapter.handle('/api/portal/creation/list',{webappId:'app',current:1,size:20});expect(calls[0].path).toBe('/api/v2/apps/app/creations?page=1&size=20');expect(result).toMatchObject({current:1,total:1,records:[{id:'real-output',taskId:'real-task',creationShowreelInfo:{fileUrl:'/api/v1/assets/ast-1/content?download=1',fileType:'png'},outputs:[{fileUrl:'/api/v1/assets/ast-2/content?download=1'}]}]});
 });
 it('preserves the actual APP input field types, defaults and current revision instead of inventing a default prompt or workflow',async()=>{
  const fields=[{nodeId:'2',fieldName:'enabled',fieldType:'BOOLEAN',fieldValue:false,fieldData:'["BOOLEAN",{}]'},{nodeId:'3',fieldName:'steps',fieldType:'INT',fieldValue:12,fieldData:'["INT",{"min":1,"max":20}]'},{nodeId:'4',fieldName:'image',fieldType:'IMAGE',fieldValue:'rhtv-asset:ast-1'}],{adapter}=setup(()=>reply(resource('app',{inputNodes:fields,outputType:'IMAGE',workflowId:'missing-vendor-workflow'},9,'SYSTEM')),resolver);
  const result=await adapter.handle('/api/webapp/detail',{webappId:'app'});expect(result.resourceRevision).toBe(9);expect(result.inputNodes).toEqual([...fields.slice(0,2),{...fields[2],fieldValue:'/api/v1/assets/ast-1/content?download=1'}]);expect(result.workflowId).toBe('missing-vendor-workflow');
 });
 it('creates a private gallery from authorized asset IDs and returns native images with its real ID',async()=>{
  const {adapter,calls}=setup(call=>{expect(call.path).toBe('/api/v2/library/items');return reply({id:'gallery-1',title:call.body.title,description:call.body.description,kind:'ROLE',assetIds:call.body.assetIds,mainAssetId:call.body.mainAssetId,revision:1},'"1"',201);},resolver);
  const result=await adapter.handle('/canvas/role/create',{name:'My role',images:[{imageUrl:'/owned/ast-1'},{assetId:'ast-2'}],mainImageUrl:'/owned/ast-1',teamId:'untrusted-team',userId:'another-user'});
  expect(calls[0].body).toEqual({title:'My role',description:'',kind:'ROLE',assetIds:['ast-1','ast-2'],mainAssetId:'ast-1'});
  expect(calls[0].headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);expect(calls[0].headers.get('Authorization')).toBe('Bearer current-studio-session');
  expect(result).toMatchObject({id:'gallery-1',name:'My role',mainImageId:'ast-1',images:[{id:'ast-1',isMain:true},{id:'ast-2',isMain:false}]});
  expect(result.images[0].imageUrl).toContain('/api/v1/assets/ast-1/content');expect(result.code).toBeUndefined();
 });
 it('preserves gallery type and ETag while ordering, removing images and deleting; rejects foreign image IDs',async()=>{
  let row={id:'g-scene',title:'Room',description:'Own photos',kind:'SCENE',assetIds:['ast-1','ast-2'],mainAssetId:'ast-1' as string|null,revision:4};
  const {adapter,calls}=setup(call=>{
   if(call.method==='GET')return reply(row,'"'+row.revision+'"');
   if(call.method==='DELETE'){expect(call.headers.get('If-Match')).toBe('"6"');return reply({accepted:true},'"7"');}
   expect(call.headers.get('If-Match')).toBe('"'+row.revision+'"');row={...row,...call.body,revision:row.revision+1};return reply(row,'"'+row.revision+'"');
  },resolver);
  await adapter.handle('/canvas/scene/detail',{id:'g-scene'});
  await adapter.handle('/canvas/scene/image/sort',{galleryId:'g-scene',items:[{imageId:'ast-1',sortOrder:9},{imageId:'ast-2',sortOrder:0}]});
  expect(calls[1].body).toMatchObject({kind:'SCENE',assetIds:['ast-2','ast-1'],mainAssetId:'ast-1'});
  await expect(adapter.handle('/canvas/scene/image/setMain',{galleryId:'g-scene',imageId:'other-owner-asset'})).rejects.toMatchObject({status:400});
  await adapter.handle('/canvas/scene/image/delete',{galleryId:'g-scene',imageIds:['ast-1']});expect(calls[2].body.mainAssetId).toBeNull();
  await adapter.handle('/canvas/scene/delete',{id:'g-scene'});expect(calls).toHaveLength(4);
 });
 it('propagates stale gallery revisions without refreshing and overwriting another edit',async()=>{
  const {adapter,calls}=setup(call=>call.method==='GET'?reply({id:'g',title:'Role',description:'',kind:'ROLE',assetIds:[],mainAssetId:null,revision:2},'"2"'):failure(412,'VERSION_CONFLICT'));
  await adapter.handle('/canvas/role/detail',{id:'g'});
  await expect(adapter.handle('/canvas/role/update',{id:'g',name:'Changed'})).rejects.toMatchObject({status:412,code:'VERSION_CONFLICT'});
  expect(calls.map(call=>call.method)).toEqual(['GET','PATCH']);expect(calls[1].headers.get('If-Match')).toBe('"2"');
 });
 it('uses one backend union page and projects actual folders and reusable node content',async()=>{
  const {adapter,calls}=setup(()=>reply({page:1,size:40,total:2,hasNext:false,records:[{type:'FOLDER',folder:{id:'f',name:'Saved folder',categoryCode:'USER_OTHER',parentId:null,kind:'MIXED',thumbnailAssetIds:['ast-1'],itemCount:1,revision:2}},{type:'ITEM',item:{id:'n',name:'Stored node',kind:'IMAGE',revision:3,content:{nodeType:'IMAGE',nodeContent:{id:'node',data:{url:'rhtv-asset:ast-2',params:{seed:12}}}},thumbnailAssetId:'ast-2'}}]}),resolver);
  const result=await adapter.handle('/canvas/asset/user/folder/second-level/list',{parentGroupId:'parent-f',page:1,size:40,code:'USER_OTHER',keyword:'saved'});
  const url=new URL(calls[0].path,'https://studio.test');expect(url.pathname).toBe('/api/v2/library/entries');expect(url.searchParams.get('parentId')).toBe('parent-f');expect(url.searchParams.has('teamId')).toBe(false);
  expect(result).toMatchObject({current:1,size:40,total:2,records:[{id:'f',isFolder:true,itemCount:1},{id:'n',itemName:'Stored node',nodeType:'IMAGE',content:{data:{params:{seed:12}}}}]});
  expect(result.records[1].content.data.url).toContain('/api/v1/assets/ast-2/content');expect(calls).toHaveLength(1);
 });
 it('rejects an unsupported native team scope instead of returning private personal folders as shared data',async()=>{
  const {adapter,calls}=setup(()=>reply({records:[],total:0}),resolver);await expect(adapter.handle('/canvas/asset/user/folder/first-level/list',{teamId:'foreign'})).rejects.toMatchObject({status:501,code:'TEAM_LIBRARY_USE_STUDIO_PAGE'});expect(calls).toHaveLength(0);
 });
 it('stores node media as authoritative IDs and sends atomic collection revision for batch create and move',async()=>{
  const {adapter,calls}=setup(call=>{
   if(call.path==='/api/v2/library/state')return reply({revision:8});
   if(call.path==='/api/v2/library/folders/f1')return reply({id:'f1',categoryCode:'USER_SCENE',revision:2},'"2"');
   return reply({revision:9,changedIds:['node-item']});
  },resolver);
  await adapter.handle('/canvas/asset/user/folder/item/batch-add',{folderId:'f1',nodes:[{itemName:'Image node',nodeType:'IMAGE',content:{id:'node-1',data:{url:'/owned/ast-1',params:{prompt:'Own content'}}},thumbnail:'/owned/ast-1'}]});
  const batch=calls.find(call=>call.path.endsWith('/batch-create'))!;expect(batch.body).toMatchObject({expectedCollectionRevision:8,items:[{name:'Image node',folderId:'f1',categoryCode:'USER_SCENE',content:{nodeContent:{data:{url:'rhtv-asset:ast-1'}},assetIds:['ast-1']},thumbnailAssetId:'ast-1'}]});
  expect(batch.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
  await adapter.handle('/canvas/asset/user/folder/move',{targetCode:'USER_OTHER',groupIds:['f1'],itemIds:['node-item']});
  expect(calls.at(-1)!.body).toEqual({itemIds:['node-item'],folderIds:['f1'],expectedCollectionRevision:8,targetCategoryCode:'USER_OTHER',targetFolderId:null});
 });
 it('reads native large picker pages from bounded backend pages without truncation or changing offsets',async()=>{
  const {adapter,calls}=setup(call=>{const url=new URL(call.path,'https://studio.test'),page=Number(url.searchParams.get('page')),size=Number(url.searchParams.get('size'));return reply({page,size,total:305,hasNext:page*size<305,records:Array.from({length:Math.min(size,305-(page-1)*size)},(_,i)=>resource(String((page-1)*size+i+1),{prefixPrompt:'Saved preset'}))});});
  const result=await adapter.handle('/canvas/prompt/system/list',{page:2,size:150,categoryId:'portrait'});
  expect(calls).toHaveLength(2);expect(calls.every(call=>new URL(call.path,'https://studio.test').searchParams.get('size')==='100')).toBe(true);
  expect(result).toMatchObject({current:2,size:150,total:305,pages:3,hasNext:true});expect(result.records[0].id).toBe('151');expect(result.records.at(-1).id).toBe('300');
 });
 it('normalizes native numeric prompt category IDs, app tags and voice scene IDs for strict string-ID query DTOs',async()=>{
  const {adapter,calls}=setup(call=>{
   const url=new URL(call.path,'https://studio.test'),field=url.pathname.endsWith('/voices')?'sceneIdList':'categoryIds',ids=JSON.parse(url.searchParams.get(field)!);
   // Mirrors Go []string JSON decoding: a numeric element must fail rather than return an empty catalog.
   if(!Array.isArray(ids)||ids.some(value=>typeof value!=='string'))return failure(400,'VALIDATION_FAILED');
   return reply({records:[resource('matched',{prefixPrompt:'Actual matching preset',workflowId:'w1',providerVoiceRef:'voice'})],page:1,size:20,total:1,hasNext:false});
  });
  expect((await adapter.handle('/canvas/prompt/system/batchList',{categoryIds:[3,'portrait',8]})).records[0].id).toBe('matched');
  expect((await adapter.handle('/api/webapp/list',{tags:[12,'1871151815242543199']})).records[0].webappId).toBe('matched');
  expect((await adapter.handle('/canvas/model/voice/record/list',{sceneIdList:[5,'story']})).records[0].voiceId).toBe('matched');
  expect(new URL(calls[0].path,'https://studio.test').searchParams.get('categoryIds')).toBe('["3","portrait","8"]');
  expect(new URL(calls[1].path,'https://studio.test').searchParams.get('categoryIds')).toBe('["12","1871151815242543199"]');
  expect(new URL(calls[2].path,'https://studio.test').searchParams.get('sceneIdList')).toBe('["5","story"]');
 });
 it('rejects invalid identifier-array elements before issuing a resource query',async()=>{
  const {adapter,calls}=setup(()=>reply({}));
  for(const categoryIds of [[null],[{}],[1.5]])await expect(adapter.handle('/canvas/prompt/system/batchList',{categoryIds})).rejects.toMatchObject({status:400,code:'INVALID_RESOURCE_REQUEST'});
  expect(calls).toHaveLength(0);
 });
 it('projects immutable SYSTEM preset selectors without storage-only prompt fields or lost reference media',async()=>{
  const preset={schemaVersion:'1',revision:1,key:'styleLibrary',id:'cinematic_realism',label:'电影写实',prompt:'cinematic realism',coverUrl:'https://catalog.test/style.webp',referenceImageUrl:'https://catalog.test/style.webp'};
  const registerCatalogMedia=vi.fn();
  const row=resource(preset.id,{schemaVersion:'1',preset,prefixPrompt:preset.prompt,suffixPrompt:'',promptType:'STYLE',mediaScope:'IMAGE'},1,'SYSTEM');
  row.resource.name=preset.label;
  const {adapter}=setup(()=>reply({records:[row],total:1,page:1,size:20,hasNext:false}),{registerCatalogMedia});
  const result=await adapter.handle('/canvas/prompt/system/batchList',{categoryIds:[930011,930012]});
  expect(result.records[0]).toMatchObject({...preset,name:preset.label,prefixPrompt:'',suffixPrompt:''});
  // These values are consumed verbatim by native nV/cye and must match the frozen selector.
  expect(result.records[0].promptType).toBeUndefined();
  expect(registerCatalogMedia).toHaveBeenCalledWith(preset.referenceImageUrl,{family:'PROMPT',resourceId:preset.id,revision:1,path:'/preset/referenceImageUrl'});
 });
 it('fills only display covers for built-in makeup without modifying stored selectors or references',async()=>{
  const preset={schemaVersion:'1',revision:1,key:'makeup',id:'studio-portrait-1059-v1',label:'少年妆',prompt:'saved recipe',prefixPrompt:'saved recipe',promptCode:'studio-portrait-1059-v1',coverUrl:'',referenceImageUrl:''};
  const row=resource(preset.id,{preset,menuType:'portrait'},1,'SYSTEM');row.resource.name=preset.label;
  const registerCatalogMedia=vi.fn(),{adapter}=setup(()=>reply({records:[row],total:1,page:1,size:20,hasNext:false}),{registerCatalogMedia});
  const result=await adapter.handle('/canvas/prompt/system/batchList',{categoryIds:[920060]});
  expect(result.records[0].coverUrl).toMatch(/^\/studio-makeup-media\/[a-f0-9]{64}\.webp$/);
  expect(result.records[0].referenceImageUrl).toBe('');expect(result.records[0].promptCode).toBe(preset.promptCode);expect(result.records[0].prompt).toBe(preset.prompt);
  expect(preset.coverUrl).toBe('');expect(registerCatalogMedia).not.toHaveBeenCalled();
 });
 it('ignores private preset URL metadata and uses its owned reference asset',async()=>{
  const row=resource('private',{promptType:'STYLE',prefixPrompt:'own style',preset:{referenceImageUrl:'https://untrusted.test/not-an-input'},referenceAssetId:'ast-1'});
  const {adapter}=setup(()=>reply({records:[row],total:1,page:1,size:20,hasNext:false}),resolver);
  const result=await adapter.handle('/canvas/prompt/user/style/list',{});
  expect(result.records[0].referenceImageUrl).toBe('/api/v1/assets/ast-1/content?download=1');
  expect(result.records[0].prefixPrompt).toBe('own style');expect(result.records[0].promptType).toBe('STYLE');
 });
 it('updates prompt styles as persisted typed resources and makes favorites version-aware',async()=>{
  const original=resource('p1',{promptType:'STYLE',prefixPrompt:'prefix',suffixPrompt:'old suffix',mediaScope:'IMAGE',referenceAssetId:'ast-1'},7);
  const {adapter,calls}=setup(call=>call.method==='GET'?reply(original,'"7"'):call.path.endsWith('/favorite')?reply({id:'p1',favorited:true},'"9"'):reply({...original,resource:{...original.resource,name:call.body.name,revision:8},content:call.body.content},'"8"'),resolver);
  await adapter.handle('/canvas/prompt/user/style/update',{id:'p1',name:'My style',suffixPrompt:'new suffix'});
  expect(calls[1]).toMatchObject({method:'PUT',body:{name:'My style',content:{promptType:'STYLE',prefixPrompt:'prefix',suffixPrompt:'new suffix',referenceAssetId:'ast-1'}}});expect(calls[1].headers.get('If-Match')).toBe('"7"');
  await adapter.handle('/canvas/prompt/favorite/add',{promptId:'p1'});expect(calls[2].body).toEqual({favorited:true});expect(calls[2].headers.get('If-Match')).toBe('"8"');
 });
 it('projects real workflow, app, skill and voice content with stable string IDs',async()=>{
  const fixtures:Record<string,any>={
   '/api/v2/workflows/w1':resource('w1',{workflowContent:{nodes:[{id:'n',data:{params:{seed:123}}}],edges:[]},customNodes:[{nodeId:'custom',fieldName:'prompt'}]},2,'SYSTEM'),
   '/api/v2/apps/a1':resource('a1',{workflowId:'w1',inputNodes:[{nodeId:'custom',fieldName:'prompt',fieldType:'STRING'}]},2,'SYSTEM'),
   '/api/v2/skills/s1':resource('s1',{intro:'Persisted skill',presetPrompt:'Act on saved content',content:[],outputType:'TEXT'},2,'SYSTEM'),
   '/api/v2/voices':{records:[resource('v1',{providerVoiceRef:'neutral-voice',gender:'FEMALE',currentVoiceExampleUrl:'/authorized/example',labels:['Calm']},2,'SYSTEM')],page:1,size:20,total:1,hasNext:false},
  };
  const {adapter,calls}=setup(call=>reply(fixtures[call.path.split('?')[0]]));
  expect(await adapter.handle('/canvas/workflow/detail',{id:'w1'})).toMatchObject({id:'w1',isOwn:false,workflowContent:{nodes:[{id:'n'}]}});
  expect(await adapter.handle('/api/webapp/detail',{webappId:'a1'})).toMatchObject({webappId:'a1',workflowId:'w1',inputNodes:[{fieldName:'prompt'}]});
  expect(await adapter.handle('/canvas/skill/detail',{skillId:'s1'})).toMatchObject({skillId:'s1',type:'COMMON',isPlatform:true,intro:'Persisted skill'});
  const voices=await adapter.handle('/canvas/model/voice/record/list',{page:1,size:20,queryTargetType:'VOICE_USER_COLLECT',voiceName:'calm',langId:'en',sceneIdList:['story']});expect(voices.records[0]).toMatchObject({voiceId:'v1',voiceType:'neutral-voice',isCollect:false});
  const filters=new URL(calls[3].path,'https://studio.test').searchParams;expect(filters.get('langId')).toBe('en');expect(filters.get('sceneIdList')).toBe('["story"]');expect(filters.get('favoriteOnly')).toBe('true');
 });
 it('reads hot assistant skills from the actual system catalogue with native skill projection',async()=>{
  const stored=resource('hot-skill',{intro:'Saved assistant skill',category:'CANVAS_AGENT',presetPrompt:'Use owned content',outputType:'TEXT'},3,'SYSTEM');
  const {adapter,calls}=setup(()=>reply({records:[stored],page:1,size:6,total:1,hasNext:false}));
  expect(await adapter.handle('/canvas/home/hot-skill/query',{teamId:'foreign',size:999})).toEqual([expect.objectContaining({skillId:'hot-skill',name:stored.resource.name,type:'COMMON',isPlatform:true,intro:'Saved assistant skill',presetPrompt:'Use owned content'})]);
  const url=new URL(calls[0].path,'https://studio.test');expect(url.pathname).toBe('/api/v2/skills');
  expect(Object.fromEntries(url.searchParams)).toEqual({scope:'SYSTEM',category:'CANVAS_AGENT',sort:'HOTTEST',page:'1',size:'6'});expect(calls[0].headers.get('Authorization')).toBe('Bearer current-studio-session');
  const unavailable=setup(()=>failure(501,'CATALOG_UNAVAILABLE')).adapter;
  await expect(unavailable.handle('/canvas/home/hot-skill/query',{})).rejects.toMatchObject({status:501,code:'CATALOG_UNAVAILABLE'});
 });
 it('maps tag CRUD/order/status to strong tag-set versions and preferences to their real version',async()=>{
  let tagRevision=2;const {adapter,calls}=setup(call=>{
   if(call.path==='/api/v2/preferences')return reply({revision:4,userId:'own-user',shortcutKeyConfig:call.body?.shortcutKeyConfig??{zoomSensitivity:25}},'"4"');
   if(call.method!=='GET'){expect(call.headers.get('If-Match')).toBe('"'+tagRevision+'"');tagRevision++;}
   return reply({revision:tagRevision,tags:[{id:'tag1',name:'Saved tag',color:'#112233',sortOrder:0,visible:call.body?.visible??true}]},'"'+tagRevision+'"');
  });
  expect(await adapter.handle('/canvas/node/tag/list',{})).toEqual([{id:'tag1',name:'Saved tag',color:'#112233',sortOrder:0,visible:true,status:1}]);
  await adapter.handle('/canvas/node/tag/status',{id:'tag1',status:0});await adapter.handle('/canvas/node/tag/sort',{ids:['tag1']});
  expect(calls[1].body).toEqual({visible:false});expect(calls[2].body).toEqual({ids:['tag1']});
  await adapter.handle('/canvas/user/update/shortcutKeyConfig',{shortcutKeyConfig:{zoomSensitivity:30,interactionMode:'comfyui'}});
  expect(calls.at(-1)!.headers.get('If-Match')).toBe('"4"');expect(calls.at(-1)!.body).toEqual({shortcutKeyConfig:{zoomSensitivity:30,interactionMode:'comfyui'}});
 });
 it('saves independent director content in resource wrapper without creating anything in node mode',async()=>{
  const {adapter,calls}=setup(call=>reply(resource('director-1',call.body?.content??{type:'3D',content:{camera:{x:2}}},1),'"1"'),resolver);
  const result=await adapter.handle('/canvas/director/project/create',{type:'3D',name:'My layout',content:JSON.stringify({camera:{x:2},backgroundImage:'/owned/ast-1'}),thumbnail:'/owned/ast-1'});
  expect(calls[0].body).toMatchObject({name:'My layout',coverAssetId:'ast-1',content:{type:'3D',content:{camera:{x:2},backgroundImage:'rhtv-asset:ast-1'}}});
  expect(result).toMatchObject({id:'director-1',type:'3D',content:{camera:{x:2}}});expect(result.content.backgroundImage).toContain('/api/v1/assets/ast-1/content');
  expect(await adapter.handle('/canvas/task/run',{})).toBeUndefined();expect(calls).toHaveLength(1);
 });
 it('never returns sample or successful empty data for errors or malformed service pages',async()=>{
  const {adapter}=setup(()=>failure(501,'NOT_IMPLEMENTED'));
  for(const path of ['/canvas/character-library/list','/canvas/prompt/system/list','/api/webapp/user/list','/canvas/user/detail'])await expect(adapter.handle(path,{})).rejects.toMatchObject({status:501,code:'NOT_IMPLEMENTED'});
  const malformed=setup(()=>reply({records:[]})).adapter;await expect(malformed.handle('/canvas/workflow/list',{})).rejects.toMatchObject({status:502,code:'INVALID_RESOURCE_PAGE'});
  expect(await adapter.handle('/outside-domain',{})).toBeUndefined();
 });
 it('aborts active requests and rejects ignored-abort completions after logout',async()=>{
  let finish!:(response:Response)=>void;const {adapter,calls}=setup(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=adapter.handle('/canvas/workflow/list',{});await Promise.resolve();adapter.clear();expect(calls[0].signal.aborted).toBe(true);
  finish(reply({records:[],page:1,size:20,total:0,hasNext:false}));await expect(pending).rejects.toMatchObject({status:401,code:'SESSION_CHANGED'});
 });
 it('projects only explicitly supplied native config over a real persisted server row',async()=>{
  const {adapter,calls}=setup(()=>reply([{type:'CANVAS_NEW_AGENT',content:{stored:true}},{type:'CANVAS_THUMBNAIL_QUALITY',content:75}]),{nativeConfigs:{CANVAS_NEW_AGENT:{transport:'http'}}});
  expect(await adapter.handle('/canvas/config/queryByTypes',{types:['CANVAS_NEW_AGENT','CANVAS_THUMBNAIL_QUALITY']})).toEqual([{type:'CANVAS_NEW_AGENT',content:{transport:'http'}},{type:'CANVAS_THUMBNAIL_QUALITY',content:75}]);
  expect(new URL(calls[0].path,'https://studio.test').searchParams.get('types')).toBe('["CANVAS_NEW_AGENT","CANVAS_THUMBNAIL_QUALITY"]');
 });
 it('rejects arbitrary gallery media when no authorized asset resolver is supplied',async()=>{
  const {adapter,calls}=setup(()=>reply({}));await expect(adapter.handle('/canvas/role/create',{name:'Rejected',images:[{imageUrl:'https://vendor.invalid/private-image.png'}]})).rejects.toBeInstanceOf(ApiError);expect(calls).toHaveLength(0);
 });
 it('saves actual Skill file bytes from own signed STUDIO assets and returns editable native file URLs',async()=>{
  const markdown='---\nname: Saved skill\n---\nUse the actual saved file.';
  const fileResolver={...resolver,resolveAsset:async(ref:string)=>({...ownedAsset(ref.replace('/owned/','')),fileName:'SKILL.md',mimeType:'text/markdown'})};
  const {adapter,calls}=setup(call=>call.path.startsWith('/api/v1/assets/')?new Response(markdown,{headers:{'Content-Type':'text/markdown'}}):reply(resource('skill-file',call.body.content),'"1"',201),fileResolver);
  const result=await adapter.handle('/canvas/skill/save',{name:'Saved skill',intro:'Actual Markdown',outputType:'TEXT',content:[{path:'SKILL.md',url:'/owned/ast-md',type:'md',primary:true}]});
  const saved=calls.find(call=>call.path==='/api/v2/skills')!;expect(saved.body.content).toMatchObject({markdown,files:[{path:'SKILL.md',content:markdown,encoding:'utf8',mimeType:'text/markdown',primary:true}]});expect(JSON.stringify(saved.body)).not.toContain('/owned/');
  expect(calls[0].headers.get('Authorization')).toBe('Bearer current-studio-session');expect(result).toMatchObject({skillId:'skill-file',content:[{path:'SKILL.md',type:'md',primary:true,content:markdown}]});
  expect(await(await fetch(result.content[0].url)).text()).toBe(markdown);adapter.clear();await expect(fetch(result.content[0].url)).rejects.toThrow();
 });
 it('records trustworthy SYSTEM media pointers from reads and skips USER resource input',async()=>{
  const registerCatalogMedia=vi.fn(),character=resource('char-public',{images:[{name:'Full body',url:'/project/assets/company-character.png'}],attributes:{gender:{optionCode:'female'}}},3,'SYSTEM');
  const {adapter}=setup(call=>call.path.startsWith('/api/v2/characters')?reply({records:[character],page:1,size:20,total:1,hasNext:false}):reply(resource('own-style',call.body.content),'"1"',201),{...resolver,registerCatalogMedia});
  const result=await adapter.handle('/canvas/character-library/list',{page:1,size:20});expect(result.records[0]).toMatchObject({id:'char-public',images:[{url:'/project/assets/company-character.png'}],favorite:false});
  expect(registerCatalogMedia).toHaveBeenCalledExactlyOnceWith('/project/assets/company-character.png',{family:'CHARACTER',resourceId:'char-public',revision:3,path:'/images/0/url'});
  await adapter.handle('/canvas/prompt/user/style/create',{name:'Mine',suffixPrompt:'Own style',referenceImageUrl:'/owned/ast-1'});expect(registerCatalogMedia).toHaveBeenCalledTimes(1);
 });
 it('projects the restored three character views and registers each immutable STUDIO catalog pointer',async()=>{
  const registerCatalogMedia=vi.fn(),paths=['a','b','c'].map(value=>'/studio-character-media/'+value.repeat(64)+'.webp'),thumbnail='/studio-character-media/'+'d'.repeat(64)+'.webp';
  const character=resource('character_298',{images:paths.map((url,index)=>({type:['closeUp','fullBody','multiView'][index],name:['Face','Body','Views'][index],url})),thumbnailUrl:thumbnail,attributes:{gender:{optionCode:'female'}}},2,'SYSTEM');
  const {adapter,calls}=setup(()=>reply({records:[character],page:1,size:1,total:415,hasNext:true}),{registerCatalogMedia});
  const result=await adapter.handle('/canvas/character-library/list',{page:1,size:1});
  expect(result).toMatchObject({total:415,records:[{id:'character_298',images:paths.map(url=>({url})),thumbnailUrl:thumbnail,favorite:false,attributes:{gender:{optionCode:'female'}}}]});
  paths.forEach((path,index)=>expect(registerCatalogMedia).toHaveBeenCalledWith(path,{family:'CHARACTER',resourceId:'character_298',revision:2,path:'/images/'+index+'/url'}));
  expect(registerCatalogMedia).toHaveBeenCalledWith(thumbnail,{family:'CHARACTER',resourceId:'character_298',revision:2,path:'/thumbnailUrl'});
  expect(calls).toHaveLength(1);
 });
 it('persists workflows with canonical media IDs and deletes against the viewed resource version',async()=>{
  const {adapter,calls}=setup(call=>call.method==='DELETE'?reply({accepted:true}):reply(resource('w-own',call.body.content,5),'"5"',201),resolver);
  const result=await adapter.handle('/canvas/workflow/save',{id:'',name:'Saved graph',workflowContent:{nodes:[{id:'n1',type:'rh-image',position:{x:10,y:20},data:{params:{imageUrls:['/owned/ast-1'],seed:42,categoryIds:[3,8]}}}],edges:[]}});
  const graph=calls[0].body.content.workflowContent;expect(graph.nodes.find((node:any)=>node.id==='n1').data.params.imageUrls).toEqual(['rhtv-asset:ast-1']);expect(result.workflowContent.nodes.find((node:any)=>node.id==='n1').data.params.seed).toBe(42);
  expect(graph.nodes.find((node:any)=>node.id==='n1').data.params.categoryIds).toEqual([3,8]);expect(result.workflowContent.nodes.find((node:any)=>node.id==='n1').data.params.categoryIds).toEqual([3,8]);
  await adapter.handle('/canvas/workflow/delete',{id:'w-own'});expect(calls[1]).toMatchObject({path:'/api/v2/workflows/w-own',method:'DELETE'});expect(calls[1].headers.get('If-Match')).toBe('"5"');
 });
 it('projects persisted catalog entries into native model groups and inspiration details',async()=>{
  const {adapter,calls}=setup(call=>{
   const row=resource('entry-1',{key:'props',label:'Company props',models:[{name:'Desk',url:'/project/assets/desk.glb'}],snapshot:{presetParams:{seed:42}}},2,'SYSTEM');
   return reply(call.path.includes('/entries/entry-1')?row:{records:[row],page:1,size:100,total:1,hasNext:false});
  });
  expect(await adapter.handle('/canvas/director/model/list',{keys:['props']})).toEqual([expect.objectContaining({id:'entry-1',key:'props',models:[{name:'Desk',url:'/project/assets/desk.glb'}]})]);
  expect(await adapter.handle('/task/quick-creation/inspiration/template/detail',{templateId:'entry-1'})).toMatchObject({id:'entry-1',snapshot:{presetParams:{seed:42}}});
  expect(new URL(calls[0].path,'https://studio.test').searchParams.get('namespace')).toBe('DIRECTOR_MODEL');expect(new URL(calls[1].path,'https://studio.test').searchParams.get('namespace')).toBe('INSPIRATION_TEMPLATE');
 });
});

it('serves explicit STUDIO sketch presets in both modes while retaining other server dictionaries',async()=>{
 const {adapter,calls}=setup(()=>reply([{detailName:'other',detailValue:'server-owned'}]));
 const rows=await adapter.handle('/api/portal/v2/getDictConfig',{dictTypes:['sketchboard_style_live','sketchboard_style_manual','other']});
 expect(rows[0]).toEqual({detailName:'other',detailValue:'server-owned'});expect(calls).toHaveLength(1);expect(new URL(calls[0].path,'https://studio.test').searchParams.get('types')).toBe('["other"]');
 for(const key of ['sketchboard_style_live','sketchboard_style_manual']){const styles=JSON.parse(rows.find((row:any)=>row.detailName===key).detailValue);expect(styles).toHaveLength(6);expect(styles.every((style:any)=>style.code&&style.name)).toBe(true);}
});
