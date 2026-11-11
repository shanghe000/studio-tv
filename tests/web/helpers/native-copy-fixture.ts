import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const ast=ts.createSourceFile('native.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),declarations=new Map<string,string>();
for(const statement of ast.statements){
 if(ts.isFunctionDeclaration(statement)&&statement.name)declarations.set(statement.name.text,statement.getText(ast));
 if(ts.isVariableStatement(statement))for(const row of statement.declarationList.declarations)if(ts.isIdentifier(row.name))declarations.set(row.name.text,'const '+row.getText(ast)+';');
}
const names=['Xs','c7','Adn','ms','Ddn','ja','Wc','Hdn','bWn','O2e','Hvt','dFe','CWn','EWn','iee','yWn','xWn','Xie','j2e','_Wn','vbt'];
const body=names.map(name=>{const body=declarations.get(name);if(!body)throw Error('Frozen native copy seam changed: '+name);return body;}).join('\n');
export const nativeCopy=(manager:any)=>new Function('Ln','aee',body+';return{clone:iee,read:j2e,drag:_Wn,duplicate:vbt};')(()=>manager,({preferredX:x,preferredY:y}:any)=>({x,y}));
const start=source.indexOf('const u1n='),end=source.indexOf('function WXr(',start);
if(start<0||end<0)throw Error('Frozen normalization changed');
export const normalize=new Function(source.slice(start,end)+';return oL;')();
// Jrr is the native image composer gate: uploaded/no-input image nodes omit
// their generation panel even if a model tuple and output are also present.
export const nativeImageUploadOnly=new Function(declarations.get('Jrr')+';return Jrr;')();
