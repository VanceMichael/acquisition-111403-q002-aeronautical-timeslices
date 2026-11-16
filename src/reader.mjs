import {digest, digestJson} from './hash.mjs';
import {INTERPRETATIONS} from './timeline.mjs';

// 把来源投影规范化为内部消息。结构非法不丢弃原文：标记 anomaly 后继续保留全部字段，
// 让归档与查询能够向使用者暴露证据，而不是替来源决定该怎么解释。
export function normalizeMessage(item, receiptHash) {
  const base = {...item, receiptHash};
  const reject = reason => ({...base, kind: 'malformed', anomaly: reason,
    contentHash: digestJson(item), receivedOrder: null});
  if (typeof item !== 'object' || item === null) return reject('消息不是对象');
  if (typeof item.sliceId !== 'string' || !item.sliceId) return reject('sliceId 缺失或非字符串');
  if (typeof item.facility !== 'string' || !item.facility) return reject('facility 缺失或非字符串');
  if (!Number.isFinite(item.validStart)) return reject('validStart 缺失或非数值');
  if (!(item.validEnd === null || Number.isFinite(item.validEnd))) return reject('validEnd 必须为数值或 null');
  if (Number.isFinite(item.validEnd) && item.validEnd <= item.validStart) return reject('validEnd 必须晚于 validStart');
  if (typeof item.properties !== 'object' || item.properties === null || Array.isArray(item.properties)) {
    return reject('properties 必须为对象');
  }

  // cancelOf 指向被取消的临时片；取消指令不携带 interpretation，也不删除任何已有消息。
  if (typeof item.cancelOf === 'string' && item.cancelOf) {
    return {
      kind: 'cancel',
      sliceId: item.sliceId,
      facility: item.facility,
      cancelOf: item.cancelOf,
      validStart: item.validStart,
      validEnd: item.validEnd,
      properties: {},
      contentHash: digestJson(item),
      receiptHash,
      receivedOrder: null
    };
  }

  if (!INTERPRETATIONS.includes(item.interpretation)) return reject('interpretation 不在约定集合内');
  if (!Number.isInteger(item.sequence) || item.sequence < 1) return reject('sequence 必须为正整数');
  if (!Number.isInteger(item.correction) || item.correction < 0) return reject('correction 必须为非负整数');
  return {
    kind: 'slice',
    sliceId: item.sliceId,
    facility: item.facility,
    interpretation: item.interpretation,
    sequence: item.sequence,
    correction: item.correction,
    validStart: item.validStart,
    validEnd: item.validEnd,
    properties: item.properties,
    contentHash: digestJson(item),
    receiptHash,
    receivedOrder: null
  };
}

export function emptyIngestion() {
  return {version: 2, facilities: {}, journal: {pages: [], pending: [], baseline: {}, anomalies: []}};
}

function ensureFacility(ingestion, facility) {
  if (!ingestion.facilities[facility]) {
    ingestion.facilities[facility] = {id: facility, messages: []};
    ingestion.journal.baseline[facility] = null;
  }
  return ingestion.facilities[facility];
}

function receiptHashFor(client, url) {
  const exchange = client.exchanges.find(item => item.url === url);
  return exchange ? digest(exchange.bytes) : null;
}

function absorbMessage(ingestion, message) {
  if (message.kind === 'malformed') {
    // 畸形消息作为消息落账（含 anomaly 原因与原文凭据），由查询侧统一暴露；
    // journal.anomalies 只记录传输/分页层问题，避免重复留痕。
    const facility = typeof message.facility === 'string' && message.facility
      ? message.facility : 'unknown';
    const bucket = ensureFacility(ingestion, facility);
    message.receivedOrder = bucket.messages.length
      ? Math.max(...bucket.messages.map(item => item.receivedOrder)) + 1
      : 0;
    if (!bucket.messages.some(item => item.contentHash === message.contentHash
      && item.receiptHash === message.receiptHash)) bucket.messages.push(message);
    return;
  }
  const bucket = ensureFacility(ingestion, message.facility);
  const known = bucket.messages.find(item => item.sliceId === message.sliceId
    && item.contentHash === message.contentHash);
  if (known) {
    // 同一消息再次出现（补收、重放、重启）不重复计入发布次序，只补充新的来源凭据。
    if (message.receiptHash && !known.receiptHash) known.receiptHash = message.receiptHash;
    return;
  }
  message.receivedOrder = bucket.messages.length
    ? Math.max(...bucket.messages.map(item => item.receivedOrder)) + 1
    : 0;
  bucket.messages.push(message);
}

function trackPending(ingestion, message) {
  if (message.kind !== 'cancel') return;
  const bucket = ingestion.facilities[message.facility];
  const targetKnown = bucket?.messages.some(item => item.sliceId === message.cancelOf && item.kind !== 'malformed');
  if (targetKnown) return;
  const pending = {
    facility: message.facility,
    kind: 'cancelOf',
    reference: message.cancelOf,
    from: message.sliceId,
    receiptHash: message.receiptHash,
    validStart: message.validStart,
    validEnd: message.validEnd
  };
  if (!ingestion.journal.pending.some(item => item.from === pending.from && item.reference === pending.reference)) {
    ingestion.journal.pending.push(pending);
  }
}

function resolvePending(ingestion) {
  const remaining = [];
  for (const item of ingestion.journal.pending) {
    const bucket = ingestion.facilities[item.facility];
    const known = bucket?.messages.some(message =>
      message.sliceId === item.reference && message.kind !== 'malformed');
    if (!known) remaining.push(item);
  }
  ingestion.journal.pending = remaining;
}

// 按设施采集时间片。state 为上次收件留下的持久化日志，重启后继续补收而非从零开始；
// maxPages 限定单次遍历页数，中途停下时日志已落盘，下次 collect 接着走。
export async function collectSlices(client, state = emptyIngestion(), options = {}) {
  const ingestion = structuredClone(state);
  ingestion.version = 2;
  ingestion.facilities ??= {};
  ingestion.journal ??= {pages: [], pending: [], baseline: {}, anomalies: []};
  // 异常描述的是“本轮仍存在的问题”：每轮重新采集后重建，恢复正常即不再留痕；
  // 畸形消息本身仍作为消息永久归档，不会因此丢失证据。
  ingestion.journal.anomalies = [];
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : Number.POSITIVE_INFINITY;

  // 1. 基准仍是入口；同时要求拿到基准对应的完整时间片，而不是只信整理后的投影。
  const baseline = await client('/baseline');
  const facility = baseline.facility;
  ensureFacility(ingestion, facility);
  ingestion.journal.baseline[facility] = {
    sliceId: baseline.sliceId,
    receiptHash: receiptHashFor(client, new URL('/baseline', client.origin).href)
  };
  const baselineKnown = ingestion.facilities[facility].messages
    .some(message => message.sliceId === baseline.sliceId && message.kind !== 'malformed');
  if (!baselineKnown) {
    try {
      const referenced = await client(`/slices/${encodeURIComponent(baseline.sliceId)}`);
      absorbMessage(ingestion, normalizeMessage(referenced,
        receiptHashFor(client, new URL(`/slices/${baseline.sliceId}`, client.origin).href)));
    } catch (error) {
      ingestion.journal.anomalies.push({
        sliceId: baseline.sliceId, reason: `基准引用片读取失败: ${error.message}`, receiptHash: null
      });
    }
  }

  // 2. 按 next 翻页。每次运行从第一页重新遍历，让补发的更正（可能针对很早的生效区间）
  //    被补收；同一页在同一运行内重复出现即判定为来源环路，停下并留痕。
  const visitedInRun = new Set();
  let pageUrl = '/slices?facility=' + encodeURIComponent(facility) + '&page=1';
  let pagesThisRun = 0;
  while (pageUrl && pagesThisRun < maxPages) {
    const absolute = new URL(pageUrl, client.origin).href;
    if (visitedInRun.has(absolute)) {
      ingestion.journal.anomalies.push({sliceId: null, reason: `翻页出现环路: ${pageUrl}`, receiptHash: null});
      break;
    }
    visitedInRun.add(absolute);
    pagesThisRun += 1;
    let page;
    try {
      page = await client(pageUrl);
    } catch (error) {
      // 来源暂时不可用：保留已收内容与日志，下次运行接着补，不把缺失误判为设施关闭。
      ingestion.journal.anomalies.push({
        sliceId: null, reason: `时间片页读取失败: ${error.message}`, receiptHash: null
      });
      break;
    }
    if (!page || !Array.isArray(page.items)) {
      ingestion.journal.anomalies.push({
        sliceId: null, reason: `时间片页结构非法: ${pageUrl}`,
        receiptHash: receiptHashFor(client, absolute)
      });
      break;
    }
    const receiptHash = receiptHashFor(client, absolute);
    if (!ingestion.journal.pages.some(item => item.url === absolute && item.receiptHash === receiptHash)) {
      ingestion.journal.pages.push({url: absolute, receiptHash});
    }
    for (const item of page.items) {
      const message = normalizeMessage(item, receiptHash);
      absorbMessage(ingestion, message);
      trackPending(ingestion, message);
    }
    pageUrl = page.next ?? null;
  }

  // 3. 相互引用未齐：按 /slices/:id 主动补取被引用片；仍取不到则继续挂账并暴露为证据。
  for (const pending of [...ingestion.journal.pending]) {
    const targetUrl = `/slices/${encodeURIComponent(pending.reference)}`;
    try {
      const referenced = await client(targetUrl);
      const message = normalizeMessage(referenced,
        receiptHashFor(client, new URL(targetUrl, client.origin).href));
      if (message.kind !== 'malformed' && message.facility !== pending.facility) {
        ingestion.journal.anomalies.push({
          sliceId: pending.reference,
          reason: `引用片所属设施 ${message.facility} 与引用方 ${pending.facility} 不一致`,
          receiptHash: message.receiptHash
        });
        continue;
      }
      absorbMessage(ingestion, message);
    } catch (error) {
      if (error.status === 404) continue; // 来源尚未发布，保留挂账，下轮再试。
      ingestion.journal.anomalies.push({
        sliceId: pending.reference, reason: `引用片读取失败: ${error.message}`, receiptHash: null
      });
    }
  }
  resolvePending(ingestion);

  // 4. 取消临时安排只标记，不删除永久变更或任何历史消息。
  return {
    ingestion,
    truncated: Boolean(pageUrl && pagesThisRun >= maxPages),
    facilities: Object.values(ingestion.facilities).map(bucket => structuredClone(bucket))
  };
}

// 兼容现有收件入口：返回结构化设施记录，字段较旧版本扩展但仍以 id 标识。
export async function collect(client, state) {
  const result = await collectSlices(client, state);
  return result.facilities.map(bucket => ({
    id: bucket.id,
    baseline: result.ingestion.journal.baseline[bucket.id]?.sliceId ?? null,
    messages: bucket.messages
  }));
}
