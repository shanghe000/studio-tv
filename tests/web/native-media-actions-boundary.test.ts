import {readFileSync,appendFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ServiceStorage} from '../../apps/web/src/service/storage';
const src=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const builder=runInNewContext(src.slice(src.indexOf('const Kat="/canvas/media/task/run"'),src.indexOf('function b4e('))+';vmn',{u8:(n:number)=>((n%360)+360)%360});
const capture=(name:string,body:any)=>{if(process.env.STUDIO_CANVAS_MEDIA_EXPORT)appendFileSync(process.env.STUDIO_CANVAS_MEDIA_EXPORT,JSON.stringify({name,body})+'\n');};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}));
it.each([
 ['裁剪',{kind:'crop',rect:{x:0,y:0,width:160,height:120}},'CROP',{crop:{x:0,y:0,width:160,height:120}}],
 ['最低速',{kind:'speed',rate:.25},'SPEED',{speed:.25}],['最高速',{kind:'speed',rate:4},'SPEED',{speed:4}],
 ['倒放',{kind:'reverse'},'REVERSE',{reverse:true}],['右转',{kind:'transform',rotation:90},'ROTATE',{rotate:'90'}],
 ['左转',{kind:'transform',rotation:270},'ROTATE',{rotate:'270'}],['水平镜像',{kind:'transform',flipH:true},'MIRROR',{mirror:'horizontal'}],
 ['垂直镜像',{kind:'transform',flipV:true},'MIRROR',{mirror:'vertical'}],['旋转加镜像',{kind:'transform',rotation:90,flipV:true},'ROTATE_MIRROR',{rotate:'90',mirror:'vertical'}],
]as const)('runs frozen video tool builder → STUDIO transport for %s',async(_name,op,operation,clip)=>{
 let submitted:any;const api=new ProductClient('/api/v1',async(path,init:any)=>{
  if(path==='/api/v1/assets/a-video')return json({id:'a-video',kind:'VIDEO',width:640,height:360,durationSeconds:6,state:'READY'});
  if(path==='/api/v2/media-jobs'){submitted=JSON.parse(init.body);return json({taskId:'accepted',outputs:[]});}
  throw Error(path);
 });api.setAccessToken('fixture');
 const ex=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn());
 try{
  const command=builder({canvasId:'p',nodeId:'result',videoUrl:'rhtv-asset:a-video',op,media:{width:640,height:360,fps:24}});
  await ex.handle('/canvas/media/task/run',command);
  expect(submitted).toMatchObject({projectId:'p',nodeId:'result',operation,executor:'FFMPEG',spec:{inputs:[{id:'a',assetId:'a-video'}],tracks:[{type:'video',clips:[{input:'a',...clip}]}]}});
  expect(submitted.spec.inputs[0]).not.toHaveProperty('url');capture(_name,submitted);
 }finally{ex.clear();}
});

it('extracts the current connected video through the native standalone audio node; exports the STUDIO media request',async()=>{
 const source=(id:string)=>({id,type:'rh-video',data:{isUpload:true,sourceObjects:['rhtv-asset:'+id]}});
 const graph={nodes:[source('a-video'),source('b-video'),{id:'track',type:'rh-audio',data:{toolsType:'VIDEO_AUDIO',sourceNodeId:'b-video',toolsSourceUrl:'rhtv-asset:b-video',modelCode:'local-video-audio-v1',params:{videoUrl:'rhtv-asset:b-video',audioSeparationMode:'all'}}}],edges:[{source:'a-video',target:'track'}]};
 let submitted:any;const api=new ProductClient('/api/v1',async(path,init:any)=>{
  if(path==='/api/v1/assets/a-video')return json({id:'a-video',state:'READY',kind:'VIDEO',mimeType:'video/mp4',durationSeconds:6,width:640,height:360});
  if(path==='/api/v2/media-jobs'){submitted=JSON.parse(init.body);return json({taskId:'media',status:'QUEUED',outputs:[],testMode:false});}
  throw Error(path);
 });api.setAccessToken('fixture');
 const ex=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn());
 try{await ex.run({projectId:'p',targetId:'track',graph});expect(submitted).toMatchObject({operation:'EXTRACT_AUDIO',spec:{inputs:[{id:'source',assetId:'a-video'}],output:{container:'wav'}}});capture('提取完整音轨',submitted);}finally{ex.clear();}
});
