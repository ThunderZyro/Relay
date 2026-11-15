import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_USER_SETTINGS,isBoostSubscriptionActive,mergeUserSettings,normalizeSettingsForEntitlement,requiresBoostSettings,userSettingsPatchSchema} from './user-settings.js';

test('accepts all four free themes and standard accessibility/layout preferences',()=>{
 for(const theme of ['graphite','slate','warm','light']){
  const result=userSettingsPatchSchema.safeParse({theme,density:'compact',messageLayout:'compact',fontScale:115,reducedMotion:true,contrast:'high'});
  assert.equal(result.success,true,theme);
 }
});

test('rejects unsupported fields and invalid appearance values',()=>{
 assert.equal(userSettingsPatchSchema.safeParse({theme:'neon'}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({fontScale:200}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({unknownFeature:true}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({customTheme:{accent:'javascript:alert(1)'}}).success,false);
});

test('allows only supported shortcut syntax and device identifiers',()=>{
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{focusSearch:'Ctrl+K'}}).success,true);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{focusSearch:'Ctrl+K!'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{focusSearch:'Ctrl+Shift'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{focusSearch:'Ctrl++K'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{focusSearch:'Ctrl+Control+K'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({voiceInputDeviceId:'device-1',voiceOutputDeviceId:'device-2'}).success,true);
});

test('merges keybinds and custom theme color patches without erasing other saved values',()=>{
 const prior={keybinds:{focusSearch:'Ctrl+J',toggleMembers:'Ctrl+Shift+M'},customTheme:{bg:'#010203',accent:'#aabbcc'}};
 const result=mergeUserSettings(DEFAULT_USER_SETTINGS,prior,{keybinds:{focusSearch:'Ctrl+L'},customTheme:{accent:'#112233'}});
 assert.equal(result.keybinds.focusSearch,'Ctrl+L');
 assert.equal(result.keybinds.toggleMembers,'Ctrl+Shift+M');
 assert.equal(result.customTheme.bg,'#010203');
 assert.equal(result.customTheme.accent,'#112233');
 assert.equal(result.customTheme.text,DEFAULT_USER_SETTINGS.customTheme.text);
});

test('free accounts can save free settings but not Boost-only customization',()=>{
 assert.equal(requiresBoostSettings({theme:'paper'}),false);
 assert.equal(requiresBoostSettings({theme:'light',density:'compact'}),false);
 assert.equal(requiresBoostSettings({theme:'custom'}),true);
 assert.equal(requiresBoostSettings({sidebarWidth:320}),true);
 assert.equal(requiresBoostSettings({messageRadius:18}),true);
 assert.equal(requiresBoostSettings({fontFamily:'serif'}),true);
 assert.equal(requiresBoostSettings({customTheme:{accent:'#ffffff'}}),true);
});

test('Boost accounts can validate and merge a complete custom appearance',()=>{
 const patch={theme:'custom',customTheme:{bg:'#111111',accent:'#abcdef'},sidebarWidth:340,messageRadius:20,fontFamily:'mono'};
 assert.equal(userSettingsPatchSchema.safeParse(patch).success,true);
 const result=mergeUserSettings(DEFAULT_USER_SETTINGS,patch);
 assert.equal(result.theme,'custom');
 assert.equal(result.sidebarWidth,340);
 assert.equal(result.customTheme.bg,'#111111');
 assert.equal(result.customTheme.panel,DEFAULT_USER_SETTINGS.customTheme.panel);
});

test('expired Boost removes all premium appearance effects but retains a free preset',()=>{
 const premium={theme:'custom',sidebarWidth:360,messageRadius:20,fontFamily:'mono',customTheme:{accent:'#123456'}};
 const free=normalizeSettingsForEntitlement(premium,false);
 assert.equal(free.theme,'graphite');
 assert.equal(free.sidebarWidth,DEFAULT_USER_SETTINGS.sidebarWidth);
 assert.equal(free.messageRadius,DEFAULT_USER_SETTINGS.messageRadius);
 assert.equal(free.fontFamily,DEFAULT_USER_SETTINGS.fontFamily);
 assert.equal(free.customTheme.accent,'#123456');
 const selectedFree=normalizeSettingsForEntitlement({...premium,theme:'warm'},false);
 assert.equal(selectedFree.theme,'warm');
});
test('active Boost preserves custom appearance settings',()=>{
 const premium={theme:'custom',sidebarWidth:360,messageRadius:20,fontFamily:'mono',customTheme:{accent:'#123456'}};
 assert.deepEqual(normalizeSettingsForEntitlement(premium,true),premium);
});

test('Boost requires a valid future billing period end',()=>{
 const now=1_800_000_000_000;
 assert.equal(isBoostSubscriptionActive('active',new Date(now+60_000).toISOString(),now),true);
 assert.equal(isBoostSubscriptionActive('trialing',new Date(now+60_000).toISOString(),now),true);
 assert.equal(isBoostSubscriptionActive('active',new Date(now-60_000).toISOString(),now),false);
 assert.equal(isBoostSubscriptionActive('active',null,now),false);
 assert.equal(isBoostSubscriptionActive('active','not-a-date',now),false);
 assert.equal(isBoostSubscriptionActive('past_due',new Date(now+60_000).toISOString(),now),false);
});


test('validates the member-panel shortcut with the same rules as search',()=>{
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{toggleMembers:'Ctrl+Shift+M'}}).success,true);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{toggleMembers:'Ctrl+Shift'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{toggleMembers:'Ctrl+Control+M'}}).success,false);
 assert.equal(userSettingsPatchSchema.safeParse({keybinds:{toggleMembers:'Ctrl++M'}}).success,false);
});
