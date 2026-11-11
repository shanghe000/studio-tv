// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {generateFromSketchDirector,installSketchboardDirector,sketchDirectorPort} from '../../apps/web/src/service/sketchboard-director';
import {SketchModelSelections,type SketchModelPort} from '../../apps/web/src/service/sketchboard-models';
import type {Capability} from '../../apps/web/src/service/model-catalog';

const cap=(kind:string):Capability=>({capabilityRef:kind==='TEXT_TO_IMAGE'?'z-image-turbo-generate-v1':'qwen-image-edit-2511-v1',version:'1',kind,available:true,testMode:false,model:{providerRef:'comfy',modelRef:kind,title:kind,version:'1'},inputKinds:kind==='TEXT_TO_IMAGE'?['TEXT']:['TEXT','IMAGE'],outputKinds:['IMAGE'],parameterSchemaVersion:'1',parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4,8],default:1}}}}),text=cap('TEXT_TO_IMAGE'),edit=cap('IMAGE_TO_IMAGE');
function setup(){
 document.body.innerHTML='<div class="sketch-studio"><div class="sketch-studio__generation-mode is-live"><button class="sketch-studio__generation-mode-option">实时</button><button class="sketch-studio__generation-mode-option">手动</button></div><div class="sketch-studio__prompt"><textarea></textarea></div><div class="sketch-studio__generation-submit"><button disabled>生成</button></div></div><div class="director-shell is-2d"><div class="director-2d-root"></div></div>';
 const board=document.querySelector('.sketch-studio')!,director=document.querySelector('.director-2d-root')!,send=document.querySelector<HTMLButtonElement>('.sketch-studio__generation-submit button')!,input=document.querySelector('textarea')!,generation=vi.fn();
 board.querySelectorAll('button')[1].addEventListener('click',()=>{board.querySelector('.sketch-studio__generation-mode')!.className='sketch-studio__generation-mode is-manual';});input.addEventListener('input',()=>send.disabled=!input.value.trim());send.addEventListener('click',generation);
 const schema={mode:'2d',shapes:[{type:'rect',x:1,y:2}]},capture=vi.fn(async()=> 'data:image/png;base64,AA=='),getSchema=vi.fn(()=>schema),apply=vi.fn(async()=>{director.remove();});
 (director as any).__reactFiber$fixture={return:{memoizedProps:{initialImageUrl:'',initialSchema:null,onSave:apply},ref:{current:{capture,getSchema}},return:null}};
 const port:SketchModelPort={catalog:async()=>[edit,text],selections:new SketchModelSelections(),canRun:()=>true,notice:vi.fn()};
 return{board,director,send,input,generation,schema,capture,getSchema,apply,port};
}
afterEach(()=>{document.body.innerHTML='';window.history.replaceState({},'','/');});

it('accepts only the inspected 2D capture/ref and save callback seam',()=>{
 const {director}=setup();expect(sketchDirectorPort(director)).not.toBeNull();expect(sketchDirectorPort(document.createElement('div'))).toBeNull();(director as any).__reactFiber$fixture.return.memoizedProps={onSave:vi.fn()};expect(sketchDirectorPort(director)).toBeNull();
});

it('applies the actual native 2D drawing and schema, restores the manual model and invokes the existing native generate action once',async()=>{
 const {director,board,port,input,generation,capture,apply,schema}=setup();await generateFromSketchDirector(director,board,'p','一座红色小屋',text,port,()=>'p');
 expect(capture).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledWith({dataURL:'data:image/png;base64,AA==',schema,mode:'2d',direct:true,keepOpen:false});expect(input.value).toBe('一座红色小屋');expect(port.selections.get('p','manual')).toMatchObject({capabilityRef:text.capabilityRef,capabilityVersion:'1'});expect(generation).toHaveBeenCalledOnce();
});

it('requires a written description for text-only generation before capturing or modifying the drawing',async()=>{
 const {director,board,port,capture,apply,generation}=setup();await expect(generateFromSketchDirector(director,board,'p','  ',text,port,()=>'p')).rejects.toMatchObject({code:'SKETCH_PROMPT_REQUIRED'});expect(capture).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();expect(generation).not.toHaveBeenCalled();
});

it('keeps a useful contour-preserving default for a sketch-conditioned editor with no optional description',async()=>{
 const {director,board,port,input,generation}=setup();await generateFromSketchDirector(director,board,'p','',edit,port,()=>'p');expect(input.value).toContain('保留主体、轮廓和空间布局');expect(generation).toHaveBeenCalledOnce();
});

it('does not apply or submit a late capture after the user closes the editor',async()=>{
 const {director,board,port,capture,apply,generation}=setup();let resolve!:(image:string)=>void;capture.mockImplementation(()=>new Promise<string>(yes=>resolve=yes));const work=generateFromSketchDirector(director,board,'p','house',text,port,()=>'p'),assertion=expect(work).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});director.remove();resolve('data:image/png;base64,AA==');await assertion;expect(apply).not.toHaveBeenCalled();expect(generation).not.toHaveBeenCalled();
});

it('rejects a wrong project, missing export seam and non-PNG export before applying the scene',async()=>{
 const {director,board,port,capture,apply}=setup();await expect(generateFromSketchDirector(director,board,'p','house',text,port,()=>'other')).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});expect(capture).not.toHaveBeenCalled();capture.mockResolvedValueOnce('');await expect(generateFromSketchDirector(director,board,'p','house',text,port,()=>'p')).rejects.toMatchObject({code:'INVALID_IMAGE'});expect(apply).not.toHaveBeenCalled();delete (director as any).__reactFiber$fixture;await expect(generateFromSketchDirector(director,board,'p','house',text,port,()=>'p')).rejects.toMatchObject({code:'SKETCH_EXPORT_UNAVAILABLE'});
});

it('adds an independent full-2D model panel, shares the manual choice and cleans up without replacing native controls',async()=>{
 const {director,board,port}=setup(),release=installSketchboardDirector(port,()=>'p');
 try{await vi.waitFor(()=>expect(document.querySelectorAll('.studio-sketch-director option')).toHaveLength(2));expect(document.querySelector('.studio-sketch-director')?.parentElement).toBe(director);const select=document.querySelector<HTMLSelectElement>('[aria-label="纯2D画板生成模型"]')!;expect(select.value).toBe(edit.capabilityRef);select.value=text.capabilityRef;select.dispatchEvent(new Event('change'));expect(port.selections.get('p','manual')?.capabilityRef).toBe(text.capabilityRef);expect(document.querySelector('.studio-sketch-director p')?.textContent).toContain('画笔不作为约束');expect(board.querySelectorAll('button')).toHaveLength(3);}finally{release();}expect(document.querySelector('.studio-sketch-director')).toBeNull();
});

it('does not attach generation to an unrelated standalone Director scene or enable editing for read-only users',async()=>{
 const {board,port}=setup();port.canRun=()=>false;const release=installSketchboardDirector(port,()=>'p');
 try{await vi.waitFor(()=>expect(document.querySelectorAll('.studio-sketch-director option')).toHaveLength(2));expect(document.querySelector<HTMLSelectElement>('.studio-sketch-director select')?.disabled).toBe(true);expect(document.querySelector<HTMLButtonElement>('.studio-sketch-director button')?.disabled).toBe(true);board.remove();await vi.waitFor(()=>expect(document.querySelector('.studio-sketch-director')).toBeNull());}finally{release();}
});
