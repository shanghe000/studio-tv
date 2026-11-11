const inspected=new WeakMap<Function,boolean>();
const text=(value:any)=>typeof value==='string'&&value.trim()?value.trim():undefined;
const outputIds=(output:any)=>['historyOutputId','outputId','id'].flatMap(key=>text(output?.[key])??[]);
const asset=(value:any)=>{const id=text(value);return id?.startsWith('rhtv-asset:')?text(id.slice('rhtv-asset:'.length)):id;};
const assetIds=(output:any)=>['assetId','mediaId'].flatMap(key=>asset(output?.[key])??[]);

function selectedOutput(item:any){
 const snapshot=item?.historySnapshot,detail=item?.canvasHistoryDetail;
 if(snapshot&&detail)return;
 // Global canvas history hydrates a different native C4 item shape. Use only
 // that item's own authorized detail, bound to its exact task and plan.
 if(detail&&(!text(item.canvasHistoryTaskId)||!text(item.canvasHistoryTaskPlanId)||detail.taskId!==item.canvasHistoryTaskId||(detail.executionId||detail.id)!==item.canvasHistoryTaskPlanId||detail.id&&detail.executionId&&detail.id!==detail.executionId))return;
 const outputs=snapshot?.outputs??detail?.outputs;
 if(!Array.isArray(outputs)||!outputs.length)return;
 const id=text(item.historyOutputId),ids=assetIds(item);
 if(new Set(ids).size>1)return;
 const selectedAsset=ids[0];
 let matches:any[];
 if(detail){
  // Inspected native QJn constructs this exact key from the history output's
  // record ID. Global items have neither historyOutputId nor assetId.
  const key=text(item.key);if(!key)return;
  matches=outputs.filter(output=>text(output?.id)&&key===`canvas-history-image-${output.id}`);
 }
 else if(id)matches=outputs.filter(output=>outputIds(output).includes(id));
 else if(selectedAsset)matches=outputs.filter(output=>assetIds(output).includes(selectedAsset));
 else if(outputs.length===1)matches=outputs;
 else return;
 if(matches.length!==1)return;
 const output=matches[0];
 // A present selector must never fall back to a different output. Both stable
 // selectors, when supplied, must identify the same saved result.
 if(id&&!outputIds(output).includes(id))return;
 if(selectedAsset&&!assetIds(output).includes(selectedAsset))return;
 const mime=text(output?.mimeType)||text(output?.outputType);
 if(!mime?.toLowerCase().startsWith('image/'))return;
 if(!Number.isSafeInteger(output.width)||output.width<=0||!Number.isSafeInteger(output.height)||output.height<=0)return;
 return output;
}

/** C4 builds its generation-spec text from metadata.ratio/quality copied from
 * the native entry's parameters. Those can retain an unrelated default ratio.
 * Project only a uniquely bound saved image's real pixel dimensions; leave its
 * entry, parameters, outputs, history selection and callbacks untouched. */
export function imageHistoryDisplayProps(props:any){
 if(props?.kind!=='image'||!Array.isArray(props.items))return props;
 let changed=false;
 const items=props.items.map((item:any)=>{
  const output=selectedOutput(item);if(!output)return item;
  const ratio=`${output.width}×${output.height}（实际输出）`;
  if(item.metadata?.ratio===ratio&&item.metadata?.quality===undefined)return item;
  changed=true;return{...item,metadata:{...item.metadata,ratio,quality:undefined}};
 });
 return changed?{...props,items}:props;
}

function component(type:any){
 if(typeof type!=='function'||type.name!=='C4')return false;
 let exact=inspected.get(type);if(exact===undefined){const source=Function.prototype.toString.call(type);exact=source.includes('canvas.nodeOutputHistory.generationSpec')&&source.includes('rh-history-preview__metadata-field is-generation-spec')&&source.includes('St.metadata?.ratio');inspected.set(type,exact);}
 return exact;
}

export function installImageHistoryDisplay(native:any){
 const jsx=native?.j,installed:{name:string;original:Function;wrapper:Function}[]=[];let active=true;
 for(const name of ['jsx','jsxs'])if(typeof jsx?.[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,type:any,props:any,...args:any[]){return original.call(this,type,active&&component(type)?imageHistoryDisplayProps(props):props,...args);};
  jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 return()=>{if(!active)return;active=false;for(const row of installed)if(jsx[row.name]===row.wrapper)jsx[row.name]=row.original;};
}
