import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDirectMessagePeer } from './dm-policy.js';
test('everyone policy allows unless blocked',()=>{assert.equal(canDirectMessagePeer('everyone',false,false),true);assert.equal(canDirectMessagePeer('everyone',false,true),false);});
test('friends policy requires friendship',()=>{assert.equal(canDirectMessagePeer('friends',true,false),true);assert.equal(canDirectMessagePeer('friends',false,false),false);});
test('nobody policy rejects even friends',()=>assert.equal(canDirectMessagePeer('nobody',true,false),false));
