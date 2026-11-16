import {digestJson} from './hash.mjs';

export const INTERPRETATIONS = ['BASELINE', 'PERMDELTA', 'TEMPDELTA'];

// 同一属性的两个取值是否一致；JSON 可表达的来源投影用字符串规范化比较。
export function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

// 有效区间为 [validStart, validEnd)，validEnd 为 null 表示开放结束。
export function covers(message, at) {
  if (Number.isFinite(message.validStart) && at < message.validStart) return false;
  if (message.validEnd !== null && Number.isFinite(message.validEnd) && at >= message.validEnd) return false;
  return true;
}

export function intervalsOverlap(left, right) {
  const leftEnd = left.validEnd === null ? Number.POSITIVE_INFINITY : left.validEnd;
  const rightEnd = right.validEnd === null ? Number.POSITIVE_INFINITY : right.validEnd;
  return left.validStart < rightEnd && right.validStart < leftEnd;
}

// 将收件消息按全局唯一 sliceId 归并，识别修订链、取消指令、悬挂引用与来源矛盾。
// 该函数不做任何状态猜测：缺少什么、矛盾什么，都以证据形式返回给调用方。
export function organizeFacility(messages = []) {
  const ordered = [...messages].sort((left, right) => left.receivedOrder - right.receivedOrder);
  const groups = new Map();
  const cancels = [];
  const malformed = [];
  const anomalies = [];
  for (const message of ordered) {
    if (message.kind === 'cancel') {
      cancels.push(message);
      continue;
    }
    if (message.kind === 'malformed') {
      malformed.push(message);
      continue;
    }
    if (!groups.has(message.sliceId)) groups.set(message.sliceId, []);
    groups.get(message.sliceId).push(message);
  }

  const representatives = [];
  const sliceGroups = [];
  const revisionConflicts = [];
  for (const [sliceId, versions] of groups) {
    // 同一片的后续更正按 correction 递进；correction 相同但内容不同属于来源矛盾。
    const distinct = [];
    for (const message of versions) {
      const known = distinct.find(item => item.correction === message.correction);
      if (known) {
        if (known.contentHash !== message.contentHash) {
          revisionConflicts.push({
            kind: 'duplicate-correction-differs',
            sliceId,
            correction: message.correction,
            receipts: [...new Set([known.receiptHash, message.receiptHash].filter(Boolean))]
          });
        }
      } else distinct.push(message);
    }
    const representative = distinct.reduce((winner, candidate) =>
      candidate.correction > winner.correction
        || (candidate.correction === winner.correction && candidate.receivedOrder > winner.receivedOrder)
        ? candidate : winner);
    representatives.push(representative);
    sliceGroups.push({sliceId, representative, versions: distinct});
  }

  // 相互引用未齐：取消指令指向的临时片尚未收到。
  const pendingReferences = cancels
    .filter(message => !groups.has(message.cancelOf))
    .map(message => ({kind: 'cancelOf', reference: message.cancelOf, from: message.sliceId,
      receiptHash: message.receiptHash, validStart: message.validStart, validEnd: message.validEnd}));

  // 取消指令指向了非临时片，属于来源语义矛盾，暴露而不是静默丢弃。
  const misdirectedCancels = cancels
    .filter(message => groups.has(message.cancelOf))
    .filter(message => representatives.find(item => item.sliceId === message.cancelOf)?.interpretation !== 'TEMPDELTA')
    .map(message => ({kind: 'cancel-target-not-temp', cancel: message.sliceId, target: message.cancelOf,
      receiptHash: message.receiptHash}));

  // 同设施、同解释、同 sequence 的不同 sliceId 构成同一业务链；链内在有效区间上重叠即来源矛盾。
  // 不同解释（基准/永久/临时）之间的重叠属于正常分层覆盖，不在此判矛盾。
  const chainConflicts = [];
  const chains = new Map();
  for (const message of representatives) {
    const key = `${message.interpretation}:${message.sequence}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(message);
  }
  for (const [chain, members] of chains) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        if (intervalsOverlap(members[i], members[j])) {
          chainConflicts.push({
            kind: 'overlapping-slices',
            chain,
            sliceIds: [members[i].sliceId, members[j].sliceId],
            intervals: [
              {sliceId: members[i].sliceId, validStart: members[i].validStart, validEnd: members[i].validEnd},
              {sliceId: members[j].sliceId, validStart: members[j].validStart, validEnd: members[j].validEnd}
            ],
            receipts: [...new Set([members[i].receiptHash, members[j].receiptHash].filter(Boolean))]
          });
        }
      }
    }
  }

  for (const item of malformed) {
    anomalies.push({kind: 'malformed-message', sliceId: item.sliceId ?? null,
      reason: item.anomaly, receiptHash: item.receiptHash ?? null});
  }

  return {
    messages: ordered,
    groups: sliceGroups,
    representatives,
    cancels,
    pendingReferences,
    conflicts: [...revisionConflicts, ...chainConflicts, ...misdirectedCancels],
    anomalies
  };
}

// 同一层内多片对同一属性给出不同取值即为矛盾；缺席属性不参与合并，显式 null 是合法取值。
function mergeLayer(messages, at) {
  const properties = {};
  const propertyEvidence = {};
  const firstMessage = {};
  const conflicted = new Set();
  const layerConflicts = [];
  for (const message of messages) {
    for (const [key, value] of Object.entries(message.properties ?? {})) {
      if (!Object.hasOwn(properties, key)) {
        properties[key] = value;
        propertyEvidence[key] = [message.sliceId];
        firstMessage[key] = message;
        continue;
      }
      propertyEvidence[key].push(message.sliceId);
      if (!sameValue(properties[key], value)) {
        conflicted.add(key);
        layerConflicts.push({
          kind: 'property-conflict',
          property: key,
          values: [{sliceId: firstMessage[key].sliceId, value: properties[key]},
            {sliceId: message.sliceId, value}],
          validStart: message.validStart,
          validEnd: message.validEnd,
          receipts: [...new Set([firstMessage[key].receiptHash, message.receiptHash].filter(Boolean))]
        });
      }
    }
  }
  return {properties, propertyEvidence, conflicted, layerConflicts};
}

// 回答“给定时刻设施资料是否齐备、哪些临时内容覆盖了基准”。
// 永远不替来源猜测开放状态：任何矛盾、缺基准、悬挂引用都会进入 issues，
// 受污染属性的 value 置为 null 且 indeterminate 为 true。
export function evaluateAt(facility, messages, at) {
  const organized = organizeFacility(messages);
  const active = organized.representatives.filter(message => covers(message, at));
  const activeCancels = organized.cancels.filter(message => covers(message, at));
  const cancelledIds = new Set(activeCancels.map(message => message.cancelOf));

  const baselineMessages = active
    .filter(message => message.interpretation === 'BASELINE' && !cancelledIds.has(message.sliceId));
  const permMessages = active
    .filter(message => message.interpretation === 'PERMDELTA' && !cancelledIds.has(message.sliceId));
  const tempMessages = active
    .filter(message => message.interpretation === 'TEMPDELTA' && !cancelledIds.has(message.sliceId));

  const layers = [
    {name: 'BASELINE', messages: baselineMessages},
    {name: 'PERMDELTA', messages: permMessages},
    {name: 'TEMPDELTA', messages: tempMessages}
  ];
  const merged = layers.map(layer => mergeLayer(layer.messages, at));
  const layerConflicts = merged.flatMap((result, index) =>
    result.layerConflicts.map(conflict => ({...conflict, layer: layers[index].name})));

  const conflictedProperties = new Set(layerConflicts.map(conflict => conflict.property));
  const provenance = {};
  const properties = {};
  for (let index = 0; index < merged.length; index += 1) {
    const layerName = layers[index].name;
    for (const key of Object.keys(merged[index].properties)) {
      const chain = provenance[key] ?? [];
      if (merged[index].conflicted.has(key)) {
        // 该层对该属性自相矛盾：记录全部来源片，取值置空，绝不参与最终决定。
        chain.push({layer: layerName, value: null, indeterminate: true,
          slices: merged[index].propertyEvidence[key]});
      } else {
        chain.push({layer: layerName, value: merged[index].properties[key],
          slices: merged[index].propertyEvidence[key]});
      }
      provenance[key] = chain;
    }
  }
  for (const [key, chain] of Object.entries(provenance)) {
    if (conflictedProperties.has(key)) {
      // 任一承载层自相矛盾时，该属性在此时刻不可判定：保留证据链但不输出猜测值。
      properties[key] = {value: null, indeterminate: true, provenance: chain};
    } else {
      const winner = chain[chain.length - 1];
      properties[key] = {value: winner.value, indeterminate: false, provenance: chain};
    }
  }

  // 哪些临时内容覆盖了基准：仅统计临时片真正改写了下层（基准+永久）取值的属性。
  // 变更片缺席的属性不参与合并；下层没有该属性时，临时片属于新增，不算覆盖。
  const lowerLayer = {};
  for (const key of Object.keys(merged[0].properties)) lowerLayer[key] = merged[0].properties[key];
  Object.assign(lowerLayer, merged[1].properties);
  const tempOverrides = [];
  for (const message of tempMessages) {
    const changed = [];
    for (const [key, value] of Object.entries(message.properties ?? {})) {
      if (conflictedProperties.has(key)) continue;
      if (Object.hasOwn(lowerLayer, key) && !sameValue(lowerLayer[key], value)) {
        changed.push({property: key, from: lowerLayer[key], to: value});
      }
    }
    tempOverrides.push({
      sliceId: message.sliceId,
      validStart: message.validStart,
      validEnd: message.validEnd,
      sequence: message.sequence,
      correction: message.correction,
      properties: message.properties ?? {},
      changed,
      receiptHash: message.receiptHash
    });
  }

  const activeTemporary = tempMessages.map(message => ({
    sliceId: message.sliceId,
    validStart: message.validStart,
    validEnd: message.validEnd,
    properties: message.properties ?? {},
    sequence: message.sequence,
    correction: message.correction,
    publicationIndex: message.receivedOrder,
    receiptHash: message.receiptHash
  }));
  const activeCancellations = activeCancels.map(message => ({
    sliceId: message.sliceId,
    cancelOf: message.cancelOf,
    validStart: message.validStart,
    validEnd: message.validEnd,
    publicationIndex: message.receivedOrder,
    receiptHash: message.receiptHash
  }));

  const issues = [];
  if (baselineMessages.length === 0) {
    issues.push({kind: 'no-baseline-at-instant', at});
  }
  // 相互引用未齐本身就是资料缺口：无论取消指令何时生效，都不能宣称该时刻资料齐备。
  for (const reference of organized.pendingReferences) {
    issues.push({...reference, kind: 'unresolved-reference'});
  }
  for (const conflict of organized.conflicts) {
    if (conflict.kind === 'overlapping-slices') {
      // 矛盾只在重叠区间内影响取值：查询时刻落在任一矛盾片区间内才挂在该时刻上。
      const touches = conflict.intervals.some(interval =>
        covers(interval, at));
      if (touches) issues.push(conflict);
    } else issues.push(conflict);
  }
  for (const conflict of layerConflicts) issues.push(conflict);
  for (const anomaly of organized.anomalies) issues.push(anomaly);

  const activeAll = [...active, ...activeCancels];
  const activeInterval = {from: null, to: null};
  if (activeAll.length) {
    activeInterval.from = Math.min(...activeAll.map(message => message.validStart));
    const finiteEnds = activeAll.map(message => message.validEnd)
      .filter(value => value !== null && Number.isFinite(value));
    if (finiteEnds.length) activeInterval.to = Math.min(...finiteEnds);
  }

  return {
    facility,
    at,
    ready: issues.length === 0,
    issues,
    properties,
    temporaryOverrides: tempOverrides,
    activeTemporary,
    activeCancellations,
    cancelledTemporaryIds: [...cancelledIds],
    activeInterval,
    evidence: {
      baseline: baselineMessages.map(message => message.sliceId),
      permanent: permMessages.map(message => message.sliceId),
      temporary: tempMessages.map(message => message.sliceId),
      pendingReferences: organized.pendingReferences,
      receipts: [...new Set([...active, ...activeCancels]
        .map(message => message.receiptHash).filter(Boolean))]
    }
  };
}

// 设施全量视图：保留原始发布次序与业务有效时间，不做任何折叠或猜测。
export function facilityState(facility, messages = []) {
  const organized = organizeFacility(messages);
  const published = [...messages]
    .sort((left, right) => left.receivedOrder - right.receivedOrder)
    .map(message => ({
      publicationIndex: message.receivedOrder,
      sliceId: message.sliceId,
      kind: message.kind,
      interpretation: message.interpretation ?? null,
      sequence: message.sequence ?? null,
      correction: message.correction ?? null,
      cancelOf: message.cancelOf ?? null,
      validStart: message.validStart,
      validEnd: message.validEnd,
      properties: message.properties ?? {},
      contentHash: message.contentHash ?? digestJson(message),
      receiptHash: message.receiptHash ?? null,
      anomaly: message.anomaly ?? null
    }));
  return {
    facility,
    ready: false,
    issues: [
      ...organized.pendingReferences.map(item => ({...item, kind: 'unresolved-reference'})),
      ...organized.conflicts,
      ...organized.anomalies
    ],
    baselineSliceIds: organized.representatives
      .filter(message => message.interpretation === 'BASELINE').map(message => message.sliceId),
    latestRepresentatives: organized.representatives.map(message => ({
      sliceId: message.sliceId,
      interpretation: message.interpretation,
      sequence: message.sequence,
      correction: message.correction,
      validStart: message.validStart,
      validEnd: message.validEnd
    })),
    cancellations: organized.cancels.map(message => ({
      sliceId: message.sliceId,
      cancelOf: message.cancelOf,
      validStart: message.validStart,
      validEnd: message.validEnd,
      publicationIndex: message.receivedOrder
    })),
    messages: published
  };
}
