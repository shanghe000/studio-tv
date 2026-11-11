import {equalDraftValue} from './canvas-draft';
import type {Capability} from './model-catalog';
import {preflightError,preflightParameterNames,preflightParameterRules,type PreflightParameterRule} from './preflight';

export interface ParameterSchemaFailure {path:(string|number)[];rule:string;schemaError?:boolean}
const object=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const annotations=new Set(['$schema','$id','$anchor','$comment','$defs','definitions','title','description','default','examples','deprecated','readOnly','writeOnly']);
const assertions=new Set(['$ref','type','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','properties','patternProperties','required','additionalProperties','minProperties','maxProperties','propertyNames','dependentRequired','dependentSchemas','dependencies','items','prefixItems','additionalItems','minItems','maxItems','uniqueItems','contains','minContains','maxContains','allOf','anyOf','oneOf','not','if','then','else']);
const types=new Set(['null','boolean','object','array','number','integer','string']);
const decimal=(value:number):[bigint,number]=>{const [coefficient,exponent='0']=value.toString().split('e'),parts=coefficient.split('.');return[BigInt(parts.join('')),Number(exponent)-(parts[1]?.length??0)];};
const multiple=(value:number,step:number)=>{if(!Number.isFinite(step)||step<=0)return false;const [a,ae]=decimal(value),[b,be]=decimal(step),shift=Math.min(ae,be);return(a*10n**BigInt(ae-shift))%(b*10n**BigInt(be-shift))===0n;};

/** Bounded implementation of the catalog's JSON Schema assertions. Unsupported
 * assertions are an explicit error, never an unvalidated successful submission.
 * Values are checked after native UI fields have been projected out. */
export function parameterSchemaFailure(schema:any,value:any):ParameterSchemaFailure|null {
 const root=schema===undefined?{}:schema,fail=(path:(string|number)[],rule:string,schemaError=false):ParameterSchemaFailure=>({path,rule,...(schemaError?{schemaError:true}:{})});
 const reference=(ref:any):any=>{
  if(ref==='#')return root;if(typeof ref!=='string'||!ref.startsWith('#/'))return undefined;
  let result=root;for(const part of ref.slice(2).split('/')){let key:string;try{key=decodeURIComponent(part).replaceAll('~1','/').replaceAll('~0','~');}catch{return undefined;}if(!object(result)||!Object.hasOwn(result,key))return undefined;result=result[key];}return result;
 };
 const seen=new Set<any>();let schemaNodes=0;
 const inspect=(field:any,depth=0):ParameterSchemaFailure|null=>{
  if(typeof field==='boolean')return null;if(!object(field)||depth>40||++schemaNodes>4096)return fail([],'unsupportedSchema',true);if(seen.has(field))return null;seen.add(field);
  for(const key of Object.keys(field))if(!annotations.has(key)&&!assertions.has(key)&&!key.startsWith('x-'))return fail([],'unsupportedSchema',true);
  if(field.type!==undefined&&!(typeof field.type==='string'?types.has(field.type):Array.isArray(field.type)&&field.type.length&&field.type.every((kind:any)=>types.has(kind))))return fail([],'unsupportedSchema',true);
  if(field.pattern!==undefined){try{new RegExp(field.pattern,'u');}catch{return fail([],'unsupportedSchema',true);}}
  if(field.$ref!==undefined){const target=reference(field.$ref);if(target===undefined)return fail([],'unsupportedSchema',true);const problem=inspect(target,depth+1);if(problem)return problem;}
  for(const key of ['properties','patternProperties','$defs','definitions','dependentSchemas'])if(field[key]!==undefined){if(!object(field[key]))return fail([],'unsupportedSchema',true);for(const sub of Object.values(field[key])){const problem=inspect(sub,depth+1);if(problem)return problem;}}
  for(const key of ['allOf','anyOf','oneOf','prefixItems'])if(field[key]!==undefined){if(!Array.isArray(field[key]))return fail([],'unsupportedSchema',true);for(const sub of field[key]){const problem=inspect(sub,depth+1);if(problem)return problem;}}
  for(const key of ['additionalProperties','additionalItems','propertyNames','contains','not','if','then','else'])if(field[key]!==undefined){const problem=inspect(field[key],depth+1);if(problem)return problem;}
  if(field.items!==undefined){for(const sub of Array.isArray(field.items)?field.items:[field.items]){const problem=inspect(sub,depth+1);if(problem)return problem;}}
  if(field.dependencies!==undefined){if(!object(field.dependencies))return fail([],'unsupportedSchema',true);for(const sub of Object.values(field.dependencies))if(!Array.isArray(sub)){const problem=inspect(sub,depth+1);if(problem)return problem;}}
  return null;
 };
 const unsupported=inspect(root);if(unsupported)return unsupported;
 let comparisons=0;
 const check=(field:any,item:any,path:(string|number)[],depth=0):ParameterSchemaFailure|null=>{
  if(depth>64||++comparisons>20000)return fail(path,'complexity',true);if(field===true)return null;if(field===false)return fail(path,'forbidden');
  if(field.$ref!==undefined){const problem=check(reference(field.$ref),item,path,depth+1);if(problem)return problem;}
  const isType=(kind:string)=>kind==='null'?item===null:kind==='object'?object(item):kind==='array'?Array.isArray(item):kind==='integer'?Number.isSafeInteger(item):kind==='number'?typeof item==='number'&&Number.isFinite(item):typeof item===kind;
  if(field.type!==undefined&&!(Array.isArray(field.type)?field.type:[field.type]).some(isType))return fail(path,'type');
  if(field.enum!==undefined&&(!Array.isArray(field.enum)||!field.enum.some((option:any)=>equalDraftValue(option,item))))return fail(path,'enum');
  if(Object.hasOwn(field,'const')&&!equalDraftValue(field.const,item))return fail(path,'const');
  for(const sub of field.allOf??[]){const problem=check(sub,item,path,depth+1);if(problem)return problem;}
  if(field.anyOf&&!field.anyOf.some((sub:any)=>check(sub,item,path,depth+1)===null))return fail(path,'anyOf');
  if(field.oneOf&&field.oneOf.filter((sub:any)=>check(sub,item,path,depth+1)===null).length!==1)return fail(path,'oneOf');
  if(field.not&&check(field.not,item,path,depth+1)===null)return fail(path,'not');
  if(field.if!==undefined){const branch=check(field.if,item,path,depth+1)===null?field.then:field.else;if(branch!==undefined){const problem=check(branch,item,path,depth+1);if(problem)return problem;}}
  if(typeof item==='number'){
   if(!Number.isFinite(item))return fail(path,'type');
   if(field.minimum!==undefined&&item<field.minimum||field.exclusiveMinimum!==undefined&&typeof field.exclusiveMinimum==='number'&&item<=field.exclusiveMinimum||field.exclusiveMinimum===true&&item<=field.minimum)return fail(path,'minimum');
   if(field.maximum!==undefined&&item>field.maximum||field.exclusiveMaximum!==undefined&&typeof field.exclusiveMaximum==='number'&&item>=field.exclusiveMaximum||field.exclusiveMaximum===true&&item>=field.maximum)return fail(path,'maximum');
   if(field.multipleOf!==undefined&&!multiple(item,field.multipleOf))return fail(path,'multipleOf');
  }
  if(typeof item==='string'){
   const length=[...item].length;if(field.minLength!==undefined&&length<field.minLength)return fail(path,'minLength');if(field.maxLength!==undefined&&length>field.maxLength)return fail(path,'maxLength');if(field.pattern!==undefined&&!new RegExp(field.pattern,'u').test(item))return fail(path,'pattern');
  }
  if(Array.isArray(item)){
   if(field.minItems!==undefined&&item.length<field.minItems)return fail(path,'minItems');if(field.maxItems!==undefined&&item.length>field.maxItems)return fail(path,'maxItems');
   if(field.uniqueItems&&item.some((a,index)=>item.slice(0,index).some(b=>equalDraftValue(a,b))))return fail(path,'uniqueItems');
   if(field.contains!==undefined){const count=item.filter((child,index)=>check(field.contains,child,[...path,index],depth+1)===null).length;if(count<(field.minContains??1)||field.maxContains!==undefined&&count>field.maxContains)return fail(path,'contains');}
   for(let index=0;index<item.length;index++){
    const tuple=field.prefixItems??(Array.isArray(field.items)?field.items:undefined),sub=tuple?index<tuple.length?tuple[index]:field.prefixItems?field.items:field.additionalItems:field.items;
    if(sub!==undefined){const problem=check(sub,item[index],[...path,index],depth+1);if(problem)return problem;}
   }
  }
  if(object(item)){
   const keys=Object.keys(item);if(field.minProperties!==undefined&&keys.length<field.minProperties)return fail(path,'minProperties');if(field.maxProperties!==undefined&&keys.length>field.maxProperties)return fail(path,'maxProperties');
   for(const key of field.required??[])if(!Object.hasOwn(item,key))return fail([...path,key],'required');
   for(const [key,child]of Object.entries(item)){
    if(field.propertyNames!==undefined){const problem=check(field.propertyNames,key,path,depth+1);if(problem)return problem;}
    let matched=false;if(Object.hasOwn(field.properties??{},key)){matched=true;const problem=check(field.properties[key],child,[...path,key],depth+1);if(problem)return problem;}
    for(const [pattern,sub]of Object.entries(field.patternProperties??{})){let matches:boolean;try{matches=new RegExp(pattern,'u').test(key);}catch{return fail(path,'unsupportedSchema',true);}if(matches){matched=true;const problem=check(sub,child,[...path,key],depth+1);if(problem)return problem;}}
    if(!matched&&field.additionalProperties!==undefined){const problem=check(field.additionalProperties,child,[...path,key],depth+1);if(problem)return {...problem,rule:field.additionalProperties===false?'additionalProperties':problem.rule};}
   }
   for(const vocabulary of [field.dependencies,field.dependentRequired,field.dependentSchemas])for(const [key,dependents]of Object.entries(vocabulary??{}))if(Object.hasOwn(item,key)){
     if(Array.isArray(dependents)){for(const required of dependents)if(!Object.hasOwn(item,required))return fail([...path,required],'required');}
     else{const problem=check(dependents,item,path,depth+1);if(problem)return problem;}
    }
  }
  return null;
 };
 return check(root,value,[]);
}

export function validateCapabilityParameters(cap:Capability,value:Record<string,any>):void {
 const failure=parameterSchemaFailure(cap.parameterSchema===undefined?{}:cap.parameterSchema,value);if(!failure)return;
 let field=cap.parameterSchema;const labels:string[]=[];
 for(const key of failure.path){if(typeof key==='number'){labels.push(`第 ${key+1} 项`);field=field?.items;continue;}field=field?.properties?.[key];if(field&&/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))labels.push(typeof field.title==='string'?field.title.slice(0,80):key);}
 const name=labels.length?`参数 ${labels.join(' / ')}`:'模型参数';
 const explanations:Record<string,string>={required:'尚未填写',type:'类型不受当前模型支持',enum:'不是当前模型支持的选项',const:'不符合当前模型要求',minimum:'低于当前模型支持的范围下限',maximum:'超过当前模型支持的范围上限',multipleOf:'不符合当前模型支持的步长',minLength:'内容长度不足',maxLength:'内容长度超过上限',pattern:'格式不正确',minItems:'数量不足',maxItems:'数量超过上限',uniqueItems:'包含重复项',additionalProperties:'包含当前模型未声明的字段',forbidden:'不允许使用',anyOf:'不符合当前模型支持的组合',oneOf:'不符合当前模型要求的唯一组合',not:'使用了当前模型不允许的组合',contains:'缺少符合要求的项目'};
 const parameterPath=safeSchemaParameterPath(cap.parameterSchema,failure.path),parameterRule=preflightParameterRules.includes(failure.rule as any)?failure.rule as PreflightParameterRule:'unsupportedSchema';
 throw preflightError('MODEL_PARAMETER_INVALID',failure.schemaError?'当前模型的参数规则暂不受支持，请重新选择模型或联系管理员。':`${name}${explanations[failure.rule]??'不符合当前模型要求'}，请检查后再提交。`,cap,{requestedKind:cap.kind,issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',...(parameterPath.length?{parameterPath}:{}),parameterRule}]});
}

/** Follow declarations, not the rejected value's object keys. For an unknown
 * additional property, keep only its declared parent path. Local refs and
 * combinator branches do not turn arbitrary map keys into schema properties. */
function safeSchemaParameterPath(root:any,path:(string|number)[]):(string|number)[]{
 const resolve=(field:any)=>{const ref=field?.$ref;if(typeof ref!=='string'||!ref.startsWith('#/'))return undefined;let value=root;for(const key of ref.slice(2).split('/')){let decoded:string;try{decoded=decodeURIComponent(key).replaceAll('~1','/').replaceAll('~0','~');}catch{return undefined;}if(!object(value)||!Object.hasOwn(value,decoded))return undefined;value=value[decoded];}return value;};
 const expand=(fields:any[])=>{const result:any[]=[],seen=new Set<any>();const visit=(field:any,depth=0)=>{if(!object(field)||seen.has(field)||depth>32)return;seen.add(field);result.push(field);visit(resolve(field),depth+1);for(const key of ['allOf','anyOf','oneOf'])for(const sub of field[key]??[])visit(sub,depth+1);for(const key of ['if','then','else'])visit(field[key],depth+1);};fields.forEach(field=>visit(field));return result;};
 const safe:(string|number)[]=[];let fields=[root];
 for(const part of path.slice(0,12)){
  const expanded=expand(fields);let next:any[]=[];
  if(typeof part==='string'){
   if(!preflightParameterNames.includes(part as any))break;
   next=expanded.flatMap(field=>Object.hasOwn(field.properties??{},part)?[field.properties[part]]:Array.isArray(field.required)&&field.required.includes(part)?[{}]:[]);
  }else if(Number.isSafeInteger(part)&&part>=0&&part<=9999)next=expanded.flatMap(field=>{const tuple=field.prefixItems??(Array.isArray(field.items)?field.items:undefined),item=tuple?tuple[part]??(field.prefixItems?field.items:field.additionalItems):field.items;return item===undefined?[]:[item];});
  if(!next.length)break;safe.push(part);fields=next;
 }
 return safe;
}
