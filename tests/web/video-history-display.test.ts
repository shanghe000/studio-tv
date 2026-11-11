import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';
import {historyVideoPosterURL,installVideoHistoryDisplay} from '../../apps/web/src/service/video-history-display';

const origin='https://studio.invalid',source=origin+'/storage/assets/ast_video?token=fixture.grant',scoped='/storage/canvas-media/'+'a'.repeat(32)+'/ast_video';
const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const snapshotStart=frozen.indexOf('function Oo('),snapshotEnd=frozen.indexOf('function Il(',snapshotStart);
const snapshot=runInNewContext(frozen.slice(snapshotStart,snapshotEnd)+';Oo',{QQ:(url:string,query:string)=>url+(url.includes('?')?'&':'?')+query});
const jsx=(type:any,props:any,...keys:any[])=>({type,props,keys});
const nodes=(tree:any):any[]=>!tree||typeof tree!=='object'?[]:[tree,...(Array.isArray(tree)?tree:Object.values(tree.props||{})).flatMap(nodes)];
function hooks(seed:any[]=[]){
 let values=seed.slice(),cursor=0,dirty=false;
 const api={useState:(initial:any)=>{const slot=cursor++;if(!(slot in values))values[slot]=typeof initial==='function'?initial():initial;return[values[slot],(next:any)=>{const val=typeof next==='function'?next(values[slot]):next;if(!Object.is(val,values[slot])){values[slot]=val;dirty=true;}}];},useRef:(value:any)=>({current:value}),useMemo:(fn:Function)=>fn(),useCallback:(fn:Function)=>fn,useEffect:vi.fn(),useImperativeHandle:vi.fn(),forwardRef:(fn:Function)=>fn};
 return{api,render:(component:Function,props:any)=>{let tree:any,count=0;do{dirty=false;cursor=0;tree=component(props);if(++count>10)throw new Error('Render did not settle');}while(dirty);return tree;},unmount:()=>{values=[];}};
}
function setup(){
 const state=hooks(),native={r:state.api,j:{jsx,jsxs:jsx}},release=installVideoHistoryDisplay(native,{location:{origin}} as any);
 const props={src:historyVideoPosterURL(source),alt:'history-out_internal',loading:'lazy',onLoad:vi.fn(),onError:vi.fn((event:any)=>event.currentTarget.removeAttribute('src'))};
 return{state,native,release,props,render:(input=props)=>{const element=native.j.jsx('img',input);return state.render(element.type,element.props);}};
}

describe('authorized video history poster URLs',()=>{
 it.each([['thumbnail',240,72],['preview',640,76]] as const)('matches the frozen native %s request while preserving the media grant', (preset,width,quality)=>{
  const actual=historyVideoPosterURL(source,preset);expect(actual).toBe(snapshot(source,{width,quality,minisize:1}));expect(new URL(actual!).searchParams.get('token')).toBe('fixture.grant');
  expect(historyVideoPosterURL(scoped,preset)).toBe(snapshot(scoped,{width,quality,minisize:1}));
 });
 it('normalizes an existing snapshot preset without duplicated fields or damaging the token',()=>{
  const value=historyVideoPosterURL(source+'&ci-process=snapshot&width=240&quality=72','preview')!,url=new URL(value);
  expect(url.searchParams.getAll('ci-process')).toEqual(['snapshot']);expect(url.searchParams.getAll('width')).toEqual(['640']);expect(url.searchParams.getAll('quality')).toEqual(['76']);expect(url.searchParams.get('token')).toBe('fixture.grant');
 });
 it.each(['','blob:video','data:video/mp4;base64,AAA','/api/v1/media/legacy','/storage/assets/video','/storage/assets/video/extra?token=x','https://cdn.invalid/clip.mp4','/storage/canvas-media/invalid/asset'])('does not advertise unsupported source bytes as a poster: %s',url=>expect(historyVideoPosterURL(url)).toBeUndefined());
});

describe('native history poster compatibility',()=>{
 it('keeps the real poster request and native load bookkeeping without exposing an output ID',()=>{
  const env=setup();try{const image=env.render(),event={currentTarget:{naturalWidth:240}};expect(image.type).toBe('img');expect(image.props).toMatchObject({src:env.props.src,alt:'视频封面',loading:'lazy'});image.props.onLoad(event);expect(env.props.onLoad).toHaveBeenCalledExactlyOnceWith(event);expect(env.render().type).toBe('img');}finally{env.release();}
 });
 it('shows a local non-intercepting fallback and recovers on a changed source; late old errors stay old',()=>{
  const env=setup();try{
   const image=env.render(),event={currentTarget:{removeAttribute:vi.fn()}};image.props.onError(event);expect(env.props.onError).toHaveBeenCalledExactlyOnceWith(event);expect(event.currentTarget.removeAttribute).toHaveBeenCalledWith('src');
   const fallback=env.render();expect(fallback.type).toBe('span');expect(fallback.props).toMatchObject({'data-studio-history-video-poster':'unavailable',children:'视频封面暂不可用',style:{pointerEvents:'none'}});expect(JSON.stringify(fallback)).not.toContain('out_internal');
   const next={...env.props,src:historyVideoPosterURL(source.replace('fixture.grant','renewed.grant'))};expect(env.render(next).type).toBe('img');image.props.onError(event);expect(env.render(next).type).toBe('img');
   expect(env.render().type).toBe('img');
  }finally{env.release();}
 });
 it('unmounts cleanly for native hover video and retries the poster when hover ends',()=>{
  const env=setup();try{env.render().props.onError({currentTarget:{removeAttribute:vi.fn()}});expect(env.render().type).toBe('span');const video={src:source,poster:env.props.src,className:'history-video',onClick:vi.fn()};expect(env.native.j.jsx('video',video)).toEqual(jsx('video',video));env.state.unmount();expect(env.render().type).toBe('img');}finally{env.release();}
 });
 it.each([
  {src:source},{src:historyVideoPosterURL(source.replace(origin,'https://other.invalid'))},{src:historyVideoPosterURL(source),alt:'canvas-node-out'},
  {src:origin+'/unrelated?ci-process=snapshot'},{src:historyVideoPosterURL(source)+'&ci-process=snapshot'},
  {src:origin+'/storage/assets/ast_video?ci-process=snapshot'}, {src:historyVideoPosterURL(source),onError:undefined},
 ])('leaves unrelated images and errors unchanged: %o',patch=>{
  const env=setup();try{const props={...env.props,...patch};expect(env.native.j.jsx('img',props)).toEqual(jsx('img',props));}finally{env.release();}
 });
 it('restores its wrappers and deactivates when another adapter wraps it later',()=>{
  const env=setup();env.release();expect(env.native.j.jsx).toBe(jsx);expect(env.native.j.jsxs).toBe(jsx);
  const second=setup(),owned=second.native.j.jsx,outer=vi.fn((...args:Parameters<typeof jsx>)=>owned(...args));second.native.j.jsx=outer;second.release();expect(second.native.j.jsx).toBe(outer);expect(second.native.j.jsx('img',second.props).type).toBe('img');
 });
 it('preserves the actual frozen Jbt preview, use, copy-prompt and download actions after a poster error',async()=>{
  const row={id:'out_record',resultUrl:source,url:source,createTime:1793840000000,type:'VIDEO',taskId:'task',taskPlanId:'plan'};
  const nativeState=hooks([[row],false,false,false,new Set(),null,{out_record:{loaded:true,prompt:'Saved prompt'}}]),componentState=hooks(),native={r:componentState.api,j:{jsx,jsxs:jsx}},release=installVideoHistoryDisplay(native,{location:{origin}} as any),open=vi.fn(),use=vi.fn(),download=vi.fn(),copy=vi.fn().mockResolvedValue(true),toast={error:vi.fn(),success:vi.fn(),info:vi.fn()};
  const sandbox:any={Set,Map,Array,Object,String,Number,Math,d:nativeState.api,c:native.j,It:()=>({t:(key:string)=>key}),VJn:(rows:any[])=>[{date:'2026-11-05',items:rows}],zJn:(date:string)=>date,FB:()=>false,Kbt:()=>false,Ybt:()=>false,Xbt:()=>false,Oo:snapshot,QJn:open,Xl:download,qJn:()=> 'mp4',Dp:copy,Ie:toast};
  const start=frozen.indexOf('const Jbt=d.forwardRef('),end=frozen.indexOf('}),aer=',start)+2;
  const Jbt=runInNewContext(frozen.slice(start,end)+';Jbt',new Proxy(sandbox,{get:(target,key)=>key in target?target[key]:typeof key==='string'?function NativeIcon(){}:undefined}));
  const props={type:'VIDEO',visible:true,activeTab:'VIDEO',scope:'personal',isTeamCanvas:false,selectMode:false,selectedIds:new Set(),onItemClick:use,onToggleSelect:vi.fn(),onToggleDateSelect:vi.fn()};
  try{
   const tree=nativeState.render(Jbt,props),poster=nodes(tree).find(node=>typeof node.type==='function'&&node.type.name==='VideoHistoryPoster');expect(poster).toBeDefined();
   const image=componentState.render(poster.type,poster.props);expect(image.props.src).toBe(historyVideoPosterURL(source));image.props.onError({currentTarget:{removeAttribute:vi.fn()}});expect(componentState.render(poster.type,poster.props).props.children).toBe('视频封面暂不可用');
   const action=(label:string)=>nodes(tree).find(node=>node.props?.label===label)?.props.children.props.onClick({stopPropagation:vi.fn()});
   action('canvas.assetsPanel.view');expect(open).toHaveBeenCalledWith(expect.objectContaining({activeRecord:row,kind:'video'}));
   action('canvas.assetLibraryModal.use');expect(use).toHaveBeenCalledExactlyOnceWith(row);
   await action('canvas.nodeOutputHistory.copyPromptTooltip');expect(copy).toHaveBeenCalledWith('Saved prompt');
   await action('canvas.imageToolbar.download');expect(download).toHaveBeenCalledWith(source,'canvas-history-out_record.mp4');expect(toast.error).not.toHaveBeenCalled();
  }finally{release();}
 });
});
