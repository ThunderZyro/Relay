import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isSafeProfileMediaUrl} from './profile-policy.js';

test('allows an empty profile image URL so a user can clear the field',()=>{
 assert.equal(isSafeProfileMediaUrl(''),true);
 assert.equal(isSafeProfileMediaUrl(null),true);
});
test('allows HTTP and HTTPS profile image URLs',()=>{
 assert.equal(isSafeProfileMediaUrl('https://cdn.example.com/avatar.png'),true);
 assert.equal(isSafeProfileMediaUrl('http://example.com/banner.jpg'),true);
});
test('rejects script, data and relative URLs',()=>{
 assert.equal(isSafeProfileMediaUrl('javascript:alert(1)'),false);
 assert.equal(isSafeProfileMediaUrl('data:image/svg+xml,<svg/>'),false);
 assert.equal(isSafeProfileMediaUrl('/uploads/avatar.png'),false);
 assert.equal(isSafeProfileMediaUrl('not a URL'),false);
});
