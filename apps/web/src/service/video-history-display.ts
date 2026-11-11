const assetMedia=/^\/storage\/assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const canvasMedia=/^\/storage\/canvas-media\/[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function mediaURL(value:string,origin:string){
 try{const url=new URL(value,origin);return /^https?:$/.test(url.protocol)&&(canvasMedia.test(url.pathname)||assetMedia.test(url.pathname)&&!!url.searchParams.get('token'))?url:undefined;}catch{return;}
}

/** Only the display derivative changes. Callers retain the original video URL
 * for playback, canvas inputs and downloads. Match the inspected native Oo
 * thumbnail/preview requests, including the existing authorization query. */
export function historyVideoPosterURL(value:string,preset:'thumbnail'|'preview'='thumbnail'):string|undefined {
 const url=mediaURL(value,globalThis.location?.origin||'http://localhost');if(!url)return;
 const preview=preset==='preview';
 for(const [key,val] of Object.entries({'ci-process':'snapshot',time:'0',format:'jpg',width:preview?'640':'240',quality:preview?'76':'72',minisize:'1'}))url.searchParams.set(key,val);
 return value.startsWith('/')&&!value.startsWith('//')?url.pathname+url.search+url.hash:url.href;
}

function historyPoster(props:any,origin:string){
 if(typeof props?.src!=='string'||typeof props.alt!=='string'||!/^history-.+/.test(props.alt)||typeof props.onError!=='function'||typeof props.onLoad!=='function')return false;
 const url=mediaURL(props.src,origin);
 return !!url&&url.origin===origin&&url.searchParams.getAll('ci-process').length===1&&url.searchParams.get('ci-process')==='snapshot';
}

/** Jbt discards server thumbnail fields and renders a snapshot <img> itself.
 * Its native onError removes src but leaves an internal output ID as alt text.
 * Replace only that proven STUDIO history-poster host, keeping the native row,
 * hover video, preview/use/copy/download callbacks and errors elsewhere intact. */
export function installVideoHistoryDisplay(native:any,surface:Pick<Window,'location'>=window){
 const react=native?.r,jsx=native?.j,installed:{name:string;original:Function;wrapper:Function}[]=[];let active=true;
 if(typeof react?.useState!=='function'||typeof jsx?.jsx!=='function')return()=>{};
 const render=jsx.jsx;
 function VideoHistoryPoster(props:any){
  const source=props.src,[status,setStatus]=react.useState(()=>({source,failed:false}));
  // Reset derived state before rendering a changed URL. An old request's error
  // cannot mark the newly selected/renewed poster as failed.
  if(status.source!==source)setStatus({source,failed:false});
  if(status.source===source&&status.failed)return render('span',{
   'data-studio-history-video-poster':'unavailable',role:'img','aria-label':'视频封面暂不可用',
   style:{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',padding:12,boxSizing:'border-box',color:'var(--studio-ink, #eee9f2)',background:'var(--studio-surface, #232027)',fontSize:14,lineHeight:1.5,textAlign:'center',overflowWrap:'anywhere',pointerEvents:'none'},
   children:'视频封面暂不可用',
  });
  const update=(failed:boolean)=>setStatus((current:{source:string;failed:boolean})=>current.source===source?{source,failed}:current);
  return render('img',{...props,alt:'视频封面',onLoad:(event:any)=>{props.onLoad?.(event);update(false);},onError:(event:any)=>{props.onError?.(event);update(true);}});
 }
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,type:any,props:any,...args:any[]){return original.call(this,active&&type==='img'&&historyPoster(props,surface.location.origin)?VideoHistoryPoster:type,props,...args);};
  jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 return()=>{if(!active)return;active=false;for(const row of installed)if(jsx[row.name]===row.wrapper)jsx[row.name]=row.original;};
}
