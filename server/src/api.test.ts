import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const apiPath = 'http://127.0.0.1';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate a test port.'));
      const port = address.port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function startApi(port: number, uploadDir: string): { child: ChildProcess; logs: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      UPLOAD_DIR: uploadDir,
      SESSION_SECRET: 'relay-integration-test-secret-with-more-than-32-characters',
      CLIENT_ORIGIN: `http://127.0.0.1:${port + 1}`,
      MAX_USER_STORAGE_MB: '1',
      STAGED_UPLOAD_TTL_HOURS: '0.001'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  return { child, logs: () => output };
}

async function waitForApi(port: number, child: ChildProcess, getLogs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`API process exited before becoming healthy. ${getLogs()}`);
    try {
      const response = await fetch(`${apiPath}:${port}/api/health`);
      if (response.ok) return;
    } catch { /* The process is still starting. */ }
    await delay(250);
  }
  throw new Error(`API did not become healthy. ${getLogs()}`);
}

function sessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
  const cookie = cookies.map(value => value.split(';', 1)[0]).find(value => value.startsWith('relay_session='));
  assert.ok(cookie, 'registration should issue an HttpOnly session cookie');
  return cookie;
}

async function request<T>(port: number, route: string, options: { method?: string; cookie?: string; body?: unknown; origin?: string | null; requestMarker?: boolean } = {}): Promise<{ response: Response; data: T }> {
  const method = options.method || 'GET';
  const headers: Record<string,string> = {
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.cookie ? { cookie: options.cookie } : {})
  };
  if (!['GET','HEAD','OPTIONS'].includes(method.toUpperCase())) {
    if (options.origin !== null) headers.origin = options.origin || `http://127.0.0.1:${port + 1}`;
    if (options.requestMarker !== false) headers['x-relay-request'] = '1';
  }
  const response = await fetch(`${apiPath}:${port}/api${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json() as T;
  return { response, data };
}

async function uploadTextFile(port:number,cookie:string,size:number) {
  const form=new FormData();
  form.append('files',new Blob([new Uint8Array(size)],{type:'text/plain'}),`test-${size}.txt`);
  return fetch(`${apiPath}:${port}/api/uploads`,{
    method:'POST',
    headers:{cookie,origin:`http://127.0.0.1:${port+1}`,'x-relay-request':'1'},
    body:form
  });
}

test('validates accounts, bounds invites, enforces DM privacy and permissions, and preserves PostgreSQL data', { skip: process.env.RELAY_RUN_DB_TESTS !== 'true' }, async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a disposable PostgreSQL database when Relay integration tests are enabled.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-api-test-'));
  const port = await freePort();
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  let processOne = startApi(port, uploadDir);
  let processTwo: ReturnType<typeof startApi> | undefined;

  try {
    await waitForApi(port, processOne.child, processOne.logs);

    const missingRequestMarker = await request(port, '/auth/register', {
      method: 'POST',
      requestMarker: false,
      body: { email: 'csrf@example.test', username: 'csrf_test', password: 'relay-test-password-100' }
    });
    assert.equal(missingRequestMarker.response.status, 403, 'mutating API requests must carry the Relay request marker');

    const untrustedOrigin = await request(port, '/auth/register', {
      method: 'POST',
      origin: 'https://attacker.example',
      body: { email: 'origin@example.test', username: 'origin_test', password: 'relay-test-password-101' }
    });
    assert.equal(untrustedOrigin.response.status, 403, 'mutating API requests must come from a configured origin');

    const invalidRegistration = await request(port, '/auth/register', {
      method: 'POST', body: { email: 'not-an-email', username: 'x', password: 'short' }
    });
    assert.equal(invalidRegistration.response.status, 400, 'registration inputs must be validated');

    const aliceRegistration = await request<{ user: { id: string } }>(port, '/auth/register', {
      method: 'POST', body: { email: 'alice@example.test', username: 'alice_test', password: 'relay-test-password-001' }
    });
    assert.equal(aliceRegistration.response.status, 201);
    const aliceCookie = sessionCookie(aliceRegistration.response);

    const firstStagedUpload = await uploadTextFile(port,aliceCookie,700*1024);
    assert.equal(firstStagedUpload.status,201,'an upload under the user quota should be accepted');
    const firstUploadData=await firstStagedUpload.json() as {uploads:Array<{id:string}>};
    await delay(4200);
    const secondStagedUpload = await uploadTextFile(port,aliceCookie,700*1024);
    assert.equal(secondStagedUpload.status,201,'expired staged uploads must be cleaned before applying the storage quota');
    const expiredUpload = await request(port, `/uploads/${firstUploadData.uploads[0].id}`, {cookie:aliceCookie});
    assert.equal(expiredUpload.response.status,404,'expired staged uploads must no longer be retrievable');

    const duplicateRegistration = await request(port, '/auth/register', {
      method: 'POST', body: { email: 'alice@example.test', username: 'alice_other', password: 'relay-test-password-010' }
    });
    assert.equal(duplicateRegistration.response.status, 409, 'duplicate email accounts must be rejected');
    const invalidLogin = await request(port, '/auth/login', { method: 'POST', body: { login: 'alice_test', password: 'incorrect-password' } });
    assert.equal(invalidLogin.response.status, 401, 'invalid credentials must not create a session');
    const login = await request(port, '/auth/login', { method: 'POST', body: { login: 'alice_test', password: 'relay-test-password-001' } });
    assert.equal(login.response.status, 200, 'registered users must be able to log in');
    const temporaryCookie = sessionCookie(login.response);
    const sessionUser = await request<{ user: { username: string } }>(port, '/auth/me', { cookie: temporaryCookie });
    assert.equal(sessionUser.data.user.username, 'alice_test', 'the session cookie must authenticate protected routes');
    const loggedOut = await request(port, '/auth/logout', { method: 'POST', cookie: temporaryCookie });
    assert.equal(loggedOut.response.status, 200, 'logout should revoke the current session');
    const rejectedSession = await request(port, '/auth/me', { cookie: temporaryCookie });
    assert.equal(rejectedSession.response.status, 401, 'a logged-out cookie must no longer authenticate');

    const serverResult = await request<{ server: { id: string }; channelId: string }>(port, '/servers', {
      method: 'POST', cookie: aliceCookie, body: { name: 'Integration Garden', description: 'Created by the API integration test.' }
    });
    assert.equal(serverResult.response.status, 201);

    const inviteResult = await request<{ invite: { code: string } }>(port, `/servers/${serverResult.data.server.id}/invites`, {
      method: 'POST', cookie: aliceCookie, body: { expiresHours: 24, maxUses: 1 }
    });
    assert.equal(inviteResult.response.status, 201);

    const bobRegistration = await request<{ user: { id: string } }>(port, '/auth/register', {
      method: 'POST', body: { email: 'bob@example.test', username: 'bob_test', password: 'relay-test-password-002' }
    });
    assert.equal(bobRegistration.response.status, 201);
    const bobCookie = sessionCookie(bobRegistration.response);

    const preview = await request<{ invite: { server: { id: string } } }>(port, `/invites/${inviteResult.data.invite.code}`, { cookie: bobCookie });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.data.invite.server.id, serverResult.data.server.id);

    const joined = await request<{ serverId: string }>(port, `/invites/${inviteResult.data.invite.code}/join`, { method: 'POST', cookie: bobCookie, body: {} });
    assert.equal(joined.response.status, 200);

    const charlieRegistration = await request<{ user: { id: string } }>(port, '/auth/register', {
      method: 'POST', body: { email: 'charlie@example.test', username: 'charlie_test', password: 'relay-test-password-003' }
    });
    assert.equal(charlieRegistration.response.status, 201);
    const charlieCookie = sessionCookie(charlieRegistration.response);
    const exhaustedInvite = await request(port, `/invites/${inviteResult.data.invite.code}/join`, { method: 'POST', cookie: charlieCookie, body: {} });
    assert.equal(exhaustedInvite.response.status, 404, 'invite use limits must be enforced');

    const moderatorRole = await request<{role:{id:string}}>(port, `/servers/${serverResult.data.server.id}/roles`, {
      method:'POST',cookie:aliceCookie,body:{name:'Episode Moderator',permissions:['manage_roles','timeout_members','view_channels','send_messages']}
    });
    assert.equal(moderatorRole.response.status,201);
    const daveRegistration = await request<{user:{id:string}}>(port,'/auth/register',{
      method:'POST',body:{email:'dave@example.test',username:'dave_test',password:'relay-test-password-004'}
    });
    assert.equal(daveRegistration.response.status,201);
    const daveCookie=sessionCookie(daveRegistration.response);
    const daveInvite=await request<{invite:{code:string}}>(port,`/servers/${serverResult.data.server.id}/invites`,{
      method:'POST',cookie:aliceCookie,body:{expiresHours:24,maxUses:1}
    });
    assert.equal(daveInvite.response.status,201);
    const daveJoin=await request(port,`/invites/${daveInvite.data.invite.code}/join`,{method:'POST',cookie:daveCookie,body:{}});
    assert.equal(daveJoin.response.status,200);
    const roles=await request<{roles:Array<{id:string;name:string}>}>(port,`/servers/${serverResult.data.server.id}/roles`,{cookie:aliceCookie});
    const adminRole=roles.data.roles.find(role=>role.name==='Admin');
    const memberRole=roles.data.roles.find(role=>role.name==='Member');
    assert.ok(adminRole&&memberRole,'default server roles should exist');
    const assignModerator=await request(port,`/servers/${serverResult.data.server.id}/members/${bobRegistration.data.user.id}/role`,{
      method:'PATCH',cookie:aliceCookie,body:{roleId:moderatorRole.data.role.id}
    });
    assert.equal(assignModerator.response.status,200);
    const assignAdmin=await request(port,`/servers/${serverResult.data.server.id}/members/${daveRegistration.data.user.id}/role`,{
      method:'PATCH',cookie:aliceCookie,body:{roleId:adminRole.id}
    });
    assert.equal(assignAdmin.response.status,200);
    const demoteHigherMember=await request(port,`/servers/${serverResult.data.server.id}/members/${daveRegistration.data.user.id}/role`,{
      method:'PATCH',cookie:bobCookie,body:{roleId:memberRole.id}
    });
    assert.equal(demoteHigherMember.response.status,403,'a moderator cannot change the role of a higher-ranking member');
    const setSeniorTimeout=await request(port,`/servers/${serverResult.data.server.id}/members/${daveRegistration.data.user.id}/timeout`,{
      method:'POST',cookie:aliceCookie,body:{minutes:5}
    });
    assert.equal(setSeniorTimeout.response.status,200);
    const removeSeniorTimeout=await request(port,`/servers/${serverResult.data.server.id}/members/${daveRegistration.data.user.id}/timeout`,{
      method:'DELETE',cookie:bobCookie
    });
    assert.equal(removeSeniorTimeout.response.status,403,'a moderator cannot remove a timeout from a higher-ranking member');

    const revocableInvite = await request<{ invite: { code: string } }>(port, `/servers/${serverResult.data.server.id}/invites`, {
      method: 'POST', cookie: aliceCookie, body: { expiresHours: 24, maxUses: 5 }
    });
    assert.equal(revocableInvite.response.status, 201);
    const revoked = await request(port, `/invites/${revocableInvite.data.invite.code}`, { method: 'DELETE', cookie: aliceCookie });
    assert.equal(revoked.response.status, 200);
    const revokedPreview = await request(port, `/invites/${revocableInvite.data.invite.code}`, { cookie: charlieCookie });
    assert.equal(revokedPreview.response.status, 404, 'revoked invites must not be previewable');

    const friendRequest = await request<{ id: string }>(port, '/friends/request', {
      method: 'POST', cookie: bobCookie, body: { username: 'alice_test' }
    });
    assert.equal(friendRequest.response.status, 201);
    const bobFriendList = await request<{ friends: Array<{ id: string; status: string; direction: string; user: { username: string } }> }>(port, '/friends', { cookie: bobCookie });
    const bobView = bobFriendList.data.friends.find(friend => friend.id === friendRequest.data.id);
    assert.equal(bobView?.direction, 'outgoing', 'the requester must see the request as outgoing');
    assert.equal(bobView?.user.username, 'alice_test');
    const aliceFriendList = await request<{ friends: Array<{ id: string; status: string; direction: string; user: { username: string } }> }>(port, '/friends', { cookie: aliceCookie });
    const aliceView = aliceFriendList.data.friends.find(friend => friend.id === friendRequest.data.id);
    assert.equal(aliceView?.direction, 'incoming', 'the recipient must see the same request as incoming');
    assert.equal(aliceView?.user.username, 'bob_test');
    const selfRequest = await request(port, '/friends/request', { method: 'POST', cookie: aliceCookie, body: { username: 'alice_test' } });
    assert.equal(selfRequest.response.status, 400, 'users must not be able to send requests to themselves');
    const acceptedFriend = await request(port, `/friends/${friendRequest.data.id}/accept`, { method: 'POST', cookie: aliceCookie, body: {} });
    assert.equal(acceptedFriend.response.status, 200);
    const acceptedBobList = await request<{ friends: Array<{ id: string; status: string }> }>(port, '/friends', { cookie: bobCookie });
    assert.equal(acceptedBobList.data.friends.find(friend => friend.id === friendRequest.data.id)?.status, 'accepted');
    const acceptedAliceList = await request<{ friends: Array<{ id: string; status: string }> }>(port, '/friends', { cookie: aliceCookie });
    assert.equal(acceptedAliceList.data.friends.find(friend => friend.id === friendRequest.data.id)?.status, 'accepted');

    const cancelRequest = await request<{ id: string }>(port, '/friends/request', { method: 'POST', cookie: charlieCookie, body: { username: 'alice_test' } });
    assert.equal(cancelRequest.response.status, 201);
    const cancelOutgoing = await request<{ friends: Array<{ id: string; direction: string }> }>(port, '/friends', { cookie: charlieCookie });
    assert.equal(cancelOutgoing.data.friends.find(friend => friend.id === cancelRequest.data.id)?.direction, 'outgoing');
    const cancelIncoming = await request<{ friends: Array<{ id: string; direction: string }> }>(port, '/friends', { cookie: aliceCookie });
    assert.equal(cancelIncoming.data.friends.find(friend => friend.id === cancelRequest.data.id)?.direction, 'incoming');
    const cancelled = await request(port, `/friends/${cancelRequest.data.id}`, { method: 'DELETE', cookie: charlieCookie });
    assert.equal(cancelled.response.status, 200, 'requesters must be able to cancel their pending request');
    const aliceAfterCancel = await request<{ friends: Array<{ id: string }> }>(port, '/friends', { cookie: aliceCookie });
    assert.ok(!aliceAfterCancel.data.friends.some(friend => friend.id === cancelRequest.data.id), 'cancelled requests must disappear from the recipient list');

    const aliceToCharlie = await request<{ id: string }>(port, '/friends/request', { method: 'POST', cookie: aliceCookie, body: { username: 'charlie_test' } });
    assert.equal(aliceToCharlie.response.status, 201);
    const charlieIncoming = await request<{ friends: Array<{ id: string; direction: string }> }>(port, '/friends', { cookie: charlieCookie });
    assert.equal(charlieIncoming.data.friends.find(friend => friend.id === aliceToCharlie.data.id)?.direction, 'incoming');
    const declined = await request(port, `/friends/${aliceToCharlie.data.id}`, { method: 'DELETE', cookie: charlieCookie });
    assert.equal(declined.response.status, 200, 'recipients must be able to decline incoming requests');

    const dm = await request<{ conversation: { id: string } }>(port, '/dms', {
      method: 'POST', cookie: aliceCookie, body: { userIds: [bobRegistration.data.user.id] }
    });
    assert.equal(dm.response.status, 201);
    const dmMessage = await request<{ message: { content: string } }>(port, `/dms/${dm.data.conversation.id}/messages`, {
      method: 'POST', cookie: aliceCookie, body: { content: 'A private DM that should persist.' }
    });
    assert.equal(dmMessage.response.status, 201);
    const bobDmMessages = await request<{ messages: Array<{ content: string }> }>(port, `/dms/${dm.data.conversation.id}/messages`, { cookie: bobCookie });
    assert.ok(bobDmMessages.data.messages.some(message => message.content === 'A private DM that should persist.'));
    const bobReply = await request(port, `/dms/${dm.data.conversation.id}/messages`, {
      method: 'POST', cookie: bobCookie, body: { content: 'Reply from Bob.' }
    });
    assert.equal(bobReply.response.status, 201);
    const aliceDmHistory = await request<{ messages: Array<{ content: string }> }>(port, `/dms/${dm.data.conversation.id}/messages`, { cookie: aliceCookie });
    assert.ok(aliceDmHistory.data.messages.some(message => message.content === 'Reply from Bob.'), 'both participants must read the same DM history');

    const createdMessage = await request<{ message: { id: string; content: string } }>(port, `/channels/${serverResult.data.channelId}/messages`, {
      method: 'POST', cookie: aliceCookie, body: { content: 'Persistent hello from Alice.' }
    });
    assert.equal(createdMessage.response.status, 201);
    assert.equal(createdMessage.data.message.content, 'Persistent hello from Alice.');

    const bobMessages = await request<{ messages: Array<{ id: string; content: string }> }>(port, `/channels/${serverResult.data.channelId}/messages`, { cookie: bobCookie });
    assert.equal(bobMessages.response.status, 200);
    assert.ok(bobMessages.data.messages.some(message => message.content === 'Persistent hello from Alice.'));

    const forbiddenChannelEdit = await request(port, `/channels/${serverResult.data.channelId}`, {
      method: 'PATCH', cookie: bobCookie, body: { name: 'not-authorized' }
    });
    assert.equal(forbiddenChannelEdit.response.status, 403, 'a regular member must not manage channels');

    const saveTheme = await request(port, '/settings', { method: 'PUT', cookie: aliceCookie, body: { settings: { theme: 'paper' } } });
    assert.equal(saveTheme.response.status, 200);
    const blockBob = await request(port, `/blocks/${bobRegistration.data.user.id}`, { method: 'POST', cookie: aliceCookie, body: {} });
    assert.equal(blockBob.response.status, 200);
    const blockedDmRead = await request(port, `/dms/${dm.data.conversation.id}/messages`, { cookie: bobCookie });
    assert.equal(blockedDmRead.response.status, 403, 'blocks must prevent access to existing DMs');

    await stop(processOne.child);
    processTwo = startApi(port, uploadDir);
    await waitForApi(port, processTwo.child, processTwo.logs);

    const restoredSession = await request<{ user: { username: string } }>(port, '/auth/me', { cookie: aliceCookie });
    assert.equal(restoredSession.response.status, 200, 'the original session should survive an API restart');
    assert.equal(restoredSession.data.user.username, 'alice_test');
    const savedSettings = await request<{ settings: { theme: string } }>(port, '/settings', { cookie: aliceCookie });
    assert.equal(savedSettings.data.settings.theme, 'paper', 'user settings must survive a server restart');

    const restoredMessages = await request<{ messages: Array<{ content: string }> }>(port, `/channels/${serverResult.data.channelId}/messages`, { cookie: bobCookie });
    assert.equal(restoredMessages.response.status, 200);
    assert.ok(restoredMessages.data.messages.some(message => message.content === 'Persistent hello from Alice.'), 'message data should survive an API restart');
  } finally {
    await stop(processOne.child);
    if (processTwo) await stop(processTwo.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
