import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {unavailableImagePreset} from '../../apps/web/src/service/image-preset-readiness';
import index from '../../apps/web/src/service/catalog/published-image-preset-keys.json';

// The browser ships only public selector keys. Every entry is compared with
// the actual STUDIO registries (the Go suite also resolves and compiles each one).
it('matches every STUDIO-owned selector, including the clothing subcategory emitted by the native picker',()=>{
 const base=new URL('../../apps/api-go/internal/modules/execution/application/',import.meta.url);
 const general=readFileSync(new URL('image_recipes.go',base),'utf8');
 const portrait=JSON.parse(readFileSync(new URL('seed/portrait-recipes.json',base),'utf8'));
 const defs=[...general.matchAll(/SchemaVersion: "1", Revision: 1, Key: "([^"]+)", ID: "([^"]+)"/g)].map(m=>({key:m[1],id:m[2]}));
 defs.push(...portrait.items.map((i:any)=>i.definition));
 expect(Object.entries(index).flatMap(([key,ids])=>ids.map(id=>key+'/'+id)).sort()).toEqual(defs.map(d=>d.key+'/'+d.id).sort());
 for(const def of defs){
  expect(unavailableImagePreset({presetSelections:[{...def,key:def.key==='clothing'?'clothing:top':def.key}]}),def.id).toBeUndefined();
 }
 expect(unavailableImagePreset({presetSelections:[{id:'studio-portrait-930-v1',key:'makeup'}]})).toContain('studio-portrait-930-v1');
 expect(unavailableImagePreset({presetSelections:[{id:'studio-role-missing-v1',key:'roleDesign:outfit:wardrobe'}]})).toContain('studio-role-missing-v1');
 expect(unavailableImagePreset({presetSelections:[{key:'protection',promptCode:'protect-style'}]})).toBeUndefined();
 expect(unavailableImagePreset({presetSelections:[{id:'owner-makeup',key:'makeup'},{id:'owner-style',key:'styleLibrary'},{key:'customPrompt',prefix:'个人描述'}]})).toBeUndefined();
});
