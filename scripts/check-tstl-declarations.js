'use strict';
// TSTL currently hoists optional-chain/nullish temporaries before a whole
// VariableDeclarationList. A conditional initializer must not read a sibling
// declaration in that same list: Lua can resolve that name as a global nil.
const ts=require('typescript'),fs=require('node:fs'),path=require('node:path');
function checkSource(source,filename='input.ts'){
 const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true),issues=[];
 const bindingNames=name=>ts.isIdentifier(name)?[name.text]:name.elements.flatMap(e=>ts.isBindingElement(e)?bindingNames(e.name):[]);
 const visit=node=>{
  if(ts.isVariableDeclarationList(node)&&node.declarations.length>1){
   const previous=new Set();
   for(const declaration of node.declarations){
    let conditional=false;const reads=new Set();
    const inspect=n=>{
     if(n.questionDotToken||ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken)conditional=true;
     if(ts.isIdentifier(n)){
      const p=n.parent;
      if(!(ts.isPropertyAccessExpression(p)&&p.name===n)&&!(ts.isPropertyAssignment(p)&&p.name===n))reads.add(n.text);
     }
     ts.forEachChild(n,inspect);
    };
    if(declaration.initializer)inspect(declaration.initializer);
    const siblings=[...previous].filter(n=>reads.has(n));
    if(conditional&&siblings.length){const pos=file.getLineAndCharacterOfPosition(declaration.getStart(file));issues.push({file:filename,line:pos.line+1,names:siblings});}
    for(const name of bindingNames(declaration.name))previous.add(name);
   }
  }
  ts.forEachChild(node,visit);
 };
 visit(file);return issues;
}
function main(){
 const root=path.resolve(__dirname,'../src'),issues=[];
 const scan=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(e.isDirectory()){if(e.name!=='gen')scan(path.join(dir,e.name));}
  else if(e.name.endsWith('.ts')&&!e.name.endsWith('.test.ts')&&e.name!=='default_config.ts'){
   const file=path.join(dir,e.name);issues.push(...checkSource(fs.readFileSync(file,'utf8'),path.relative(root,file)));
  }
 }};scan(root);
 for(const i of issues)console.error(`${i.file}:${i.line}: conditional initializer reads sibling ${i.names.join(', ')}; split the declarations before compiling Lua`);
 if(issues.length)process.exitCode=1;else console.log('PASS TSTL declaration ordering');
}
module.exports={checkSource};if(require.main===module)main();
