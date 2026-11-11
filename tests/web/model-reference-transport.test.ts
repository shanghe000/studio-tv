import {expect, it} from 'vitest';
import {validateInputMedia} from '../../apps/web/src/service/input-media-constraints';
import {mediaInputContract} from '../../apps/web/src/service/official-video-input-contract';
import type {Capability} from '../../apps/web/src/service/model-catalog';
import type {Asset} from '../../apps/web/src/api/types';

const MiB=1048576;
function model(limits?:Record<string,unknown>):Capability {
 return {capabilityRef:'sample',version:'7',kind:'IMAGE_EDIT',executionKind:'MODEL',testMode:false,available:true,
  inputKinds:['TEXT','IMAGE','VIDEO','AUDIO'],outputKinds:['IMAGE'],parameterSchema:limits?
   {'x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:limits}}}:{}};
}
const image=(byteSize:number,mimeType:string)=>({id:'asset',kind:'IMAGE',byteSize,mimeType} as Asset);
it('enforces the intersection of advertised media support and the STUDIO reader',()=>{
 const wide=model({maxBytes:100*MiB,mimeTypes:['image/png','image/gif']});
 expect(mediaInputContract(wide).kinds.IMAGE).toMatchObject({maxBytes:10*MiB,mimeTypes:['image/png']});
 expect(()=>validateInputMedia(wide,[image(10*MiB,'image/png')])).not.toThrow();
 expect(()=>validateInputMedia(wide,[image(10*MiB+1,'image/png')])).toThrow(/10 MiB/);
 expect(()=>validateInputMedia(wide,[image(128,'image/gif')])).toThrow(/image\/png/);
 const narrow=model({maxBytes:MiB,mimeTypes:['image/webp']});
 expect(mediaInputContract(narrow).kinds.IMAGE).toMatchObject({maxBytes:MiB,mimeTypes:['image/webp']});
 expect(()=>validateInputMedia(narrow,[image(MiB+1,'image/webp')])).toThrow(/1 MiB/);
});
it('rejects even a small file when no declared format can be transported',()=>{
 const cap=model({mimeTypes:['image/avif']});
 expect(mediaInputContract(cap).kinds.IMAGE.mimeTypes).toEqual([]);
 expect(()=>validateInputMedia(cap,[image(1024,'image/avif')])).toThrow(/没有可用于/);
});
it('older catalogs still catch known byte/format failures without requiring new metadata',()=>{
 const cap=model();
 expect(()=>validateInputMedia(cap,[image(0,'')])).not.toThrow();
 expect(()=>validateInputMedia(cap,[image(MiB,'image/avif')])).toThrow();
 expect(()=>validateInputMedia(cap,[image(10*MiB+1,'')])).toThrow(/10 MiB/);
 expect(mediaInputContract(cap).kinds.AUDIO).toMatchObject({maxBytes:16*MiB,mimeTypes:['audio/wav','audio/mpeg']});
 expect(mediaInputContract(cap).kinds.VIDEO).toMatchObject({maxBytes:64*MiB,mimeTypes:['video/mp4']});
 expect(mediaInputContract({...cap,inputKinds:['TEXT']})).toBeUndefined();
});
it('keeps simulated models and local media jobs outside model-reader limits',()=>{
 for(const cap of [{...model(),testMode:true},{...model(),executionKind:'MEDIA_JOB'}]){
  expect(mediaInputContract(cap)).toBeUndefined();
  expect(()=>validateInputMedia(cap,[image(20*MiB,'image/avif')])).not.toThrow();
 }
});
