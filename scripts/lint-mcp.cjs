// TypeScript AST lint for the security-sensitive MCP modules.
const ts=require('../api/node_modules/typescript');
const fs=require('node:fs');
let errors=0;
for(const file of ['api/src/mcp.ts','api/src/mcp-policy.ts']){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 function visit(node){
  if(node.kind===ts.SyntaxKind.AnyKeyword || (ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='console')){console.error(`${file}: avoid any and console logging`);errors++;}
  ts.forEachChild(node,visit);
 }
 visit(source);
}
process.exitCode=errors?1:0;
