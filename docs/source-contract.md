# 来源资料约定

航空地面设施资料接收器。已有功能领取单个基准设施对象；交换站以JSON投影提供时间片，不涉及飞行控制或航路规划。

## 交互与身份

GET /baseline 返回当前已核对的设施基准。GET /slices?facility=stand1&page=1 返回时间片页，next为后续页URL或null。interpretation 可为 BASELINE/PERMDELTA/TEMPDELTA；sequence按永久变更递进，correction对同一片修订，validStart包含而validEnd不包含，null为未给结束。properties中缺席与null不同；cancelOf指向被取消的临时片，sliceId全局唯一。GET /slices/:id读取被引用片。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：late、overlap。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

当前`src/reader.mjs`只收取/baseline提供的已整理资料。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
