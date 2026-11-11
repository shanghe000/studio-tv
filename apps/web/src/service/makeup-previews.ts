import catalog from './catalog/makeup-previews.json';

const previews=new Map(catalog.items.map(item=>[item.id,item]));

/** Display metadata only: never add a generation reference or change a recipe. */
export function makeupPreview(resource:Record<string,any>,preset:Record<string,any>|null):string|undefined{
 if(resource.scope!=='SYSTEM'||resource.coverAssetId||!preset||preset.key!=='makeup'||preset.coverUrl)return;
 const item=previews.get(resource.id);
 if(!item||preset.id!==item.id||preset.revision!==item.revision||resource.name!==item.label||preset.label!==item.label)return;
 return item.path;
}
