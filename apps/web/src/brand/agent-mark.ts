import {studioArtwork} from './frames-mark';

export const agentMarkSelector='.agent-orb-icon,.storyboard-agent-orb-icon';
const authoredContent='[contenteditable="true"],.rh-text-editor,.rh-text-display,.asset-card__media,.hf-chat__msg-content,.hf-chat__msg-text,.hf-chat__msg-attachments,.hf-preview,.ap-message-content,.llm-msg';

/** Keep the native floating inner element and its blink state. Only application
 * artwork is appended; user content and the original event nodes are untouched. */
export function decorateAgentMark(orb:Element):boolean {
 if(orb.closest(authoredContent))return false;
 const inner=orb.querySelector(':scope > .agent-orb-icon__inner,:scope > .storyboard-agent-orb-icon__inner');
 if(!inner)return false;
 if(!orb.hasAttribute('data-studio-agent-mark'))orb.setAttribute('data-studio-agent-mark','');
 if(inner.querySelector(':scope > [data-studio-agent-art]'))return true;
 const mark=document.createElementNS('http://www.w3.org/2000/svg','svg');
 mark.setAttribute('viewBox','0 0 530 530');mark.setAttribute('class','studio-agent-mark');mark.setAttribute('data-studio-agent-art','');mark.setAttribute('aria-hidden','true');mark.setAttribute('pointer-events','none');mark.innerHTML=studioArtwork;inner.append(mark);
 return true;
}
