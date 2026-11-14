import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.cwd(),process.env.UPLOAD_DIR||'../uploads');
const bucket=process.env.RELAY_UPLOAD_BUCKET||'relay-uploads';
const requiredStorageEnvironment=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_ENDPOINT_URL_S3','AWS_REGION'] as const;
export const missingStorageEnvironment=requiredStorageEnvironment.filter(key=>!process.env[key]?.trim());
const cloudReady=missingStorageEnvironment.length===0;
const s3=cloudReady?new S3Client({region:process.env.AWS_REGION,endpoint:process.env.AWS_ENDPOINT_URL_S3,forcePathStyle:true,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID!,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY!}}):null;

export const persistentStorageEnabled=!!s3;
export async function storeUpload(bytes:Buffer,mime:string,key=crypto.randomUUID()):Promise<string>{
 if(s3){await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentType:mime}));return key;}
 await fs.mkdir(uploadDir,{recursive:true});await fs.writeFile(path.join(uploadDir,key),bytes,{flag:'wx'});return key;
}
export async function readUpload(key:string):Promise<Buffer>{
 if(path.basename(key)!==key)throw new Error('Invalid storage key.');
 if(s3){const result=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));if(!result.Body)throw new Error('Stored file is empty.');return Buffer.from(await result.Body.transformToByteArray());}
 return fs.readFile(path.join(uploadDir,key));
}
export async function deleteUpload(key:string):Promise<void>{
 if(path.basename(key)!==key)return;
 if(s3){await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));return;}
 await fs.rm(path.join(uploadDir,key),{force:true});
}
