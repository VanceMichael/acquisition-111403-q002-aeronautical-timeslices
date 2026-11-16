# 来源资料约定

航空地面设施资料接收器。已有功能领取单个基准设施对象；交换站以JSON投影提供时间片，不涉及飞行控制或航路规划。

## 交互与身份

GET /baseline 返回当前已核对的设施基准。GET /slices?facility=stand1&page=1 返回时间片页，next为后续页URL或null。interpretation 可为 BASELINE/PERMDELTA/TEMPDELTA；sequence按永久变更递进，correction对同一片修订，validStart包含而validEnd不包含，null为未给结束。properties中缺席与null不同；cancelOf指向被取消的临时片，sliceId全局唯一。GET /slices/:id读取被引用片。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：late、overlap。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

当前`src/reader.mjs`只收取/baseline提供的已整理资料。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。

## 时间片收件链路

`collectSlices(client, state, options)`在旧入口之上增加按设施的时间片采集，规则如下：

- 三类解释 `BASELINE`/`PERMDELTA`/`TEMPDELTA` 分层合并，层间优先级为临时 > 永久 > 基准；同层同 `sequence` 的不同 `sliceId` 在有效区间重叠时判为来源矛盾。
- 每条消息保存两套时间：`receivedOrder` 是原始发布/接收次序（单调、只追加），`validStart`/`validEnd` 是业务有效时间，区间为左闭右开，`validEnd: null` 表示开放结束。
- 变更片 `properties` 中缺席的属性不参与合并且不清空下层取值；显式 `null` 是合法取值，表示清空该属性。
- `correction` 递进表示同一片的更正，最新更正为当前代表，历史版本全部保留；相同 `correction` 但内容不同记为矛盾。
- `cancelOf` 是取消指令：只在其自身有效区间内标记目标临时片失效，不删除任何历史消息，也不影响永久变更。引用片未到达时进入 `journal.pending` 挂账，并通过 `GET /slices/:id` 主动补取；404 保留挂账待下轮重试，其他错误记入异常。
- 每轮收件从第一页重新遍历以补收迟到更正（可针对很早的生效区间），`next` 环路由运行内访问集合识别并留痕；`options.maxPages` 限制单轮页数，截断状态与日志随归档持久化，进程重启后从上次日志继续。
- 结构非法的消息不丢弃：标记 `kind: 'malformed'` 与异常原因后随原文凭据一并归档，查询时作为不齐备证据暴露。

## 归档与查询

归档索引升级到 version 2（v1 索引打开时自动迁移并保留全部历史）。每条消息必须引用已归档的来源原文摘要，否则拒绝写入；重开归档时逐份校验原文并核对消息凭据。对外接口：

- `POST /collect`：以上次持久化日志为起点执行一轮采集，返回设施数、消息数、挂账数、异常数与是否截断。
- `GET /facilities`：全部设施的时间片视图（发布次序、有效时间、取消指令、挂账与矛盾）。
- `GET /facilities/:id/slices`：单设施全量消息与组织结果。
- `GET /facilities/:id/at?at=<数值时刻>`：回答该时刻资料是否齐备（`ready`）、各属性取值与溯源链、哪些临时片覆盖了基准（`temporaryOverrides`）、生效的取消指令，以及全部矛盾/挂账/畸形证据（`issues`、`evidence`）。

存在重叠或来源矛盾、引用未齐、缺基准或畸形消息时 `ready` 为 false，受影响属性输出 `{value: null, indeterminate: true}` 并附证据；服务不替来源猜测任何开放状态。
