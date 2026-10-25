/**
 * 独立线程执行原生 SQLite；采用自包含 JS，使 tsx 源码与 tsc 产物共用入口。
 * 不加载应用模块、不访问业务数据库，也不在主线程执行同步写库。
 */
export const metricsWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.sqliteModule);
const db = new Database(workerData.path);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 1000');
db.exec('CREATE TABLE IF NOT EXISTS sources (instance TEXT PRIMARY KEY, source TEXT NOT NULL, descriptors TEXT NOT NULL, dropped INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, sequence INTEGER NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, mono REAL NOT NULL, value REAL NOT NULL, context TEXT NOT NULL, detail TEXT, UNIQUE(instance, sequence)); CREATE INDEX IF NOT EXISTS records_time ON records(ts); CREATE TABLE IF NOT EXISTS aggregates (bucket INTEGER NOT NULL, instance TEXT NOT NULL, name TEXT NOT NULL, dimensions TEXT NOT NULL, count INTEGER NOT NULL, total REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, last REAL NOT NULL, histogram TEXT NOT NULL, PRIMARY KEY(bucket,instance,name,dimensions)); CREATE INDEX IF NOT EXISTS aggregate_time ON aggregates(bucket); CREATE TABLE IF NOT EXISTS baselines (id TEXT PRIMARY KEY, created INTEGER NOT NULL, body TEXT NOT NULL);');
const bounds = [0,0.25,0.5,1,2,4,8,16,16.667,25,33.334,50,64,100,128,200,256,400,512,750,1000,1500,2000,4000,8000,16000,32000,60000,120000,1000000,Number.MAX_VALUE];
let lastCleanup = 0;

/** 去掉序号维度，避免分钟聚合随每个正文事件产生一行。 */
function dimensionsOf(context) {
  const result = { ...context };
  delete result.seq;
  delete result.seqEnd;
  return result;
}

/** 把记录放入固定桶；聚合时合并桶计数而非平均分位数。 */
function bucketOf(value) {
  return bounds.findIndex((bound) => value <= bound);
}

/** 事务内插入去重并更新分钟分布，重复提交不重复累计。 */
const ingest = db.transaction((batch) => {
  const now = Date.now();
  const previous = db.prepare('SELECT source,descriptors FROM sources WHERE instance=?').get(batch.source.instanceId);
  if (previous && previous.source !== JSON.stringify(batch.source)) throw new Error('source conflict');
  if (previous && previous.descriptors !== JSON.stringify(batch.descriptors)) throw new Error('descriptor conflict');
  db.prepare('INSERT INTO sources(instance,source,descriptors,dropped,closed,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(instance) DO UPDATE SET dropped=max(dropped,excluded.dropped),closed=max(closed,excluded.closed),updated=excluded.updated').run(batch.source.instanceId,JSON.stringify(batch.source),JSON.stringify(batch.descriptors),batch.dropped,batch.closed ? 1 : 0,now);
  let accepted = 0;
  for (const record of batch.records) {
    if (record.ts < now - 3*86400000 || record.ts > now + 300000) throw new Error('record time out of range');
    const change = db.prepare('INSERT OR IGNORE INTO records(instance,sequence,name,ts,mono,value,context,detail) VALUES(?,?,?,?,?,?,?,?)').run(batch.source.instanceId,record.sequence,record.name,record.ts,record.monoMs,record.value,JSON.stringify(record.context),record.detail ?? null);
    if (!change.changes) continue;
    accepted += 1;
    const bucket = Math.floor(record.ts/60000)*60000;
    const dimensions = JSON.stringify(dimensionsOf(record.context));
    const existing = db.prepare('SELECT * FROM aggregates WHERE bucket=? AND instance=? AND name=? AND dimensions=?').get(bucket,batch.source.instanceId,record.name,dimensions);
    const histogram = existing ? JSON.parse(existing.histogram) : bounds.map(() => 0);
    histogram[bucketOf(record.value)] += 1;
    db.prepare('INSERT INTO aggregates(bucket,instance,name,dimensions,count,total,min,max,last,histogram) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bucket,instance,name,dimensions) DO UPDATE SET count=excluded.count,total=excluded.total,min=excluded.min,max=excluded.max,last=excluded.last,histogram=excluded.histogram').run(bucket,batch.source.instanceId,record.name,dimensions,(existing?.count ?? 0)+1,(existing?.total ?? 0)+record.value,Math.min(existing?.min ?? record.value,record.value),Math.max(existing?.max ?? record.value,record.value),record.value,JSON.stringify(histogram));
  }
  return { accepted };
});

/** 定期清理并按数据库预算淘汰最旧明细和聚合，避免无限增长。 */
function cleanup() {
  const now = Date.now();
  if (now-lastCleanup < 60000) return;
  lastCleanup = now;
  db.prepare('DELETE FROM records WHERE ts < ?').run(now-3*86400000);
  db.prepare('DELETE FROM aggregates WHERE bucket < ?').run(now-30*86400000);
  const pageSize = db.pragma('page_size',{simple:true});
  let attempts = 0;
  while ((db.pragma('page_count',{simple:true})-db.pragma('freelist_count',{simple:true}))*pageSize > workerData.budgetBytes && attempts < 64) {
    const changed = db.prepare('DELETE FROM records WHERE id IN (SELECT id FROM records ORDER BY ts LIMIT 2048)').run().changes;
    if (!changed) db.prepare('DELETE FROM aggregates WHERE rowid IN (SELECT rowid FROM aggregates ORDER BY bucket LIMIT 2048)').run();
    attempts += 1;
  }
  db.prepare('DELETE FROM sources WHERE updated < ? AND instance NOT IN (SELECT instance FROM aggregates)').run(now-30*86400000);
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** 所有查询先按时间索引收窄，再应用固定维度白名单。 */
function matches(context, source, query) {
  const filters = ['sessionId','turnStartSeq','agentId','model','appVersion','buildMode','deviceModel','refreshRate','renderer','scenario'];
  if (query.sourceId && source.sourceId !== query.sourceId) return false;
  if (query.instanceId && source.instanceId !== query.instanceId) return false;
  if (query.component && source.component !== query.component) return false;
  return filters.every((key) => query[key] === undefined || context[key] === query[key]);
}

/** 汇总固定桶并返回近似分位数与桶边界，客户端不得二次平均 P95。 */
function series(query) {
  const rows = db.prepare('SELECT a.*,s.source,s.descriptors FROM aggregates a JOIN sources s ON s.instance=a.instance WHERE a.bucket>=? AND a.bucket<=? AND (? IS NULL OR a.name=?) ORDER BY a.bucket').all(Math.floor(query.from/60000)*60000,query.to,query.name ?? null,query.name ?? null);
  const groups = new Map();
  for (const row of rows) {
    const context = JSON.parse(row.dimensions);
    const source = JSON.parse(row.source);
    if (!matches(context,source,query)) continue;
    const key = JSON.stringify([row.bucket,source.instanceId,row.name,row.dimensions]);
    const entry = { bucket:row.bucket,source,name:row.name,context,count:row.count,total:row.total,min:row.min,max:row.max,last:row.last,histogram:JSON.parse(row.histogram), descriptor:JSON.parse(row.descriptors).find((item)=>item.name===row.name) };
    groups.set(key,entry);
  }
  const values = [...groups.values()].map((entry) => {
    const quantile = (fraction) => {
      let total = 0;
      for (let i=0;i<bounds.length;i+=1) {
        total += entry.histogram[i];
        if (total >= Math.ceil(entry.count*fraction)) return Math.min(bounds[i],entry.max);
      }
      return entry.max;
    };
    return { ...entry,mean:entry.total/entry.count,p50:quantile(.5),p95:quantile(.95),p99:quantile(.99),throughput:entry.total/60 };
  });
  return {series:values.slice(query.offset,query.offset+query.limit),nextCursor:values.length>query.offset+query.limit ? String(query.offset+query.limit) : null,bucketBounds:bounds,approximate:true,windowMs:60000,from:query.from,to:query.to};
}

/** 游标分页使用数据库自增 ID；相同时间戳不会漏记录。 */
function traces(query) {
  const output = [];
  let cursor = query.offset;
  let exhausted = false;
  while (output.length < query.limit+1 && !exhausted) {
    const rows = db.prepare('SELECT r.*,s.source FROM records r JOIN sources s ON s.instance=r.instance WHERE r.id>? AND r.ts>=? AND r.ts<=? AND (? IS NULL OR r.name=?) ORDER BY r.id LIMIT 512').all(cursor,query.from,query.to,query.name ?? null,query.name ?? null);
    exhausted = rows.length < 512;
    for (const row of rows) {
      cursor = row.id;
      const context = JSON.parse(row.context);
      const source = JSON.parse(row.source);
      if (!matches(context,source,query)) continue;
      output.push({id:row.id,source,sequence:row.sequence,name:row.name,value:row.value,ts:row.ts,monoMs:row.mono,context,...(row.detail ? {detail:row.detail}:{})});
      if (output.length >= query.limit+1) break;
    }
  }
  const page = output.slice(0,query.limit);
  return {records:page,nextCursor:output.length>query.limit ? String(page.at(-1).id):null};
}

/** 保存独立环境签名，只有签名集合一致才进行版本性能比较。 */
function environments(result) {
  return [...new Set(result.series.map((item)=>JSON.stringify({sourceId:item.source.sourceId,component:item.source.component,model:item.context.model,buildMode:item.context.buildMode,deviceModel:item.context.deviceModel,refreshRate:item.context.refreshRate,renderer:item.context.renderer,scenario:item.context.scenario})))].sort();
}

/** 汇总完整分布用于跨分钟比较，不能平均分位数。 */
function summary(result) {
  const groups = new Map();
  for (const entry of result.series) {
    const previous = groups.get(entry.name) ?? {name:entry.name,count:0,total:0,max:0,histogram:bounds.map(()=>0)};
    previous.count += entry.count;
    previous.total += entry.total;
    previous.max = Math.max(previous.max,entry.max);
    entry.histogram.forEach((count,index)=>previous.histogram[index]+=count);
    groups.set(entry.name,previous);
  }
  return [...groups.values()].map((entry)=>{
    let count = 0;
    let p95 = entry.max;
    for(let index=0;index<bounds.length;index+=1){
      count += entry.histogram[index];
      if(count>=Math.ceil(entry.count*.95)){p95=Math.min(bounds[index],entry.max);break;}
    }
    return {...entry,p95};
  });
}

/** 隔离协议将错误收敛为请求失败，不终止应用业务线程。 */
parentPort.on('message',(request)=>{
  try {
    let result;
    if(request.method==='ingest'){result=ingest(request.payload);cleanup();}
    else if(request.method==='catalog'){result={sources:db.prepare('SELECT * FROM sources ORDER BY instance').all().map((row)=>({source:JSON.parse(row.source),descriptors:JSON.parse(row.descriptors),dropped:row.dropped,closed:!!row.closed,updated:row.updated}))};}
    else if(request.method==='series'){result=series(request.payload);}
    else if(request.method==='traces'){result=traces(request.payload);}
    else if(request.method==='createBaseline'){
      const input=request.payload;
      const snapshot=series({...input.query,offset:0,limit:1000000});
      result={id:input.id,label:input.label,created:Date.now(),query:input.query,environments:environments(snapshot),summary:summary(snapshot),complete:db.prepare('SELECT coalesce(sum(dropped),0) AS dropped FROM sources').get().dropped===0};
      db.prepare('INSERT INTO baselines(id,created,body) VALUES(?,?,?)').run(result.id,result.created,JSON.stringify(result));
    }
    else if(request.method==='baselines'){
      const input=request.payload;
      result={baselines:db.prepare('SELECT body FROM baselines ORDER BY created DESC LIMIT ? OFFSET ?').all(input.limit,input.offset).map((row)=>JSON.parse(row.body))};
      if(input.compareId){
        const existing=db.prepare('SELECT body FROM baselines WHERE id=?').get(input.compareId);
        if(!existing) throw new Error('baseline not found');
        const baseline=JSON.parse(existing.body);
        const current=series({...input,offset:0,limit:1000000});
        const comparable=JSON.stringify(baseline.environments)===JSON.stringify(environments(current));
        result.comparison={baselineId:baseline.id,comparable,reason:comparable ? null:'environment mismatch',candidate:summary(current),baseline:baseline.summary};
      }
    }
    else if(request.method==='health'){result={records:db.prepare('SELECT count(*) AS n FROM records').get().n,aggregateRows:db.prepare('SELECT count(*) AS n FROM aggregates').get().n,dropped:db.prepare('SELECT coalesce(sum(dropped),0) AS n FROM sources').get().n,bytes:db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true}),budgetBytes:workerData.budgetBytes};}
    else if(request.method==='close'){db.close();result=null;}
    else throw new Error('unknown observability operation');
    parentPort.postMessage({id:request.id,result});
    if(request.method==='close') parentPort.close();
  } catch(error){parentPort.postMessage({id:request.id,error:error instanceof Error ? error.message:'metrics storage error'});}
});
`;
