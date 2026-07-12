import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReversalResult } from '../src/services/mpesaService.js';

// Shape documented at https://developer.safaricom.co.ke (Transaction Reversal)
const successBody = {
  Result: {
    ResultType: 0,
    ResultCode: 0,
    ResultDesc: 'The service request has been accepted successfully.',
    OriginatorConversationID: '8521-4298025-1',
    ConversationID: 'AG_20260710_00004e48cf7e3533f581',
    TransactionID: 'MJ561H6X5O',
    ResultParameters: {
      ResultParameter: [
        { Key: 'DebitAccountBalance', Value: 'Working Account|KES|51661.00|51661.00|0.00|0.00' },
        { Key: 'Amount', Value: 100 },
        { Key: 'TransCompletedTime', Value: '20260710110717' },
        { Key: 'OriginalTransactionID', Value: 'MJ551H6X5D' },
        { Key: 'Charge', Value: 0 },
        { Key: 'CreditPartyPublicName', Value: '254708374149 - John Doe' },
        { Key: 'DebitPartyPublicName', Value: '601315 - Safaricom1338' },
      ],
    },
  },
};

const failureBody = {
  Result: {
    ResultType: 0,
    ResultCode: 21,
    ResultDesc: 'The initiator information is invalid.',
    OriginatorConversationID: '8521-4298025-2',
    ConversationID: 'AG_20260710_00004e48cf7e3533f582',
    TransactionID: 'MJ561H6X5P',
  },
};

test('parses a successful reversal result', () => {
  const parsed = parseReversalResult(successBody);
  assert.equal(parsed.success, true);
  assert.equal(parsed.resultCode, '0');
  assert.equal(parsed.originatorConversationId, '8521-4298025-1');
  assert.equal(parsed.conversationId, 'AG_20260710_00004e48cf7e3533f581');
  assert.equal(parsed.transactionId, 'MJ561H6X5O');
  assert.equal(parsed.amount, 100);
});

test('parses a failed reversal result', () => {
  const parsed = parseReversalResult(failureBody);
  assert.equal(parsed.success, false);
  assert.equal(parsed.resultCode, '21');
  assert.equal(parsed.resultDesc, 'The initiator information is invalid.');
});

test('tolerates a missing ResultParameters block', () => {
  const parsed = parseReversalResult(failureBody);
  assert.equal(parsed.amount, undefined);
});

test('tolerates a single (non-array) ResultParameter', () => {
  const body = structuredClone(successBody);
  body.Result.ResultParameters.ResultParameter = { Key: 'Amount', Value: 250 };
  const parsed = parseReversalResult(body);
  assert.equal(parsed.amount, 250);
});

test('throws on an invalid body', () => {
  assert.throws(() => parseReversalResult({}));
  assert.throws(() => parseReversalResult(undefined));
});
