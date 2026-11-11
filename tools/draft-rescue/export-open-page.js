/* Internal maintenance only. Never publish this exporter as a product route. */
(()=>{
 try{
  const runtime=window.__RHTV_SERVICE__,storage=runtime?.storage,view=runtime?.inspect?.(),projectId=view?.id,userId=runtime?.auth?.user?.id;
  if(!storage||!projectId||!userId||!Array.isArray(view.graph?.nodes))throw new Error('请回到仍打开的 Studio TV 原画布页面，再点击“备份当前PF画布”书签。');
  runtime.canvasAttachment?.()?.client?.flushOperationQueue?.(true);
  const live=runtime.inspect().graph;let observed=false;
  try{storage.observeNativeDraft(projectId,live);observed=true;}catch{/* Preserve late text even if an unfinished upload prevents ordinary capture. */}
  const state=storage.drafts?.get(projectId),latest=storage.restoreModelBindings?.(projectId,live)??live,graph=observed?(state?.graph??storage.draft(projectId)??latest):latest;
  const forbidden=new Set(['__proto__','prototype','constructor']),credentials=/^(password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|credential|platformKey)$/i;
  let unresolvedMedia=0;
  const clean=(value,depth=0)=>{
   if(depth>80)throw new Error('草稿层级过深，请保持原页并联系支持。');
   if(typeof value==='string'){
    const mapped=storage.encodeAsset(value);
    if(mapped.startsWith('blob:')||mapped.includes('/__rhtv_media/'))return 'studiotv-unuploaded:'+(++unresolvedMedia);
    if(/^https?:\/\//.test(mapped)){const url=new URL(mapped);for(const key of url.searchParams.keys())if(/signature|token|credential|x-amz|x-tos/i.test(key)){url.search='';return url.href;}}
    return mapped;
   }
   if(value===null||typeof value==='boolean')return value;
   if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('草稿包含无效数字。');return value;}
   if(Array.isArray(value))return value.map(item=>clean(item,depth+1));
   if(value&&typeof value==='object'){const result={};for(const [key,item]of Object.entries(value)){if(forbidden.has(key))throw new Error('草稿包含不允许的数据字段。');if(credentials.test(key)||item===undefined||typeof item==='function')continue;result[key]=clean(item,depth+1);}return result;}
   return null;
  };
  const now=new Date().toISOString(),backup={format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId,projectId,createdAt:now,updatedAt:now,graph:clean(graph)};
  if(state?.ack){backup.base=clean(state.ack.graph);backup.baseRevision=state.ack.revision;}
  if(state?.pending?.length)backup.pending=state.pending.map(entry=>({base:clean(entry.base),local:clean(entry.local),initialEtag:entry.initialEtag,unknownBase:entry.unknownBase===true,...(entry.requiresBaseDecision?{requiresBaseDecision:true}:{})}));
  if(!observed){const unknown=!state?.observed&&!state?.ack;backup.pending??=[];backup.pending.push({base:clean(state?.observed??state?.ack?.graph??{nodes:[],edges:[]}),local:clean(latest),initialEtag:state?.ack?.etag??(state?.ack?.revision?'"'+state.ack.revision+'"':'unknown'),unknownBase:unknown,...(unknown?{requiresBaseDecision:true}:{})});}
  if(unresolvedMedia)backup.unresolvedMedia=unresolvedMedia;
  const href=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=href;link.download='Studio-TV-旧页面草稿-'+now.replaceAll(':','-')+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
  alert('已发起维护备份下载。请保持原页面打开，并由维护人员通过内部恢复接口处理；产品网页不提供备份导入或版本选择入口。'+(unresolvedMedia?' 备份中有未完成上传的素材占位：文字和节点已保留，原素材文件请另行保管，恢复后需重新上传。':''));
 }catch(error){alert((error instanceof Error?error.message:'草稿备份未完成。')+' 原页面未刷新，未提交或覆盖服务器内容。');}
})();
