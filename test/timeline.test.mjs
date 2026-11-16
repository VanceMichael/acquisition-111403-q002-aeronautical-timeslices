import test from 'node:test';
import assert from 'node:assert/strict';
import {
  organizeFacility, evaluateAt, facilityState, covers, intervalsOverlap, sameValue
} from '../src/timeline.mjs';

let counter = 0;
let order = 0;
function slice(partial) {
  const interpretation = partial.interpretation ?? 'BASELINE';
  counter += 1;
  return {
    ...partial,
    kind: 'slice',
    sliceId: partial.sliceId ?? `s${counter}`,
    facility: 'stand1',
    interpretation,
    sequence: partial.sequence ?? (interpretation === 'BASELINE' ? 1 : 100 + counter),
    correction: partial.correction ?? 0,
    validStart: partial.validStart ?? 0,
    validEnd: partial.validEnd ?? null,
    properties: partial.properties ?? {},
    contentHash: partial.contentHash ?? `h${counter}`,
    receiptHash: partial.receiptHash ?? null,
    receivedOrder: order++
  };
}
function cancel(partial) {
  counter += 1;
  return {
    ...partial,
    kind: 'cancel',
    sliceId: partial.sliceId ?? `c${counter}`,
    facility: 'stand1',
    cancelOf: partial.cancelOf,
    validStart: partial.validStart ?? 0,
    validEnd: partial.validEnd ?? null,
    properties: {},
    contentHash: partial.contentHash ?? `hc${counter}`,
    receiptHash: partial.receiptHash ?? null,
    receivedOrder: order++
  };
}

test('有效区间包含起点、不包含终点，null 结束为开放', () => {
  assert.equal(covers({validStart: 10, validEnd: 20}, 10), true);
  assert.equal(covers({validStart: 10, validEnd: 20}, 19.9), true);
  assert.equal(covers({validStart: 10, validEnd: 20}, 20), false);
  assert.equal(covers({validStart: 10, validEnd: null}, 1e9), true);
  assert.equal(covers({validStart: 10, validEnd: null}, 9), false);
  assert.equal(intervalsOverlap({validStart: 0, validEnd: 10}, {validStart: 10, validEnd: 20}), false);
  assert.equal(intervalsOverlap({validStart: 0, validEnd: null}, {validStart: 5, validEnd: 6}), true);
});

test('变更片缺席属性不清空基准值，显式 null 才是清空', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true, capacity: 2, note: 'x'}}),
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, validStart: 5,
      properties: {capacity: 3, note: null}})
  ];
  const answer = evaluateAt('stand1', messages, 8);
  assert.equal(answer.ready, true);
  assert.equal(answer.properties.open.value, true);
  assert.equal(answer.properties.capacity.value, 3);
  assert.equal(answer.properties.note.value, null);
  assert.deepEqual(answer.properties.capacity.provenance.map(item => item.layer), ['BASELINE', 'PERMDELTA']);
});

test('取消临时安排后基准与永久变更仍然保留', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true, capacity: 2}}),
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, validStart: 5,
      properties: {capacity: 3}}),
    slice({sliceId: 't', interpretation: 'TEMPDELTA', sequence: 3, validStart: 10, validEnd: 20,
      properties: {open: false}}),
    cancel({sliceId: 'cx', cancelOf: 't', validStart: 12})
  ];
  const before = evaluateAt('stand1', messages, 11);
  assert.equal(before.properties.open.value, false);
  assert.deepEqual(before.temporaryOverrides.map(item => item.sliceId), ['t']);
  const after = evaluateAt('stand1', messages, 15);
  assert.equal(after.properties.open.value, true);
  assert.equal(after.properties.capacity.value, 3);
  assert.deepEqual(after.activeCancellations.map(item => item.cancelOf), ['t']);
  assert.deepEqual(after.temporaryOverrides, []);
  // 历史消息一条都没有删除，发布次序仍然完整。
  assert.deepEqual(facilityState('stand1', messages).messages.map(item => item.sliceId),
    ['b', 'p', 't', 'cx']);
});

test('取消指令先于被引用片到达时挂账，补齐后自动消解', () => {
  const pendingOnly = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true}}),
    cancel({sliceId: 'cx', cancelOf: 'missing', validStart: 6})
  ];
  const organized = organizeFacility(pendingOnly);
  assert.equal(organized.pendingReferences.length, 1);
  const answer = evaluateAt('stand1', pendingOnly, 5);
  assert.equal(answer.ready, false);
  assert.equal(answer.issues.some(issue => issue.kind === 'unresolved-reference'), true);
  const resolvedMessages = [
    ...pendingOnly,
    slice({sliceId: 'missing', interpretation: 'TEMPDELTA', sequence: 9, validStart: 2, validEnd: 9,
      properties: {open: false}})
  ];
  // 引用补齐且取消尚未生效：临时片正常作用，资料齐备。
  const active = evaluateAt('stand1', resolvedMessages, 5);
  assert.equal(active.ready, true);
  assert.equal(active.properties.open.value, false);
  // 取消生效后临时片被标记取消，基准恢复，永久与历史消息均不删除。
  const cancelled = evaluateAt('stand1', resolvedMessages, 7);
  assert.equal(cancelled.ready, true);
  assert.deepEqual(cancelled.cancelledTemporaryIds, ['missing']);
  assert.equal(cancelled.properties.open.value, true);
});

test('同层时间片属性矛盾时暴露证据且不猜开放状态', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true}}),
    slice({sliceId: 't1', interpretation: 'TEMPDELTA', sequence: 9, validStart: 10, validEnd: 20,
      properties: {open: false}}),
    slice({sliceId: 't2', interpretation: 'TEMPDELTA', sequence: 9, validStart: 15, validEnd: 25,
      properties: {open: true}})
  ];
  const inside = evaluateAt('stand1', messages, 17);
  assert.equal(inside.ready, false);
  assert.equal(inside.properties.open.indeterminate, true);
  assert.equal(inside.properties.open.value, null);
  assert.ok(inside.issues.some(issue => issue.kind === 'property-conflict' && issue.property === 'open'));
  assert.ok(inside.issues.some(issue => issue.kind === 'overlapping-slices'));
  // 矛盾链的所有时间片都结束后，资料恢复齐备；矛盾期间不把任何取值当成确定状态。
  const outside = evaluateAt('stand1', messages, 25);
  assert.equal(outside.ready, true);
  assert.equal(outside.properties.open.value, true);
  // 矛盾区间之外、但矛盾链仍有一片生效时，依旧保守地标记为不齐备。
  assert.equal(evaluateAt('stand1', messages, 22).ready, false);
});

test('层间不同取值是正常覆盖而非矛盾', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true}}),
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, validStart: 5,
      properties: {open: false}}),
    slice({sliceId: 't', interpretation: 'TEMPDELTA', sequence: 3, validStart: 10, validEnd: 20,
      properties: {open: true}})
  ];
  const answer = evaluateAt('stand1', messages, 15);
  assert.equal(answer.ready, true);
  assert.equal(answer.properties.open.value, true);
  assert.deepEqual(answer.temporaryOverrides[0].changed, [{property: 'open', from: false, to: true}]);
});

test('更正片按 correction 选取当前版本，同 correction 不同内容判为矛盾', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true}}),
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, correction: 0, validStart: 5,
      properties: {capacity: 2}}),
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, correction: 1, validStart: 5,
      properties: {capacity: 9}, contentHash: 'h-new'})
  ];
  const answer = evaluateAt('stand1', messages, 6);
  assert.equal(answer.properties.capacity.value, 9);
  const organized = organizeFacility(messages);
  assert.equal(organized.groups.find(group => group.sliceId === 'p').versions.length, 2);

  const conflicting = [...messages,
    slice({sliceId: 'p', interpretation: 'PERMDELTA', sequence: 2, correction: 1, validStart: 5,
      properties: {capacity: 7}, contentHash: 'h-other'})];
  assert.ok(organizeFacility(conflicting).conflicts
    .some(issue => issue.kind === 'duplicate-correction-differs'));
});

test('没有覆盖时刻的基准时资料不齐备', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', validStart: 0, validEnd: 10,
      properties: {open: true}})
  ];
  const answer = evaluateAt('stand1', messages, 10);
  assert.equal(answer.ready, false);
  assert.equal(answer.issues[0].kind, 'no-baseline-at-instant');
});

test('畸形消息保留为证据并使设施状态不齐备', () => {
  const messages = [
    slice({sliceId: 'b', interpretation: 'BASELINE', properties: {open: true}}),
    {kind: 'malformed', sliceId: 'bad', facility: 'stand1', anomaly: 'validEnd 必须晚于 validStart',
      validStart: 9, validEnd: 8, properties: {}, contentHash: 'h-bad', receiptHash: 'r1',
      receivedOrder: order++}
  ];
  const answer = evaluateAt('stand1', messages, 5);
  assert.equal(answer.ready, false);
  assert.equal(answer.issues.some(issue => issue.kind === 'malformed-message'), true);
  assert.ok(facilityState('stand1', messages).messages.some(item => item.sliceId === 'bad'));
});

test('sameValue 区分缺席语义并支持结构化比较', () => {
  assert.equal(sameValue(null, undefined), false);
  assert.equal(sameValue(null, false), false);
  assert.equal(sameValue({a: 1}, {a: 1}), true);
  assert.equal(sameValue({a: 1}, {a: 2}), false);
});
