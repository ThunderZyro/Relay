import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {verifyStripeWebhookSignature} from './boost.js';
function signed(payload:Buffer,secret:string,timestamp:number){
 const digest=crypto.createHmac('sha256',secret).update(`${timestamp}.${payload.toString('utf8')}`).digest('hex');
 return `t=${timestamp},v1=${digest}`;
}
test('accepts a valid Stripe webhook signature',()=>{
 const payload=Buffer.from('{"type":"checkout.session.completed"}'),now=1_800_000_000_000;
 assert.equal(verifyStripeWebhookSignature(payload,signed(payload,'whsec_test',now/1000),'whsec_test',now),true);
});
test('rejects an altered payload',()=>{
 const payload=Buffer.from('{"type":"checkout.session.completed"}'),now=1_800_000_000_000;
 assert.equal(verifyStripeWebhookSignature(Buffer.from('{"type":"customer.subscription.deleted"}'),signed(payload,'whsec_test',now/1000),'whsec_test',now),false);
});
test('rejects stale signatures and malformed headers',()=>{
 const payload=Buffer.from('{}'),now=1_800_000_000_000;
 assert.equal(verifyStripeWebhookSignature(payload,signed(payload,'whsec_test',now/1000-301),'whsec_test',now),false);
 assert.equal(verifyStripeWebhookSignature(payload,'v1=not-a-signature','whsec_test',now),false);
});

test('only grants Boost for the configured recurring price',()=>{
 assert.equal(stripeSubscriptionHasBoostPrice({items:{data:[{price:{id:'price_boost'}}]}},'price_boost'),true);
 assert.equal(stripeSubscriptionHasBoostPrice({items:{data:[{price:{id:'price_other'}}]}},'price_boost'),false);
 assert.equal(stripeSubscriptionHasBoostPrice({items:{data:[]}},'price_boost'),false);
 assert.equal(stripeSubscriptionHasBoostPrice({items:{data:[{price:{id:'price_boost'}}]}},''),false);
});
