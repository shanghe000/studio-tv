import {framesFavicon} from './frames-mark';

// The native image and video “add to agent” buttons reuse this exact img.
// Keep the element, its 15px sizing and the button's handlers/hover treatment.
export const toolbarMarkSelector=':is(.rh-canvas-image-toolbar,.rh-canvas-video-toolbar) .agent-entry-btn img.toolbar-agent-r-icon';
const authoredContent='[contenteditable="true"],.rh-text-editor,.rh-text-display,.asset-card__media,.hf-chat__msg,.hf-preview';

export function decorateToolbarMark(image:Element):boolean {
 if(!image.matches(toolbarMarkSelector)||image.closest(authoredContent))return false;
 if(image.getAttribute('src')!==framesFavicon)image.setAttribute('src',framesFavicon);
 return true;
}
