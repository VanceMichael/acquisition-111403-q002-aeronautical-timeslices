import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSource} from '../provider/server.mjs';
import {startIntake} from '../src/app.mjs';

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${await response.text()}`);
  return response.json();
}

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startSource();
const intake = await startIntake({origin: source.origin, directory});
try {
  console.log('== 第一次收件（正常来源：基准 + 临时片） ==');
  console.log(JSON.stringify(await (await fetch(intake.origin + '/collect', {method: 'POST'})).json()));

  console.log('\n== 发布次序与业务有效时间 ==');
  const slices = await getJson(intake.origin + '/facilities/stand1/slices');
  for (const message of slices.messages) {
    console.log(`#${message.publicationIndex} ${message.sliceId} [${message.validStart}, ${message.validEnd}) ${message.interpretation ?? message.kind}`);
  }

  console.log('\n== 时刻查询：t=15 临时片覆盖基准 ==');
  console.log(JSON.stringify(await getJson(intake.origin + '/facilities/stand1/at?at=15'), null, 2));

  console.log('\n== 来源切换到 late：补发永久更正与临时取消，再次收件 ==');
  source.setPhase('late');
  console.log(JSON.stringify(await (await fetch(intake.origin + '/collect', {method: 'POST'})).json()));

  console.log('\n== 补收后 t=15：临时片已被取消，永久变更保留 ==');
  const after = await getJson(intake.origin + '/facilities/stand1/at?at=15');
  console.log(JSON.stringify({ready: after.ready, properties: after.properties,
    activeCancellations: after.activeCancellations,
    temporaryOverrides: after.temporaryOverrides}, null, 2));

  console.log('\n== 全部原文凭据（含补收响应） ==');
  const receipts = await getJson(intake.origin + '/receipts');
  console.log(`共 ${receipts.length} 份凭据:`, receipts.map(item => item.url));
} finally {
  await intake.close();
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
