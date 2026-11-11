import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {makeupPreview} from '../../apps/web/src/service/makeup-previews';
import catalog from '../../apps/web/src/service/catalog/makeup-previews.json';
import recipes from '../../apps/api-go/internal/modules/execution/application/seed/portrait-recipes.json';

it('ships a matching, intact local WebP for every published makeup option',()=>{
 const makeup=recipes.items.filter(item=>item.prop.group==='makeup');
 expect(catalog.items).toHaveLength(makeup.length);expect(new Set(catalog.items.map(x=>x.id)).size).toBe(makeup.length);
 for(const {definition} of makeup){
  const preview=catalog.items.find(x=>x.id===definition.id)!;
  const path=makeupPreview({id:definition.id,name:definition.label,scope:'SYSTEM'},definition);
  expect(path).toBe(preview.path);expect(path).toMatch(/^\/studio-makeup-media\/[a-f0-9]{64}\.webp$/);
  const bytes=readFileSync(new URL('../../apps/web/public'+path,import.meta.url));
  expect(bytes.length).toBe(preview.byteSize);expect(bytes.subarray(0,4).toString()).toBe('RIFF');expect(bytes.subarray(8,12).toString()).toBe('WEBP');expect(createHash('sha256').update(bytes).digest('hex')).toBe(preview.sha256);
 }
});
it('does not override user covers, other tools, or changed recipe identities',()=>{
 const preset=recipes.items.find(x=>x.prop.group==='makeup')!.definition;
 const base={id:preset.id,name:preset.label,scope:'SYSTEM'};
 for(const override of [{scope:'USER'},{name:'renamed'},{id:'unknown'},{coverAssetId:'owned'}])expect(makeupPreview({...base,...override},preset)).toBeUndefined();
 for(const override of [{key:'styleLibrary'},{revision:2},{coverUrl:'/owned.webp'},{label:'changed'},{id:'unknown'}])expect(makeupPreview(base,{...preset,...override})).toBeUndefined();
});
it('native built-in makeup selection excludes preview media from generation inputs and selectors',()=>{
 const native=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
 const start=native.indexOf('function zer('),end=native.indexOf('function E9e(',start);
 const select=new Function('M_e','S9e','C9e',native.slice(start,end)+';return zer;')(()=>{},()=>null,()=>null);
 const mediaStart=native.indexOf('function Kwr('),mediaEnd=native.indexOf('function fb(',mediaStart);
 const inputs=new Function(native.slice(mediaStart,mediaEnd)+';return Kwr;')();
 const makeup={id:'studio-portrait-1059-v1',label:'少年妆',prompt:'saved recipe',promptCode:'studio-portrait-1059-v1',custom:false,coverUrl:catalog.items[0].path};
 expect(inputs('rhtv-asset:source',makeup)).toEqual(['rhtv-asset:source']);
 const selection=select('makeup',{makeup,touched:{makeup:true},protection:{}},{byGroup:{}});
 expect(selection).toHaveLength(1);expect(selection[0]).not.toHaveProperty('coverUrl');expect(selection[0]).not.toHaveProperty('referenceImageUrl');expect(selection[0].prompt).toBe('saved recipe');
});
