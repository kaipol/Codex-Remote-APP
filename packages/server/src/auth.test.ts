import {afterEach,describe,expect,it} from 'vitest';import {generateKeyPairSync,createPublicKey,diffieHellman,hkdfSync,createCipheriv,randomBytes} from 'node:crypto';
import {AuthService} from './auth.js';
import {loadConfig} from './config.js';
import {Store} from './db.js';

let store:Store|undefined;
afterEach(()=>store?.close());

describe('refresh token lifetime',()=>{
  it('rejects a refresh token after its configured lifetime',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32),refreshDays:1}));
    const pair=auth.createPairCode();const tokens=auth.pair(pair.code,'test-device')!;
    store.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run('2026-08-13T00:00:00.000Z',tokens.device_id);
    expect(auth.refresh(tokens.device_id,tokens.refresh_token)).toBeUndefined();
  });
	 it('revokes access and refresh credentials for an unpaired device',()=>{
	   store=new Store(':memory:');
	   const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
	   const pair=auth.createPairCode();const tokens=auth.pair(pair.code,'test-device')!;
	   expect(auth.verify(tokens.access_token).sub).toBe(tokens.device_id);
	   expect(auth.revoke(tokens.device_id)).toBe(true);
	   expect(()=>auth.verify(tokens.access_token)).toThrow(/invalid access token/);
	   expect(auth.refresh(tokens.device_id,tokens.refresh_token)).toBeUndefined();
	 });
	 it('invalidates all existing devices when the service starts again',()=>{
	   store=new Store(':memory:');
	   const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
	   const pair=auth.createPairCode();const tokens=auth.pair(pair.code,'test-device')!;
	   expect(auth.invalidateDevicesOnStartup()).toBe(1);
	   expect(()=>auth.verify(tokens.access_token)).toThrow(/invalid access token/);
	   expect(auth.refresh(tokens.device_id,tokens.refresh_token)).toBeUndefined();
	 });
});

describe('pair password',()=>{
  it('pairs a persistent device with the configured password and rejects wrong passwords',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
    auth.setPairPassword('Correct-Horse-Battery');
    expect(auth.hasPairPassword()).toBe(true);
    const tokens=auth.pairByPassword('Correct-Horse-Battery','phone');
    expect(tokens).toBeDefined();
    expect(auth.verify(tokens!.access_token).sub).toBe(tokens!.device_id);
    expect(auth.pairByPassword('wrong-password-here','phone')).toBeUndefined();
  });
  it('keeps password-paired devices valid across a service restart, but revokes code-paired ones',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
    auth.setPairPassword('Persist-Password');
    const codePair=auth.createPairCode();
    const codeTokens=auth.pair(codePair.code,'desktop')!;
    const pwdTokens=auth.pairByPassword('Persist-Password','phone')!;
    expect(auth.invalidateDevicesOnStartup()).toBe(1);
    expect(()=>auth.verify(codeTokens.access_token)).toThrow(/invalid access token/);
    expect(auth.refresh(codeTokens.device_id,codeTokens.refresh_token)).toBeUndefined();
    expect(auth.verify(pwdTokens.access_token).sub).toBe(pwdTokens.device_id);
    expect(auth.refresh(pwdTokens.device_id,pwdTokens.refresh_token)).toBeDefined();
  });
  it('seeds the pair password from config exactly once and preserves later changes',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32),pairPassword:'Env-Bootstrap-Pwd'}));
    expect(auth.hasPairPassword()).toBe(false);
    auth.bootstrapPairPassword();
    expect(auth.hasPairPassword()).toBe(true);
    expect(auth.pairByPassword('Env-Bootstrap-Pwd','phone')).toBeDefined();
    auth.setPairPassword('Runtime-Change-Pwd');
    auth.bootstrapPairPassword();
    expect(auth.pairByPassword('Runtime-Change-Pwd','phone')).toBeDefined();
    expect(auth.pairByPassword('Env-Bootstrap-Pwd','phone')).toBeUndefined();
  });
});

describe('encrypted pair password',()=>{
  function encrypt(auth:AuthService,password:string){
    const serverPubDer=auth.getPairPublicKey();
    const serverPub=createPublicKey({key:serverPubDer,format:'der',type:'spki'});
    const client=generateKeyPairSync('ec',{namedCurve:'P-256'});
    const shared=diffieHellman({privateKey:client.privateKey,publicKey:serverPub});
    const aesKey=Buffer.from(hkdfSync('sha256',shared,'codex-remote-pair','pair-password-v1',32));
    const iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',aesKey,iv);
    const enc=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
    const ciphertext=Buffer.concat([enc,cipher.getAuthTag()]);
    const clientPubDer=client.publicKey.export({type:'spki',format:'der'});
    return {clientPublicKey:Buffer.from(clientPubDer),iv,ciphertext};
  }
  it('pairs a persistent device via the encrypted blob',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
    auth.setPairPassword('Correct-Horse-Battery');
    const blob=encrypt(auth,'Correct-Horse-Battery');
    const tokens=auth.pairByEncryptedPassword(blob.clientPublicKey,blob.iv,blob.ciphertext,'phone');
    expect(tokens).toBeDefined();
    expect(auth.verify(tokens!.access_token).sub).toBe(tokens!.device_id);
  });
  it('rejects a tampered ciphertext',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
    auth.setPairPassword('Correct-Horse-Battery');
    const blob=encrypt(auth,'Correct-Horse-Battery');
    (blob.ciphertext as Buffer)[0]^=0xff;
    expect(auth.pairByEncryptedPassword(blob.clientPublicKey,blob.iv,blob.ciphertext,'phone')).toBeUndefined();
  });
  it('rejects an encrypted wrong password',()=>{
    store=new Store(':memory:');
    const auth=new AuthService(store,loadConfig({databasePath:':memory:',secret:'x'.repeat(32)}));
    auth.setPairPassword('Correct-Horse-Battery');
    const blob=encrypt(auth,'Wrong-Password-Here');
    expect(auth.pairByEncryptedPassword(blob.clientPublicKey,blob.iv,blob.ciphertext,'phone')).toBeUndefined();
  });
});
