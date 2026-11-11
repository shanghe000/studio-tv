/** Keep the immutable TFr editor mounted until gFr receives its native click. */
export function installNativeTextSelectionMenu(doc:Document=document){
 const style=doc.createElement('style');style.id='studio-native-text-selection-menu';
 // The native node context menu uses 50000. Only this existing selection
 // menu needs to sit above it; both retain their original close callbacks.
 style.textContent='.rh-text-selection-menu{z-index:50001}';doc.head.append(style);
 const preserveSelection=(event:MouseEvent)=>{
  if(event.button!==0||event.defaultPrevented)return;
  const button=(event.target as Element)?.closest?.('button.rh-text-selection-item');
  if(!button?.closest('.rh-text-selection-menu'))return;
  const editor=doc.activeElement,selection=doc.getSelection();
  if(!editor?.matches('.rh-text-editor[contenteditable="true"]')||!selection||selection.isCollapsed||!editor.contains(selection.anchorNode)||!editor.contains(selection.focusNode))return;
  // A button mousedown otherwise blurs TFr, whose synchronous commit removes
  // gFr before click. Do not replace click, stop propagation, or change input.
  event.preventDefault();
 };
 doc.addEventListener('mousedown',preserveSelection,true);
 return()=>{doc.removeEventListener('mousedown',preserveSelection,true);style.remove();};
}
