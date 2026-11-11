// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installCanvasFileIntake} from '../../apps/web/src/service/canvas-file-intake';
import {optimizeCanvasImage} from '../../apps/web/src/service/optimize-canvas-image';
vi.mock('../../apps/web/src/service/optimize-canvas-image',()=>({
 shouldOptimizeCanvasImage:(file:File)=>file.type==='image/png',optimizeCanvasImage:vi.fn(),
}));
let stop:()=>void;
afterEach(()=>{stop?.();document.body.replaceChildren();vi.resetAllMocks();vi.unstubAllGlobals();});
function setup(){
 // happy-dom aliases DragEvent to Event and ignores its dataTransfer init.
 vi.stubGlobal('DragEvent',class extends MouseEvent {
  dataTransfer:DataTransfer|null;
  constructor(name:string,init:DragEventInit){super(name,init);this.dataTransfer=init.dataTransfer??null;}
 });
 const host=document.createElement('div');host.className='react-flow';document.body.append(host);
 const input=document.createElement('input');input.type='file';host.append(input);
 let current=true;const notice=vi.fn();
 stop=installCanvasFileIntake(()=>()=>current,notice);
 const original=new File(['original'],'A.png',{type:'image/png'});
 Object.defineProperty(original,'size',{value:52*1024*1024});
 const smaller=new File(['smaller'],'A.png',{type:'image/png'}),second=new File(['other'],'B.jpg',{type:'image/jpeg'});
 const data=new DataTransfer();data.items.add(original);data.items.add(second);
 vi.mocked(optimizeCanvasImage).mockImplementation(async file=>file===original?smaller:file);
 return {host,input,original,smaller,second,data,notice,leave:()=>{current=false;}};
}
it('runs the file picker once with prepared bytes and the original batch order',async()=>{
 const f=setup(),handler=vi.fn(()=>Array.from(f.input.files!));f.input.onchange=handler;
 f.input.files=f.data.files;f.input.dispatchEvent(new Event('change',{bubbles:true}));
 await vi.waitFor(()=>expect(handler).toHaveBeenCalledTimes(1));
 expect(handler.mock.results[0].value).toEqual([f.smaller,f.second]);expect(f.notice).not.toHaveBeenCalled();
});
it('retains the drop point and does not consume a mixed clipboard payload',async()=>{
 const f=setup(),received=vi.fn();f.host.addEventListener('drop',event=>received(event.clientX,event.clientY,Array.from(event.dataTransfer!.files)));
 f.host.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:f.data,clientX:105,clientY:97}));
 await vi.waitFor(()=>expect(received).toHaveBeenCalledWith(105,97,[f.smaller,f.second]));
 f.data.setData('text/plain','user text');const pasted=vi.fn();f.host.addEventListener('paste',pasted);
 const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:f.data});f.host.dispatchEvent(paste);
 expect(pasted).toHaveBeenCalledWith(paste);
});
it('discards an unfinished file paste after a change in editing rights',async()=>{
 const f=setup(),received=vi.fn();f.host.addEventListener('paste',received);
 f.host.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:f.data}));f.leave();
 await new Promise(resolve=>setTimeout(resolve,0));expect(received).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
});

it('names a file that remains too large and imports other files once',async()=>{
 const f=setup();f.input.parentElement!.className='rh-add-node-panel__list';
 vi.mocked(optimizeCanvasImage).mockImplementation(async file=>file);
 const selected=vi.fn(()=>Array.from(f.input.files!));f.input.onchange=selected;
 f.input.files=f.data.files;f.input.dispatchEvent(new Event('change',{bubbles:true}));
 await vi.waitFor(()=>expect(selected).toHaveBeenCalledTimes(1));
 expect(selected.mock.results[0].value).toEqual([f.second]);
 expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('“A.png”为 52 MiB'));
});
