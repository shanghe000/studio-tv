import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=frozen.indexOf('function Fse('),end=frozen.indexOf('function wye(',start);
const native=runInNewContext(frozen.slice(start,end)+';({build:tar,parse:oar})',{Zor:'canvas-image-region-recognize'});

it('preserves the frozen native normalized point, single selected image and exact scene',()=>{
 const model={modelCode:'codex-6-1-vision-text-v1',modelType:'LLM',config:[{paramName:'imageUrls',type:'imageUrls'},{paramName:'prompt',type:'prompt'}]};
 const result=native.build({id:'point',imageUrl:'rhtv-asset:owned',point:{x:375.2,y:500.4},model});
 expect(result.data).toMatchObject({modelCode:model.modelCode,transientKind:'region-recognize',subType:'image-recognition',sceneCode:'canvas-image-region-recognize',params:{prompt:'<point>375 500</point>',imageUrls:['rhtv-asset:owned']}});
});

it('interprets y1 x1 y2 x2 as the actual native normalized x/y box without guessing coordinate order',()=>{
 expect(native.parse('person <bbox>100 200 800 700</bbox>')).toEqual([{label:'person',box_2d:[.2,.1,.7,.8]}]);
 expect(native.parse('person <bbox>100 200 800 700</bbox>\ncoat <bbox>450 300 950 900</bbox>')).toHaveLength(2);
});

it('keeps explicit NO_OBJECT on the existing no-object feedback path without inventing a box',()=>{
 expect(native.parse('NO_OBJECT')).toEqual([]);expect(native.parse('A person wearing a coat.')).toEqual([]);
 expect(frozen).toContain('if(!W.length){w(B,"empty")');
 expect(frozen).toContain('canvas.imageToolbar.recognizeEmpty');
});
