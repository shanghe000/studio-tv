import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {inspectCanvasConnection} from '../../apps/web/src/service/connection-readiness';
import {videoPreflightError} from '../../apps/web/src/service/video-input';
import {projectNativeVideoInputs} from '../../apps/web/src/service/video-command';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';
const cases=readFileSync(new URL('../../docs/acceptance/canvas-video-counts.csv',import.meta.url),'utf8').trim().split('\n').slice(1).map(line=>line.split(','));
const models=catalog.filter(row=>!row.testMode&&row.model&&row.outputKinds.includes('VIDEO'));
it.each(models.map(cap=>[cap.capabilityRef,cap] as const))('matches service count boundaries at the connection, projection and generation gates: %s',(ref,cap)=>{
 const active={...cap,available:true} as any,target={id:'target',type:'rh-video',data:{modelCode:ref,subType:'multimodal-video'}};
 const rows=cases.filter(fields=>fields[0]===ref);
 const limits=(cap.parameterSchema as any)['x-media-limits'];
 expect(rows.length).toBe(['IMAGE','VIDEO','AUDIO'].reduce((n,kind)=>n*((limits[kind]??0)+2),1));
 for(const [,version,ic,vc,ac,expected,account] of rows){
  expect(version).toBe(cap.version);
  const types=['image','video','audio'].flatMap((type,index)=>Array(Number([ic,vc,ac][index])).fill(type)) as ('image'|'video'|'audio')[];
  const sources=types.map((type,i)=>({id:'s'+i,type:'rh-'+type,data:{sourceObjects:['rhtv-asset:input'+i]}})),edges=sources.map(source=>({source:source.id,target:target.id})),graph={nodes:[target,...sources],edges};
  const refs=projectNativeVideoInputs(target,graph)!.references,items=Object.entries(refs).flatMap(([type,assets])=>assets.map(()=>({type})));
  for(const type of ['image','video','audio'] as const)expect(refs[type]).toEqual(types.flatMap((t,i)=>t===type?['rhtv-asset:input'+i]:[]));
  expect(videoPreflightError(active,items)===null,`${ref}(${ic},${vc},${ac})`).toBe(expected==='ready');
  if(edges.length)expect(inspectCanvasConnection(edges.at(-1)!,{...graph,edges:edges.slice(0,-1)},[active]).allowed).toBe(expected!=='forbidden');
  if(!cap.available){expect(account).toBe('disabled');expect(videoPreflightError(cap as any,items)).toBeTruthy();}
 }
});
