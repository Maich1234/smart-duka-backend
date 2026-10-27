import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import User from '../src/models/User.js';
import RefreshToken from '../src/models/RefreshToken.js';
import { protect } from '../src/middlewares/auth.js';
process.env.JWT_SECRET = 'session-access-test-secret';
afterEach(() => mock.restoreAll());
for (const [name, sessionId, live, expected] of [['legacy token',undefined,false,401],['revoked session','s',false,401],['live session','s',true,200]]) {
  test(`access gate: ${name}`, async () => {
    mock.method(User,'findById',()=>({select:()=>({populate:async()=>({_id:'u',isActive:true})})}));
    mock.method(RefreshToken,'exists',async()=>live);
    const req={headers:{authorization:`Bearer ${jwt.sign({id:'u',sessionId},process.env.JWT_SECRET)}`}};
    const res={code:200,status(n){this.code=n;return this;},json(){return this;}};
    let called=false;
    await protect(req,res,()=>{called=true;});
    assert.equal(res.code,expected); assert.equal(called,expected===200);
  });
}
