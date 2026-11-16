# 航空地面设施通告的时间片资料采集

航空地面设施资料接收器。按设施采集交换站的基准（BASELINE）、永久变更（PERMDELTA）与临时覆盖（TEMPDELTA）三类时间片，保留原始发布次序与业务有效时间，并回答任意给定时刻的设施资料是否齐备、哪些临时内容覆盖了基准。交换站以JSON投影提供时间片，不涉及飞行控制或航路规划。

## 运行

使用 Node.js 22，依赖由 package-lock.json 固定。安装后可执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm start
```

服务启动本地来源与收件接口，默认端口分别为4011和4010。`POST /collect` 执行一轮时间片采集（可重复调用以补收迟到更正）；`GET /facilities`查看全部设施，`GET /facilities/:id/slices`查看按发布次序保存的时间片，`GET /facilities/:id/at?at=<时刻>`查询该时刻齐备性、属性溯源与临时覆盖；`GET /records`查看结构化记录，`GET /receipts`查看原文凭据，`GET /health`查看服务状态。`PORT`、`SOURCE_PORT`与`DATA_DIR`可分别设置端口和归档目录。

```sh
docker build -t aeronautical-timeslices .
docker run --rm --network none aeronautical-timeslices npm test
docker run --rm --network none aeronautical-timeslices npm run demo
docker run --rm -p 4010:4010 aeronautical-timeslices
```

## 资料语义

- 有效区间为左闭右开 `[validStart, validEnd)`，`validEnd: null` 表示开放结束。
- 变更片缺席的属性不清空下层取值；显式 `null` 才表示清空。层间优先级为临时 > 永久 > 基准。
- `correction` 递进为同片更正，历史版本全部保留；`cancelOf` 只取消目标临时片，不删除永久变更或历史消息。
- 引用未齐、来源重叠/矛盾、畸形消息都会作为证据暴露在 `issues`/`evidence` 中；受影响属性返回 `indeterminate: true`，服务不替来源猜测开放状态。
- 采集日志随归档持久化：翻页截断、进程重启后从上次日志继续补页、补收与重试悬挂引用。

## 资料组织

`provider/`是独立本地来源，`fixtures/`记录合成资料和来源阶段（含 late 补发更正、overlap 来源矛盾），`src/reader.mjs`负责翻页收件、补收与引用挂账，`src/timeline.mjs`是无副作用的时间片组织与时刻判定，`src/source.mjs`限定来源地址并记录响应字节，`src/archive.mjs`保存按摘要校验的原文、资料版本与可恢复的采集日志（v1 归档自动迁移到 v2）。`test/`覆盖语义规则、补收、重启、来源边界、原文完整性和服务联通。运行不依赖外网、数据库服务或真实设备。

完整来源约定见 `docs/source-contract.md`。项目只访问本地合成资料，不携带真实身份、密钥或业务数据。

## 快速查看

`npm run demo`启动实际来源和收件服务，先采集正常资料并查询时刻状态，再切换到 late 阶段演示补发永久更正与临时取消的补收，最后打印凭据；临时归档在退出时清理。正常完成时间小于90秒；需要保留数据时用`npm start`及独立`DATA_DIR`。
