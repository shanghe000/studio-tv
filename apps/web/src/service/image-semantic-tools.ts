/** Native tool controls are USER conditions for reference editing, not vendor
 * parameters or a claim of calibrated optical/3D transformations. */
export const semanticImageV3Tools=new Set(['IMAGE_REDRAW','IMAGE_ERASE','IMAGE_EXPAND','IMAGE_CUTOUT']);
export const semanticImageTools=new Set([...semanticImageV3Tools,'IMAGE_ENHANCE','IMAGE_MULTIANGLE','IMAGE_MULTI_ANGLE','IMAGE_LIGHT','IMAGE_MULTI_ANGLE_LIGHT','IMAGE_CUTOUT_TEXT']);
export const nativePortraitAlias='seedream-v5-pro-image-to-image';
export const nativePanoramaAlias='image-image-rhart-image-n-g31-flash-official';
export const panoramaScenes=new Set(['canvas-image-panorama-text','canvas-image-panorama-image']);
const numeric=(paramName:string,title:string,titleEn:string,paramValue:number,min:number,max:number,type='int',step=1)=>({paramName,title,titleEn,paramValue,min,max,type,step,paramDataType:type==='int'?'int':'float',display:true,required:true});
export function semanticImageModel(model:any,type:string){
 if(!semanticImageTools.has(type))return model;
 const angle=type==='IMAGE_MULTIANGLE'||type==='IMAGE_MULTI_ANGLE',light=type==='IMAGE_LIGHT'||type==='IMAGE_MULTI_ANGLE_LIGHT';
 const region=['IMAGE_REDRAW','IMAGE_ERASE','IMAGE_EXPAND'].includes(type),cutout=type==='IMAGE_CUTOUT',label=angle?'角度参考编辑':light?'光照参考编辑':cutout?'透明抠图':type==='IMAGE_REDRAW'?'区域重绘':type==='IMAGE_ERASE'?'区域擦除':type==='IMAGE_EXPAND'?'画布扩图':type==='IMAGE_ENHANCE'?'生成式画质修复':'去文字',description=type==='IMAGE_ENHANCE'?'重新生成以改善噪点、模糊与细节；不保证像素保持或2倍、4倍分辨率放大。':type==='IMAGE_EXPAND'?'根据原图与扩展画布进行语义编辑，原图细节也可能变化；所选尺寸用于画布参考，输出像素尺寸由模型决定。':region?'根据原图与标记区域进行语义编辑；区域外也可能重画，结果不保证像素保持。':cutout?'分离主体并输出真正透明的PNG背景；输出会验证透明通道，请检查主体边缘。':angle?'按角度与构图意图重新生成，结果不保证精确的三维角度或像素保持。':light?'按灯光方向、强度与颜色意图重新生成，结果不保证精确光学模拟或像素保持。':'识别并去除画面文字、补全背景；生成后请检查文字残留与主体细节。';
 const fields=angle?[numeric('horizontal_angle','旋转意图','Rotation intent',0,0,360),numeric('vertical_angle','倾斜意图','Tilt intent',0,-30,60),numeric('zoom','缩放意图','Zoom intent',.1,0,10,'float',.1)]:light?[numeric('light_azimuth','光源方位','Light azimuth',0,0,360),numeric('light_elevation','光源高度','Light elevation',30,-90,90),numeric('light_intensity','光照强度','Light intensity',50,0,100,'float'),{paramName:'light_color_hex',title:'光源颜色',titleEn:'Light color',type:'colorHex',paramDataType:'string',paramValue:'#FFFFFF',display:true,required:true}]:[];
 // The native remove-text handler otherwise writes its old "cutout" prompt
 // into every model with a PROMPT control; this tool uses its server recipe.
 const config=model.config.filter((field:any)=>!['imageUrls','imageUrl','transparentBackground'].includes(field.paramName)&&(field.paramName!=='prompt'||['IMAGE_REDRAW','IMAGE_ENHANCE'].includes(type)));
 config.unshift({paramName:'imageUrls',title:'参考图片',titleEn:'Reference image',type:'imageUrls',paramDataType:'arrayString',display:true,required:true,maxNum:semanticImageV3Tools.has(type)?4:1});
 return{...model,modelName:model.modelName+' · '+label,modelNameEn:model.modelNameEn+' · '+label,description,descriptionEn:description,generateNum:semanticImageV3Tools.has(type)?model.generateNum:[1],config:[...config,...fields],params:Object.fromEntries(fields.map(field=>[field.paramName,field.paramValue]))};
}
