import crypto from 'node:crypto';
/** Verify Stripe's signed raw webhook body and reject stale signatures. */
export function verifyStripeWebhookSignature(payload:Buffer,header:string,secret:string,nowMs=Date.now()):boolean{
 if(!Buffer.isBuffer(payload)||!header||!secret)return false;
 const parts=header.split(',').map(part=>part.trim());
 const timestamp=Number(parts.find(part=>part.startsWith('t='))?.slice(2));
 if(!Number.isFinite(timestamp)||timestamp<=0||Math.abs(Math.floor(nowMs/1000)-timestamp)>300)return false;
 const expected=crypto.createHmac('sha256',secret).update(`${timestamp}.${payload.toString('utf8')}`).digest();
 return parts.filter(part=>part.startsWith('v1=')).some(part=>{
  const value=part.slice(3);if(!/^[a-f0-9]{64}$/i.test(value))return false;
  const candidate=Buffer.from(value,'hex');return candidate.length===expected.length&&crypto.timingSafeEqual(candidate,expected);
 });
}
