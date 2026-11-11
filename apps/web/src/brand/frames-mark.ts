import {FRAMES_NAME} from './palette';

// The same abstract face/tail silhouette as the canvas pet. These fixed paths
// are application artwork, not markup copied from a user or generated preview.
export const studioArtwork=`<g><rect x="80" y="80" width="370" height="370" rx="96" fill="#5364a7"/><path d="M220 170L365 265L220 360Z" fill="white"/></g>`;
export const framesFavicon='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 530 530">${studioArtwork}</svg>`);

export function decorateFramesMark(svg:Element,icon:boolean){
 const box=icon?'0 0 530 530':'0 0 355 79';
 if(svg.getAttribute('viewBox')!==box)svg.setAttribute('viewBox',box);
 if(svg.getAttribute('aria-label')!==FRAMES_NAME)svg.setAttribute('aria-label',FRAMES_NAME);
 if(svg.getAttribute('data-studio-frames-mark')!==(icon?'icon':'wordmark'))svg.setAttribute('data-studio-frames-mark',icon?'icon':'wordmark');
 if(svg.querySelector(':scope > [data-studio-frame-art]'))return;
 const art=document.createElementNS('http://www.w3.org/2000/svg','g');art.setAttribute('data-studio-frame-art','');art.setAttribute('pointer-events','none');
 if(icon)art.innerHTML=studioArtwork;
 else{
  const mark=document.createElementNS('http://www.w3.org/2000/svg','g');mark.setAttribute('transform','translate(0 1) scale(.145)');mark.innerHTML=studioArtwork;
  const name=document.createElementNS('http://www.w3.org/2000/svg','text');name.setAttribute('x','85');name.setAttribute('y','48');name.setAttribute('fill','#eee9f2');name.setAttribute('font-size','31');name.setAttribute('font-weight','650');name.setAttribute('font-family','system-ui, sans-serif');name.textContent=FRAMES_NAME;art.append(mark,name);
 }
 svg.append(art);
}
