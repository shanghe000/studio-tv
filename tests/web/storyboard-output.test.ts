import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
import fixture from './fixtures/storyboard-ui.json';
import {scriptTerminalFields,storyboardOutput} from '../../apps/web/src/service/storyboard-output';

const outputs=()=>fixture.task.plans[0].outputs.map(part=>({outputId:part.id,outputType:'structured',schemaVersion:part.schemaVersion,data:structuredClone(part.data),testMode:false}));
const frozen=()=>structuredClone(fixture.task.plans[0].nodeSnapshot.data);

// Actual two-shot response from the live STUDIOTV storyboard prompt template.
// The published schema permits this descriptive field; no action is present.
const actualVisualShots={shots:[
 {sound:'轻柔风声、零星鸟鸣与树叶沙沙声，无配乐。',shot_id:1,dialogue:'无对白',image_prompt:'电影写实风格，清晨薄雾森林，林间空地上一座深褐色尖顶小木屋，正面右侧一扇四格木框窗透出暖黄灯光，湿润草地与通往木屋的小径，冷蓝晨光，远景，平视构图，细腻自然材质，无人物，无文字。',video_prompt:'时长6秒。远景平视，沿草地小径缓慢、平稳地向深褐色尖顶小木屋推进，始终保持正面右侧暖黄四格窗可见。薄雾轻轻流动，树叶微动，窗内灯光稳定。结尾仍保留木屋全貌，为下一镜同方向靠近窗户建立空间连续性。无人物，无对白。',duration_seconds:6,visual_description:'清晨，薄雾笼罩森林，一座深褐色尖顶小木屋坐落在林间空地。镜头以远景缓慢向前推进，木屋正面右侧的四格木框窗透出柔和暖黄灯光；湿润草地上的小径从画面下方延伸至木屋。冷蓝色晨光与窗内暖光形成对比。'},
 {sound:'延续上一镜的风声、鸟鸣与树叶声，衔接自然，无配乐。',shot_id:2,dialogue:'无对白',image_prompt:'电影写实风格，与上一镜相同的清晨森林木屋，深褐色木墙，正面右侧四格木框窗的中近景，窗内稳定柔和的暖黄灯光，玻璃映出冷蓝晨雾中的树影，窗框木纹清晰，同一晨光方向与冷暖色调，无人物，无文字。',video_prompt:'时长5秒。承接上一镜的推进轴线，从同一木屋正面右侧四格木框窗的中近景缓慢向前推至近景，最后轻柔停稳。保持木墙颜色、窗格比例、暖黄灯光和清晨冷蓝环境光一致。玻璃上的森林倒影随机位靠近自然变化，不穿过玻璃，不出现人物或人影，无对白。',duration_seconds:5,visual_description:'承接上一镜的前进方向，切至同一木屋正面右侧窗户的中近景，镜头继续缓慢靠近。相同的四格木框与深褐色木墙逐渐充满画面，玻璃映出清晨森林的朦胧树影，暖黄灯光透过窗玻璃洒在窗框上。最终停在窗户近景，冷暖色调延续，无人影出现。'},
]};
const visualOutputs=():any[]=>[{outputType:'structured',schemaVersion:'1',data:structuredClone(actualVisualShots)}];

it('projects the actual live two-shot visual_description response without mutating data or converting numeric shot_id into an invented native ID',()=>{
 const parts=visualOutputs(),before=structuredClone(parts),output=storyboardOutput(parts,{sceneCode:'storyboard-prompt-film'});
 expect(output.rows).toHaveLength(2);expect(output.rows.map((row:any)=>row.duration)).toEqual(['6','5']);expect(output.rows.map((row:any)=>row.id)).toEqual(['studio-shot-1','studio-shot-2']);
 for(let i=0;i<2;i++)expect(output.rows[i]).toMatchObject({description:before[0].data.shots[i].visual_description,storyboard_prompt:before[0].data.shots[i].image_prompt,video_prompt:before[0].data.shots[i].video_prompt,sound_effect:before[0].data.shots[i].sound});
 expect(parts).toEqual(before);expect(output.shots).toEqual(before[0].data.shots);expect(output.shots[0].shot_id).toBe(1);expect(output.storyboardEntities).toEqual({characters:[],scenes:[],props:[],products:[]});
});

it.each([['film','film'],['comic','comic'],['short-drama','shortDrama'],['mv','mv'],['knowledge','knowledge'],['ecommerce','ecommerce']])('accepts the same legitimate description fallback for published %s storyboard scene', (code,scene)=>{
 const output=storyboardOutput(visualOutputs(),{sceneCode:'storyboard-prompt-'+code});expect(output.outputScene).toBe(scene);expect(output.rows).toHaveLength(2);
});

it('keeps action then description authoritative when a distinct visual_description is also present, preserving all raw values',()=>{
 const parts=visualOutputs();parts[0].data.shots[0].action='动作文本';parts[0].data.shots[0].description='旧描述';const before=structuredClone(parts),output=storyboardOutput(parts,{sceneCode:'storyboard-prompt-film'});expect(output.rows[0].description).toBe('动作文本');expect(parts).toEqual(before);expect(output.shots[0].visual_description).toBe(before[0].data.shots[0].visual_description);
 delete parts[0].data.shots[0].action;expect(storyboardOutput(parts,{sceneCode:'storyboard-prompt-film'}).rows[0].description).toBe('旧描述');
});

it.each([undefined,null,42,{},[],true,'','   '])('does not coerce an invalid visual_description fallback %j into a visible shot',value=>{
 const parts=visualOutputs();parts[0].data.shots[0].visual_description=value;const before=structuredClone(parts);expect(()=>storyboardOutput(parts,{sceneCode:'storyboard-prompt-film'})).toThrow(/格式暂无法显示/);expect(parts).toEqual(before);
});

it('keeps strict schema, duration, image/video prompt and entity guards for visual_description shots',()=>{
 const node={sceneCode:'storyboard-prompt-film'};
 for(const edit of [(parts:any[])=>parts[0].schemaVersion='2',(parts:any[])=>parts[0].data.shots[0].duration_seconds=3,(parts:any[])=>parts[0].data.shots[0].duration_seconds=6.55,(parts:any[])=>parts[0].data.shots[0].image_prompt='',(parts:any[])=>parts[0].data.shots[0].video_prompt='',(parts:any[])=>parts[0].data.shots[0].characters=['unknown']]){const parts=visualOutputs();edit(parts);const before=structuredClone(parts);expect(()=>storyboardOutput(parts,node)).toThrow();expect(parts).toEqual(before);}
});

it('projects the actual company Codex storyboard into native readable rows while preserving every raw field',()=>{
 const parts=outputs(),before=structuredClone(parts),output=storyboardOutput(parts,frozen());
 expect(parts).toEqual(before);expect(output.shots).toEqual(before[0].data.shots);
 expect(output.outputScene).toBe('film');expect(output.rows).toHaveLength(2);
 expect(output.rows[0]).toMatchObject({id:'shot_01',shot:'1',duration:'6',description:before[0].data.shots[0].action+'\n【镜头】'+before[0].data.shots[0].camera,storyboard_prompt:before[0].data.shots[0].image_prompt,video_prompt:before[0].data.shots[0].video_prompt,film_style:'电影写实',characters:[{名称:'小焰',描述:before[0].data.characters[0].appearance,角色图:''}],scene:{名称:'月光下的庭院',描述:before[0].data.scenes[0].description,场景图:''},props:[{名称:'纸鹤',描述:before[0].data.props[0].appearance,道具图:''}]});
 for(const sound of Object.values(before[0].data.shots[0].sound))expect(output.rows[0].sound_effect).toContain(sound);
 expect(output.storyboardEntities.characters[0]).toEqual({id:'xiaoyan',name:'小焰',desc:before[0].data.characters[0].appearance,imageUrl:''});
 expect(output.scenes[0].reference.url).toBe(before[0].data.scenes[0].reference.url);
 expect(output.rows[0]).not.toHaveProperty('sceneId');expect(output.rows[0]).not.toHaveProperty('characterIds');
});

it('uses the real frozen pure native readers without importing or executing the UI bundle',()=>{
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
 const fn=(name:string,next:string)=>{const start=source.indexOf('function '+name+'('),end=source.indexOf(next,start+1);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);return source.slice(start,end);};
 const code=[fn('Vlt','function zlt('),fn('xl','function S8('),fn('Uc','function jZ('),fn('jZ','function Cxn('),fn('Cxn','function FZ('),fn('FZ','function YG('),fn('IA','function Xoe('),fn('hLe','function id('),fn('xm','function ps('),fn('ps','function S0n('),fn('Sd','const C0n=')].join('\n')+'\nthis.readRows=hLe;this.readEntities=Sd;';
 const fail=()=>{throw new Error('Wrong native parsing branch');};
 // hLe's entity normalizer is isolated; the inline entity field contract is
 // asserted above. The actual branch and actual duration rounding still run.
 const native:any={yD:4,WG:30,Bc:(row:any)=>row,TA:fail,Ku:fail,Qn:(value:any)=>String(value??'').trim(),na:(value:any)=>String(value??'').trim(),EZ:(value:any)=>value,_Z:fail};
 runInNewContext(code,native,{timeout:100});
 const output=storyboardOutput(outputs(),frozen()),rows=native.readRows(output,'film'),entities=native.readEntities(output);
 expect(rows).toHaveLength(2);expect(rows.map((row:any)=>row.duration)).toEqual(['6','7']);
 expect(rows[0].storyboard_prompt).toBe(fixture.task.plans[0].outputs[0].data.shots[0].image_prompt);
 expect(entities.characters[0].id).toBe('xiaoyan');expect(entities.props[0].name).toBe('纸鹤');expect(entities.scenes[0].imageUrl).toBe('');
});

it.each([2,31,6.55])('rejects duration %s instead of silently accepting native rounding or clamping',duration=>{
 const parts=outputs();parts[0].data.shots[0].duration_seconds=duration;
 expect(()=>storyboardOutput(parts,frozen())).toThrow(/原始时长已保留/);
 expect(parts[0].data.shots[0].duration_seconds).toBe(duration);
});

it('rejects unknown shapes, missing frozen config and unresolved references, retaining the original data',()=>{
 const parts=outputs(),original=structuredClone(parts);
 expect(()=>storyboardOutput(parts,undefined)).toThrow(/配置不可验证/);
 expect(()=>storyboardOutput([{...parts[0],data:{unexpected:'result'}}],frozen())).toThrow(/格式暂无法显示/);
 parts[0].data.shots[0].characters=['unknown'];expect(()=>storyboardOutput(parts,frozen())).toThrow(/无法唯一解析/);
 expect(parts[0].data.shots[1]).toEqual(original[0].data.shots[1]);
 const unknown=frozen();unknown.sceneCode='unknown';unknown.styleName='unknown';(unknown.params as any).scene='auto';
 (parts[0].data as any).outputScene='film';expect(()=>storyboardOutput(parts,unknown)).toThrow(/场景尚未确认/);
});

it('clears only exact native script stage fields, preserving custom and test badges',()=>{
 expect(scriptTerminalFields({customBadgeText:'正在生成分镜表，请稍后',pendingOutputScene:'film'})).toEqual({customBadgeText:'',pendingOutputScene:null});
 expect(scriptTerminalFields({customBadgeText:'Generating the storyboard table, please wait…'})).toEqual({customBadgeText:''});
 expect(scriptTerminalFields({customBadgeText:'TEST MODE',pendingOutputScene:'other-task'})).toEqual({});
 expect(scriptTerminalFields({customBadgeText:'用户备注'})).toEqual({});
});
