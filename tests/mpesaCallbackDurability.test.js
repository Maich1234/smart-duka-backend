import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import MpesaTransaction from '../src/models/MpesaTransaction.js';
import AuditLog from '../src/models/AuditLog.js';
import { handleCallback } from '../src/controllers/mpesaController.js';
afterEach(()=>mock.restoreAll());
for(const [amount,status] of [[100,'success'],[1,'failed']]) {
 test(`callback persists ${status} before acknowledging`,async()=>{
  const events=[];
  const tx={_id:'t',shop:'s',status:'pending',amount:100,save:async()=>events.push('save')};
  mock.method(MpesaTransaction,'findOne',async()=>tx);
  mock.method(AuditLog,'create',async()=>({}));
  const res={status(){return this;},json(){events.push('response');return this;}};
  await handleCallback({body:{Body:{stkCallback:{ResultCode:0,CheckoutRequestID:'c',CallbackMetadata:{Item:[{Name:'Amount',Value:amount},{Name:'MpesaReceiptNumber',Value:'R123'}]}}}}},res);
  assert.equal(tx.status,status);assert.deepEqual(events,['save','response']);
 });
}
