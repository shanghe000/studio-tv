import {ApiError} from '../api/client';

let dialogSequence=0;
const openDialogs=new WeakMap<Document,()=>void>();
export function requireName(value:string,label='名称',maxLength=120){
 const name=value.trim();if(!name)throw new ApiError(400,'NAME_REQUIRED','请输入'+label+'。');if([...name].length>maxLength)throw new ApiError(400,'NAME_TOO_LONG',label+'最多 '+maxLength+' 个字符。');if(/[\u0000-\u001f\u007f-\u009f]/.test(name))throw new ApiError(400,'NAME_INVALID',label+'不能包含控制字符。');return name;
}
export function collaborationField(label:string,control:HTMLElement,doc:Document=document){
 const field=doc.createElement('label');field.className='studio-collab-field';const caption=doc.createElement('span');caption.textContent=label;control.setAttribute('aria-label',label);if(!control.getAttribute('name'))control.setAttribute('name',label);field.append(caption,control);return field;
}
export interface CollaborationDialog {
 dialog:HTMLDialogElement;form:HTMLFormElement;body:HTMLDivElement;footer:HTMLDivElement;submit:HTMLButtonElement;
 readonly isClosed:boolean;readonly busy:boolean;active:()=>boolean;close:()=>void;
 setError:(error:unknown)=>void;setBusy:(busy:boolean)=>void;
 setSubmit:(run:()=>Promise<unknown>,label?:string)=>void;
 complete:(label?:string)=>void;
 run:(run:()=>Promise<unknown>,after?:()=>void|Promise<void>)=>Promise<void>;
}
/** A real form owns one in-flight action. Closing or changing identity fences
 * its late result, while the server continues to enforce membership and CAS. */
export function createCollaborationDialog(runtime:any,options:{title:string;description?:string;submitLabel?:string;onSubmit?:()=>Promise<unknown>;onDismiss?:()=>void;cancelLabel?:string;doc?:Document}):CollaborationDialog{
 const doc=options.doc??document,identity=runtime.auth.user?.id,previous=doc.activeElement as HTMLElement|null;
 openDialogs.get(doc)?.();
 const dialog=doc.createElement('dialog'),form=doc.createElement('form'),body=doc.createElement('div'),footer=doc.createElement('div'),title=doc.createElement('h2'),closeButton=doc.createElement('button'),cancel=doc.createElement('button'),submit=doc.createElement('button'),error=doc.createElement('p');
 const id='studio-collab-dialog-'+(++dialogSequence);dialog.className='studio-collab-dialog';dialog.setAttribute('data-studio-collaboration','');dialog.setAttribute('aria-labelledby',id);title.id=id;title.textContent=options.title;
 form.noValidate=true;body.className='studio-collab-dialog-body';footer.className='studio-collab-dialog-footer';error.className='studio-collab-error';error.setAttribute('role','alert');error.hidden=true;
 closeButton.type='button';closeButton.className='studio-collab-dialog-close';closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭对话框');cancel.type='button';cancel.textContent=options.cancelLabel??'取消';submit.type='submit';submit.className='studio-primary';submit.textContent=options.submitLabel??'确认';submit.hidden=!options.onSubmit;submit.disabled=!options.onSubmit;
 form.append(title);if(options.description){const text=doc.createElement('p');text.className='studio-collab-muted';text.textContent=options.description;form.append(text);}footer.append(cancel,submit);form.append(body,error,footer);dialog.append(closeButton,form);doc.body.append(dialog);
 let closed=false,inFlight=false,submitAction=options.onSubmit,submitText=submit.textContent;const disabled=new Map<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement,boolean>();
 const active=()=>!closed&&dialog.isConnected&&!!identity&&runtime.auth.user?.id===identity;
 const setError=(failure:unknown)=>{if(!active())return;error.textContent=failure instanceof Error?failure.message:typeof failure==='string'?failure:'请求失败，请重试。';error.hidden=false;};
 const setBusy=(value:boolean)=>{inFlight=value;closeButton.disabled=value;form.setAttribute('aria-busy',String(value));if(value){submitText=submit.textContent;submit.textContent=({'保存':'保存中…','创建':'创建中…','发布':'发布中…','发布到团队':'发布中…','导入项目':'导入中…','删除':'删除中…','移动':'移动中…'}as Record<string,string>)[submitText??'']??'处理中…';for(const control of form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>('input,select,textarea,button')){disabled.set(control,control.disabled);control.disabled=true;}}else{submit.textContent=submitText;for(const [control,state]of disabled)if(control.isConnected)control.disabled=state;disabled.clear();}};
 let release=()=>{};
 const close=()=>{if(closed)return;closed=true;release();if(openDialogs.get(doc)===close)openDialogs.delete(doc);if(dialog.open)dialog.close();dialog.remove();if(previous?.isConnected&&runtime.auth.user?.id===identity)previous.focus();};
 const dismiss=()=>{if(inFlight)return;close();options.onDismiss?.();};
 const run=async(task:()=>Promise<unknown>,after?:()=>void|Promise<void>)=>{if(!active()||inFlight)return;error.hidden=true;setBusy(true);let invalid:HTMLInputElement|null=null;try{await task();if(active())await after?.();}catch(failure){setError(failure);if(failure instanceof ApiError&&['NAME_REQUIRED','NAME_TOO_LONG','NAME_INVALID'].includes(failure.code))invalid=body.querySelector('input');}finally{if(active()){setBusy(false);invalid?.focus();}}};
 const setSubmit=(task:()=>Promise<unknown>,label?:string)=>{submitAction=task;submit.hidden=false;submit.disabled=false;if(label)submit.textContent=label;};
 const complete=(label='关闭')=>{submitAction=undefined;submit.disabled=true;submit.hidden=true;disabled.set(submit,true);cancel.textContent=label;};
 form.addEventListener('submit',event=>{event.preventDefault();if(submitAction)void run(submitAction);});
 cancel.onclick=dismiss;closeButton.onclick=dismiss;dialog.addEventListener('close',close);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dismiss();});
 release=runtime.auth.onClear(close);openDialogs.set(doc,close);dialog.showModal();
 return{dialog,form,body,footer,submit,get isClosed(){return closed;},get busy(){return inFlight;},active,close,setError,setBusy,setSubmit,complete,run};
}
