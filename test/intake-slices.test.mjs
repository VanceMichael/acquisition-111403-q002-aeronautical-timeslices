import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {createClient} from '../src/source.mjs';
import {collect, collectSlices, normalizeMessage, emptyIngestion} from '../src/reader.mjs';
import {openArchive} from '../src/archive.mjs';
import {startIntake} from '../src/app.mjs';
import {evaluateAt} from '../src/timeline.mjs';
import {digest} from '../src/hash.mjs';

async function environment(run) {
  const directory = await mkdtemp(join(tmpdir(), 'intake-slices-'));
  const source = await startSource();
  try { await run({directory, source}); }
  finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
}

async function runOnce(source, directory, state) {
  const archive = await openArchive(directory);
  const client = createClient(source.origin);
  const result = await collectSlices(client, state ?? archive.ingestion());
  const summary = await archive.ingest(result, client.exchanges);
  return {archive, summary, result};
}

test('正常收件按发布次序保存基准与临时片，并保留业务有效时间', () => environment(async ({directory, source}) => {
  const {archive} = await runOnce(source, directory);
  const state = archive.ingestion();
  const bucket = state.facilities.stand1;
  assert.deepEqual(bucket.messages.map(message => message.sliceId), ['b1', 't1']);
  assert.deepEqual(bucket.messages.map(message => message.receivedOrder), [0, 1]);
  assert.equal(bucket.messages[1].validStart, 10);
  assert.equal(bucket.messages[1].validEnd, 20);
  // 每条消息都能指回已归档的来源原文凭据。
  for (const message of bucket.messages) assert.match(message.receiptHash, /^[a-f0-9]{64}$/);
  const answer = evaluateAt('stand1', bucket.messages, 15);
  assert.equal(answer.ready, true);
  assert.equal(answer.properties.open.value, false);
  assert.equal(answer.properties.capacity.value, 2);
  assert.deepEqual(answer.temporaryOverrides.map(item => item.sliceId), ['t1']);
}));

test('兼容入口 collect 仍返回带非空 id 的结构化记录', () => environment(async ({source}) => {
  const client = createClient(source.origin);
  const records = await collect(client);
  assert.ok(records.length > 0);
  assert.ok(records.every(record => typeof record.id === 'string' && record.id.length));
  assert.ok(records[0].messages.some(message => message.sliceId === 't1'));
}));

test('补发的更正可针对很早的生效区间，补收后按 correction 生效且保留历史', () => environment(async ({directory, source}) => {
  await runOnce(source, directory);
  source.setPhase('late');
  const {archive} = await runOnce(source, directory);
  const messages = archive.ingestion().facilities.stand1.messages;
  // 发布次序：先收到的在前，晚到的 p1/cancel1 追加在后。
  assert.deepEqual(messages.map(message => message.sliceId), ['b1', 't1', 'p1', 'cancel1']);
  // p1 的业务生效时间早于它的发布时间对应的 t1，证明两套时间分别保存。
  const p1 = messages.find(message => message.sliceId === 'p1');
  assert.equal(p1.validStart, 5);
  assert.equal(p1.correction, 1);
  const answer = evaluateAt('stand1', messages, 25);
  assert.equal(answer.ready, true);
  assert.equal(answer.properties.capacity.value, 3);
}));

test('取消临时安排不删除永久变更，取消前的历史消息全部保留', () => environment(async ({directory, source}) => {
  await runOnce(source, directory);
  source.setPhase('late');
  const {archive} = await runOnce(source, directory);
  const messages = archive.ingestion().facilities.stand1.messages;
  const at12 = evaluateAt('stand1', messages, 12);
  assert.deepEqual(at12.cancelledTemporaryIds, ['t1']);
  assert.equal(at12.properties.open.value, true);
  assert.equal(at12.properties.capacity.value, 3);
  assert.ok(messages.some(message => message.sliceId === 't1'));
  assert.ok(messages.some(message => message.kind === 'cancel' && message.cancelOf === 't1'));
}));

test('相互引用未齐时挂账并主动按 id 补取，补齐后挂账消解', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-pending-'));
  const pages = {
    '/baseline': {facility: 'stand1', sliceId: 'b1', properties: {open: true}},
    '/slices?facility=stand1&page=1': {items: [
      {sliceId: 'b1', facility: 'stand1', interpretation: 'BASELINE', sequence: 1, correction: 0,
        validStart: 0, validEnd: null, properties: {open: true}},
      {sliceId: 'cx1', facility: 'stand1', cancelOf: 't9', validStart: 5, validEnd: null, properties: {}}
    ], next: null},
    '/slices/t9': {sliceId: 't9', facility: 'stand1', interpretation: 'TEMPDELTA', sequence: 2,
      correction: 0, validStart: 6, validEnd: 10, properties: {open: false}}
  };
  const calls = [];
  const client = async path => {
    calls.push(path);
    if (path === '/slices/t9' && !client.releaseTarget) {
      const error = new Error('来源返回 404'); error.status = 404; throw error;
    }
    return pages[path];
  };
  client.origin = 'http://local';
  client.exchanges = [];
  try {
    // 第一轮：引用片尚不存在，挂账保留。
    const first = await collectSlices(client, emptyIngestion());
    assert.equal(first.ingestion.journal.pending.length, 1);
    assert.equal(first.ingestion.journal.pending[0].reference, 't9');
    // 第二轮：来源补发后主动按 /slices/:id 补取，挂账消解，消息不丢失。
    client.releaseTarget = true;
    const second = await collectSlices(client, first.ingestion);
    assert.equal(second.ingestion.journal.pending.length, 0);
    const ids = second.ingestion.facilities.stand1.messages.map(message => message.sliceId);
    assert.deepEqual(ids, ['b1', 'cx1', 't9']);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('中途重启：maxPages 截断后再次收件继续补页，重启归档不丢已收内容', () => environment(async ({directory, source}) => {
  const firstClient = createClient(source.origin);
  const archive = await openArchive(directory);
  const first = await collectSlices(firstClient, archive.ingestion(), {maxPages: 1});
  assert.equal(first.truncated, true);
  await archive.ingest(first, firstClient.exchanges);
  assert.deepEqual(archive.ingestion().facilities.stand1.messages.map(item => item.sliceId), ['b1']);

  // 模拟进程重启：重新打开归档，从持久化日志继续。
  const reopened = await openArchive(directory);
  const secondClient = createClient(source.origin);
  const second = await collectSlices(secondClient, reopened.ingestion());
  await reopened.ingest(second, secondClient.exchanges);
  const finalState = reopened.ingestion();
  assert.deepEqual(finalState.facilities.stand1.messages.map(item => item.sliceId), ['b1', 't1']);
  assert.equal(finalState.journal.pending.length, 0);
}));

test('重复收件不产生重复消息或重复原文凭据', () => environment(async ({directory, source}) => {
  const first = await runOnce(source, directory);
  const second = await runOnce(source, directory);
  assert.equal(second.archive.ingestion().facilities.stand1.messages.length, 2);
  const hashes = new Set(second.archive.exchanges().map(item => item.hash));
  assert.equal(hashes.size, second.archive.exchanges().length);
  assert.ok(first.summary.messages === 2 && second.summary.messages === 2);
}));

test('重叠来源矛盾通过 HTTP 查询暴露证据，不输出猜测的开放状态', () => environment(async ({directory, source}) => {
  source.setPhase('overlap');
  const intake = await startIntake({origin: source.origin, directory});
  try {
    const collectResponse = await fetch(intake.origin + '/collect', {method: 'POST'});
    assert.equal(collectResponse.status, 200);
    const answer = await (await fetch(intake.origin + '/facilities/stand1/at?at=17')).json();
    assert.equal(answer.ready, false);
    assert.equal(answer.properties.open.indeterminate, true);
    assert.equal(answer.properties.open.value, null);
    assert.ok(answer.issues.some(issue => issue.kind === 'overlapping-slices'));
    const slices = await (await fetch(intake.origin + '/facilities/stand1/slices')).json();
    assert.equal(slices.messages.length, 3);
    // 发布次序字段对每条消息可见。
    assert.deepEqual(slices.messages.map(item => item.publicationIndex), [0, 1, 2]);
  } finally { await intake.close(); }
}));

test('时刻查询参数校验与未知设施返回明确错误', () => environment(async ({directory, source}) => {
  const intake = await startIntake({origin: source.origin, directory});
  try {
    await fetch(intake.origin + '/collect', {method: 'POST'});
    assert.equal((await fetch(intake.origin + '/facilities/stand1/at')).status, 400);
    assert.equal((await fetch(intake.origin + '/facilities/stand1/at?at=nope')).status, 400);
    assert.equal((await fetch(intake.origin + '/facilities/other/at?at=1')).status, 404);
    assert.equal((await fetch(intake.origin + '/facilities')).status, 200);
  } finally { await intake.close(); }
}));

test('来源异常页被记录为异常证据，已收内容仍然可查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-badpage-'));
  const pages = {
    '/baseline': {facility: 'stand1', sliceId: 'b1', properties: {open: true}},
    '/slices/b1': {sliceId: 'b1', facility: 'stand1', interpretation: 'BASELINE',
      sequence: 1, correction: 0, validStart: 0, validEnd: null, properties: {open: true}},
    '/slices?facility=stand1&page=1': {unexpected: true}
  };
  const client = async path => {
    if (pages[path]) return pages[path];
    throw new Error('未覆盖路径 ' + path);
  };
  client.origin = 'http://local';
  client.exchanges = [];
  try {
    const result = await collectSlices(client, emptyIngestion());
    assert.ok(result.ingestion.journal.anomalies.some(item => item.reason.includes('结构非法')));
    assert.equal(result.ingestion.facilities.stand1.messages.length, 1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('瞬时来源故障恢复后异常清除，开放结束的临时片长期生效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-recover-'));
  let failSecondPage = true;
  const pages = {
    '/baseline': {facility: 'f1', sliceId: 'b', properties: {}},
    '/slices/b': {sliceId: 'b', facility: 'f1', interpretation: 'BASELINE', sequence: 1,
      correction: 0, validStart: 0, validEnd: null, properties: {open: true}},
    '/slices?facility=f1&page=1': {items: [
      {sliceId: 'b', facility: 'f1', interpretation: 'BASELINE', sequence: 1, correction: 0,
        validStart: 0, validEnd: null, properties: {open: true}}],
      next: '/slices?facility=f1&page=2'},
    '/slices?facility=f1&page=2': {items: [
      {sliceId: 't', facility: 'f1', interpretation: 'TEMPDELTA', sequence: 2, correction: 0,
        validStart: 5, validEnd: null, properties: {open: false}}], next: null}
  };
  const makeClient = () => {
    const client = async path => {
      if (failSecondPage && path.includes('page=2')) {
        const error = new Error('来源返回 500'); error.status = 500; throw error;
      }
      if (!pages[path]) { const error = new Error('404'); error.status = 404; throw error; }
      return pages[path];
    };
    client.origin = 'http://local';
    client.exchanges = [];
    return client;
  };
  try {
    const first = await collectSlices(makeClient(), emptyIngestion());
    assert.equal(first.ingestion.journal.anomalies.length, 1);
    assert.deepEqual(first.ingestion.facilities.f1.messages.map(item => item.sliceId), ['b']);
    failSecondPage = false;
    const second = await collectSlices(makeClient(), first.ingestion);
    assert.equal(second.ingestion.journal.anomalies.length, 0);
    assert.deepEqual(second.ingestion.facilities.f1.messages.map(item => item.sliceId), ['b', 't']);
    const far = evaluateAt('f1', second.ingestion.facilities.f1.messages, 1e9);
    assert.equal(far.ready, true);
    assert.equal(far.properties.open.value, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('规范化拒绝畸形消息但保留原文字段作为证据', () => {
  const malformed = normalizeMessage({sliceId: 'x', facility: 'stand1', interpretation: 'TEMPDELTA',
    sequence: 1, correction: 0, validStart: 5, validEnd: 4, properties: {}}, 'receipt-hash');
  assert.equal(malformed.kind, 'malformed');
  assert.match(malformed.anomaly, /validEnd/);
  assert.equal(malformed.receiptHash, 'receipt-hash');
  const cancel = normalizeMessage({sliceId: 'c1', facility: 'stand1', cancelOf: 't1',
    validStart: 1, validEnd: null, properties: {}}, null);
  assert.equal(cancel.kind, 'cancel');
  assert.equal(cancel.cancelOf, 't1');
});

test('v1 归档自动迁移且历史记录与凭据保留', () => environment(async ({directory, source}) => {
  const legacy = await openArchive(directory);
  await legacy.commit([{id: 'stand1', baseline: 'b1', properties: {open: true}}],
    [{url: source.origin + '/baseline', status: 200, contentType: 'application/json',
      bytes: Buffer.from('{"legacy":true}')}]);
  const migrated = await openArchive(directory);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.records().length, 1);
  assert.equal(migrated.exchanges().length, 1);
  assert.deepEqual(migrated.ingestion().facilities, {});
  // 迁移后可直接进入新收件链路。
  await runOnce(source, directory);
  const again = await openArchive(directory);
  assert.ok(again.ingestion().facilities.stand1.messages.length >= 2);
}));

test('消息引用的来源凭据缺失时归档拒绝写入', () => environment(async ({directory}) => {
  const archive = await openArchive(directory);
  const rogue = {
    truncated: false,
    ingestion: {version: 2, facilities: {stand1: {id: 'stand1', messages: [
      {kind: 'slice', sliceId: 'b1', facility: 'stand1', interpretation: 'BASELINE', sequence: 1,
        correction: 0, validStart: 0, validEnd: null, properties: {}, contentHash: 'h',
        receiptHash: digest(Buffer.from('不存在的原文')), receivedOrder: 0}
    ]}}, journal: {pages: [], pending: [], baseline: {}, anomalies: []}}
  };
  await assert.rejects(() => archive.ingest(rogue, []), /凭据未归档/);
}));

test('原文被破坏时重开归档仍然拒绝', () => environment(async ({directory, source}) => {
  const {archive} = await runOnce(source, directory);
  const target = join(directory, 'objects', archive.exchanges()[0].hash);
  await writeFile(target, '被修改');
  await assert.rejects(() => openArchive(directory), /校验失败/);
}));
