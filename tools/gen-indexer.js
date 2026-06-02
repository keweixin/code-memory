const fs=require("fs");
const p=require("path");
const base=p.resolve("C:/Users/ASUS/code-memory/src");
function w(rel,c){const t=p.join(base,rel);fs.mkdirSync(p.dirname(t),{recursive:true});fs.writeFileSync(t,c);console.log("OK: "+rel);}
const _=String.raw;