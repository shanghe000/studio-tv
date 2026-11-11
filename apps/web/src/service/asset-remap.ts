/** Copy a graph's authorized asset references without changing the personal
 * source or interpreting arbitrary strings as remote URLs. */
export function remapAssetValues<T>(value:T,mapping:ReadonlyMap<string,string>,encode:(value:string)=>string,decode:(value:string)=>string):T {
 const visit=(input:any):any=>{
  if(typeof input==='string'){const encoded=encode(input);if(encoded.startsWith('rhtv-asset:')){const mapped=mapping.get(encoded.slice(11));if(mapped&&mapped!==encoded.slice(11))return input.startsWith('rhtv-asset:')?'rhtv-asset:'+mapped:decode('rhtv-asset:'+mapped);}return input;}
  if(Array.isArray(input))return input.map(visit);
  if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).map(([key,item])=>[key,typeof item==='string'&&(key==='assetId'||key==='thumbnailAssetId')&&mapping.has(item)?mapping.get(item):key==='assetIds'&&Array.isArray(item)?item.map(id=>typeof id==='string'?mapping.get(id)??id:visit(id)):visit(item)]));
  return input;
 };return visit(value);
}
