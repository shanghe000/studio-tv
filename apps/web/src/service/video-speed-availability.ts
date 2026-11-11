// The native panel accepts 0.1–10x, including via a separately editable target
// duration. Read both controls, mirroring the native rate rounded to 2 decimals.
import {mediaSpeedBounds as bounds} from './media-job-validation';
export const speedRangeReason='当前倍速处理支持 0.25–4 倍，请调整倍速或目标时长。';
export function videoSpeedIssue(el:Element,props:any[]):string|null{
 const panel=el.closest('.rh-video-speed-panel');if(!panel)return null;
 if(el.matches('.rh-video-speed-panel__preset')){
  const value=parseFloat(el.textContent??'');return value<bounds.min||value>bounds.max?speedRangeReason:null;
 }
 if(!el.matches('.rh-video-speed-panel__btn.is-submit'))return null;
 const duration=props.find(p=>typeof p.durationSec==='number'&&typeof p.onSubmit==='function')?.durationSec;
 const slider=panel.querySelector<HTMLInputElement>('.rh-video-speed-panel__slider'),draft=panel.querySelector<HTMLInputElement>('.rh-video-speed-panel__duration-input');
 if(!slider||!draft||!(duration>0))return '尚未读取到视频时长，暂时无法变速。';
 const rate=Number(slider.value),seconds=duration/rate,minutes=Math.floor(seconds/60),current=String(minutes).padStart(2,'0')+':'+(seconds-minutes*60).toFixed(2).padStart(5,'0');
 const raw=draft.value.trim(),match=raw.match(/^(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)$/),target=match?(Number(match[2])<60?Number(match[1])*60+Number(match[2]):NaN):Number(raw);
 if(!(target>0)||!Number.isFinite(target))return '请输入大于零的有效目标时长。';
 const desired=raw===current?rate:Math.round(duration/target*100)/100;
 return desired<bounds.min||desired>bounds.max?speedRangeReason:null;
}
