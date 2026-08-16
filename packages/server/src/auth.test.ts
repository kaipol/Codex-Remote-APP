import {afterEach,describe,expect,it} from 'vitest';
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
