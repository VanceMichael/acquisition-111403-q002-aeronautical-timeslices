import {createServer} from 'node:http';
import {openArchive} from './archive.mjs';
import {createClient} from './source.mjs';
import {collectSlices} from './reader.mjs';
import {facilityState, evaluateAt} from './timeline.mjs';

export async function startIntake({origin,directory,port=0}) {
  const archive=await openArchive(directory);
  const server=createServer(async (request,response)=>{
    const send=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
    try {
      const url=new URL(request.url,'http://localhost');
      const path=url.pathname;
      if(request.method==='GET'&&path==='/health'){send({status:'运行中'});return;}
      if(request.method==='GET'&&path==='/records'){send(archive.records());return;}
      if(request.method==='GET'&&path==='/receipts'){send(archive.exchanges());return;}
      if(request.method==='GET'&&path==='/facilities'){
        const state=archive.ingestion();
        send(Object.values(state.facilities).map(bucket=>facilityState(bucket.id,bucket.messages)));
        return;
      }
      const sliceMatch=path.match(/^\/facilities\/([^/]+)\/slices$/);
      if(request.method==='GET'&&sliceMatch){
        const facility=decodeURIComponent(sliceMatch[1]);
        const state=archive.ingestion();
        const bucket=state.facilities[facility];
        if(!bucket){send({message:`未知设施: ${facility}`},404);return;}
        send(facilityState(facility,bucket.messages));
        return;
      }
      const atMatch=path.match(/^\/facilities\/([^/]+)\/at$/);
      if(request.method==='GET'&&atMatch){
        const facility=decodeURIComponent(atMatch[1]);
        const raw=url.searchParams.get('at');
        if(raw===null){send({message:'查询参数 at 为必填数值时刻'},400);return;}
        const at=Number(raw);
        if(!Number.isFinite(at)){send({message:`at 不是有限数值: ${raw}`},400);return;}
        const state=archive.ingestion();
        const bucket=state.facilities[facility];
        if(!bucket){send({message:`未知设施: ${facility}`},404);return;}
        send(evaluateAt(facility,bucket.messages,at));
        return;
      }
      if(request.method==='POST'&&path==='/collect'){
        const client=createClient(origin);
        // 以上次持久化日志为起点：中途重启后继续翻页、补收更正、重试悬挂引用。
        const result=await collectSlices(client,archive.ingestion());
        send(await archive.ingest(result,client.exchanges));
        return;
      }
      send({message:'接口不存在'},404);
    } catch(error){send({message:error.message},502);}
  });
  await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,archive,close:()=>new Promise(resolve=>server.close(resolve))};
}
