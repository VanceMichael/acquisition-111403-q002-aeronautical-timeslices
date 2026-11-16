import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, open} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from './hash.mjs';

async function replace(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

// 收件状态不与来源、查询共享内存对象；打开时逐份校验原文，并核对每条消息的来源凭据。
async function validate(index, directory) {
  if (![1, 2].includes(index.version) || !Array.isArray(index.records) || !Array.isArray(index.exchanges)) {
    throw new Error('归档索引结构无效');
  }
  const knownHashes = new Set();
  for (const exchange of index.exchanges) {
    if (!/^[a-f0-9]{64}$/.test(exchange.hash)) throw new Error('归档摘要无效');
    const bytes = await readFile(join(directory, 'objects', exchange.hash));
    if (digest(bytes) !== exchange.hash) throw new Error('归档原文校验失败');
    knownHashes.add(exchange.hash);
  }
  if (index.version === 2 && index.ingestion) {
    const visit = message => {
      if (message.receiptHash && !knownHashes.has(message.receiptHash)) {
        throw new Error('归档消息缺少来源原文凭据');
      }
    };
    for (const bucket of Object.values(index.ingestion.facilities ?? {})) {
      for (const message of bucket.messages ?? []) visit(message);
    }
  }
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'objects'), {recursive:true});
  const indexPath = join(directory, 'index.json');
  let index = {version:1, records:[], exchanges:[]};
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await validate(index, directory);
  // 旧版索引就地升级：历史记录与凭据全部保留。
  if (index.version === 1) {
    index = {
      version: 2,
      records: index.records,
      exchanges: index.exchanges,
      ingestion: {version: 2, facilities: {}, journal: {pages: [], pending: [], baseline: {}, anomalies: []}}
    };
  }
  index.ingestion ??= {version: 2, facilities: {}, journal: {pages: [], pending: [], baseline: {}, anomalies: []}};
  let queue = Promise.resolve();
  return {
    version: index.version,
    records:() => structuredClone(index.records),
    exchanges:() => structuredClone(index.exchanges),
    ingestion:() => structuredClone(index.ingestion),
    raw: async hash => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原文摘要无效');
      const bytes = await readFile(join(directory, 'objects', hash));
      if (digest(bytes) !== hash) throw new Error('原文校验失败');
      return bytes;
    },
    commit(records, exchanges) {
      const operation = queue.then(async () => {
        const next = structuredClone(index);
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await replace(join(directory, 'objects', hash), exchange.bytes);
          const receiptId = digest(Buffer.from(exchange.url + ':' + exchange.status + ':' + hash));
          if (!next.exchanges.some(existing => existing.receiptId === receiptId)) {
            next.exchanges.push({receiptId,url:exchange.url,status:exchange.status,contentType:exchange.contentType,hash});
          }
        }
        for (const record of records) {
          if (typeof record.id !== 'string' || !record.id) throw new Error('资料必须有非空标识');
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(existing => existing.id === record.id && existing.revision === revision)) {
            next.records.push({...record,revision});
          }
        }
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {records:next.records.length,exchanges:next.exchanges.length};
      });
      queue = operation.catch(() => {});
      return operation;
    },
    // 时间片收件：原文先落对象库，消息再随日志原子换入索引；重启后凭日志继续补收。
    ingest(result, exchanges) {
      const operation = queue.then(async () => {
        const next = structuredClone(index);
        const knownHashes = new Set(next.exchanges.map(item => item.hash));
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await replace(join(directory, 'objects', hash), exchange.bytes);
          knownHashes.add(hash);
          const receiptId = digest(Buffer.from(exchange.url + ':' + exchange.status + ':' + hash));
          if (!next.exchanges.some(existing => existing.receiptId === receiptId)) {
            next.exchanges.push({receiptId,url:exchange.url,status:exchange.status,contentType:exchange.contentType,hash});
          }
        }
        const incoming = result.ingestion;
        for (const bucket of Object.values(incoming.facilities)) {
          for (const message of bucket.messages) {
            if (message.receiptHash && !knownHashes.has(message.receiptHash)) {
              throw new Error('消息来源凭据未归档，拒绝写入');
            }
          }
        }
        next.ingestion = structuredClone(incoming);
        // 同步维护结构化资料版本，保留旧接口语义。
        for (const bucket of Object.values(incoming.facilities)) {
          const record = {
            id: bucket.id,
            baseline: incoming.journal.baseline[bucket.id]?.sliceId ?? null,
            messages: bucket.messages
          };
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(existing => existing.id === record.id && existing.revision === revision)) {
            next.records.push({...record, revision});
          }
        }
        await validate(next, directory);
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {
          facilities: Object.keys(next.ingestion.facilities).length,
          messages: Object.values(next.ingestion.facilities)
            .reduce((total, bucket) => total + bucket.messages.length, 0),
          pending: next.ingestion.journal.pending.length,
          anomalies: next.ingestion.journal.anomalies.length,
          truncated: result.truncated === true,
          exchanges: next.exchanges.length
        };
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

export {digest};
