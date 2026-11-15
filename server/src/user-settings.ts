import {z} from 'zod';

export const DEFAULT_USER_SETTINGS = {
  theme:'graphite',density:'comfortable',messageLayout:'cozy',fontScale:100,reducedMotion:false,contrast:'normal',
  quietMode:false,dmNotifications:true,mentionNotifications:true,browserNotifications:false,
  keybinds:{focusSearch:'Ctrl+K',toggleMembers:'Ctrl+Shift+M'},
  voiceInputDeviceId:'',voiceOutputDeviceId:'',sidebarWidth:292,messageRadius:12,fontFamily:'system',
  customTheme:{bg:'#19211d',panel:'#202b25',panel2:'#29372f',panel3:'#34443a',line:'#405247',lineStrong:'#5e7668',muted:'#a8b8ac',text:'#edf4ee',accent:'#82a594',accentHover:'#9bbbac',accentSoft:'#31493e',buttonText:'#14221b'}
};
const customThemeColorsSchema=z.object({
  bg:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),panel:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  panel2:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),panel3:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  line:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),lineStrong:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  muted:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),text:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accent:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),accentHover:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentSoft:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),buttonText:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
}).strict();
function isValidShortcut(value:string){
 const parts=value.toLowerCase().split('+');
 if(parts.length<2||parts.some(part=>!part))return false;
 const modifiers=new Set(['ctrl','control','meta','cmd','command','shift','alt']);
 const key=parts[parts.length-1];
 if(modifiers.has(key)||!parts.slice(0,-1).every(part=>modifiers.has(part)))return false;
 const canonical=parts.slice(0,-1).map(part=>part==='control'?'ctrl':(part==='cmd'||part==='command')?'meta':part);
 return new Set(canonical).size===canonical.length;
}

export const userSettingsPatchSchema=z.object({
  theme:z.enum(['graphite','slate','warm','light','custom']).optional(),
  density:z.enum(['comfortable','compact']).optional(),messageLayout:z.enum(['cozy','compact']).optional(),
  fontScale:z.number().int().min(85).max(125).optional(),reducedMotion:z.boolean().optional(),contrast:z.enum(['normal','high']).optional(),
  quietMode:z.boolean().optional(),dmNotifications:z.boolean().optional(),mentionNotifications:z.boolean().optional(),browserNotifications:z.boolean().optional(),
  keybinds:z.object({focusSearch:z.string().min(1).max(40).regex(/^[A-Za-z0-9+]+$/).refine(isValidShortcut,'Enter a shortcut with modifiers and one final key.').optional(),toggleMembers:z.string().min(1).max(40).regex(/^[A-Za-z0-9+]+$/).optional()}).partial().optional(),
  voiceInputDeviceId:z.string().max(256).optional(),voiceOutputDeviceId:z.string().max(256).optional(),
  customTheme:customThemeColorsSchema.optional(),sidebarWidth:z.number().int().min(250).max(380).optional(),
  messageRadius:z.number().int().min(6).max(24).optional(),fontFamily:z.enum(['system','serif','mono']).optional()
}).strict();

export function mergeUserSettings(...sources: Record<string,any>[]) {
  const merged=Object.assign({},...sources);
  merged.keybinds=Object.assign({},DEFAULT_USER_SETTINGS.keybinds,...sources.map(source=>source?.keybinds||{}));
  merged.customTheme=Object.assign({},DEFAULT_USER_SETTINGS.customTheme,...sources.map(source=>source?.customTheme||{}));
  return merged;
}

export function requiresBoostSettings(patch: Record<string,any>) {
  return patch.theme==='custom' || ['customTheme','sidebarWidth','messageRadius','fontFamily'].some(key=>Object.prototype.hasOwnProperty.call(patch,key));
}

export function normalizeSettingsForEntitlement(settings:Record<string,any>,boostActive:boolean){
 if(boostActive)return settings;
 return {
  ...settings,
  theme:settings.theme==='custom'?'graphite':settings.theme,
  sidebarWidth:DEFAULT_USER_SETTINGS.sidebarWidth,
  messageRadius:DEFAULT_USER_SETTINGS.messageRadius,
  fontFamily:DEFAULT_USER_SETTINGS.fontFamily
 };
}
