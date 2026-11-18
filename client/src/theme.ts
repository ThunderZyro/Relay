export type RelayThemeColors={bg:string;panel:string;panel2:string;panel3:string;line:string;lineStrong:string;muted:string;text:string;accent:string;accentHover:string;accentSoft:string;buttonText:string};
const properties:Record<keyof RelayThemeColors,string>={
 bg:'--bg',panel:'--panel',panel2:'--panel-2',panel3:'--panel-3',line:'--line',lineStrong:'--line-strong',muted:'--muted',text:'--text',
 accent:'--accent',accentHover:'--accent-hover',accentSoft:'--accent-soft',buttonText:'--button-text'
};
const presets=new Set(['graphite','slate','warm','light']);
export function applyRelayAppearance(settings:Record<string,any>={},boostActive=false){
 const root=document.documentElement;
 const custom=settings.theme==='custom'&&boostActive&&settings.customTheme;
 root.dataset.theme=custom?'custom':(presets.has(settings.theme)?settings.theme:'graphite');
 root.dataset.density=settings.density==='compact'?'compact':'comfortable';
 root.dataset.messageLayout=settings.messageLayout==='compact'?'compact':'cozy';
 root.dataset.motion=settings.reducedMotion?'reduced':'full';
 root.dataset.contrast=settings.contrast==='high'?'high':'normal';
 for(const [key,property] of Object.entries(properties) as [keyof RelayThemeColors,string][]){
  const value=custom?settings.customTheme?.[key]:undefined;
  if(typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value))root.style.setProperty(property,value);
  else root.style.removeProperty(property);
 }
 const fontScale=Number(settings.fontScale);root.style.setProperty('--font-scale',`${Number.isFinite(fontScale)?Math.min(125,Math.max(85,fontScale)):100}%`);
 const sidebarWidth=boostActive?Number(settings.sidebarWidth):292;root.style.setProperty('--custom-sidebar-width',`${Number.isFinite(sidebarWidth)?Math.min(380,Math.max(250,sidebarWidth)):292}px`);
 const radius=boostActive?Number(settings.messageRadius):12;root.style.setProperty('--custom-message-radius',`${Number.isFinite(radius)?Math.min(24,Math.max(6,radius)):12}px`);
 const fonts:Record<string,string>={system:'Inter,ui-sans-serif,system-ui,sans-serif',serif:'Georgia,"Times New Roman",serif',mono:'"SFMono-Regular",Consolas,"Liberation Mono",monospace'};
 root.style.setProperty('--relay-font-family',boostActive?(fonts[settings.fontFamily]||fonts.system):fonts.system);
 if(custom){
  const bg=String(settings.customTheme?.bg||'#191c20');
  const channels=bg.match(/^#([0-9a-f]{6})$/i)?.[1];
  if(channels){
   const values=[0,2,4].map(offset=>parseInt(channels.slice(offset,offset+2),16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
   const luminance=0.2126*values[0]+0.7152*values[1]+0.0722*values[2];
   root.style.colorScheme=luminance>0.42?'light':'dark';
  }else root.style.removeProperty('color-scheme');
 }else root.style.removeProperty('color-scheme');
 const themeColor=getComputedStyle(root).getPropertyValue('--bg').trim();
 document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content',themeColor||'#191c20');
}
