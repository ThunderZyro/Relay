export function isSafeProfileMediaUrl(value:string|null|undefined):boolean{
 if(value===null||value===undefined||value.trim()==='')return true;
 try{
  const parsed=new URL(value);
  return (parsed.protocol==='https:'||parsed.protocol==='http:')&&!!parsed.hostname;
 }catch{return false;}
}
