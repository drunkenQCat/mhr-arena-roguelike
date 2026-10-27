# 策划原生能力研究的离线证据摘录

对应 [研究总表](../../research-design-native-capabilities.md)。通过 `scripts/collect-design-api-evidence.py` 从已有文件提取，无进程注入、无新 hook、无游戏状态写入。目录约 4 MB，只生成一次，不是常驻日志。

| 文件 | 含义 |
|---|---|
| `sdk-subset.json` | 项目 SDK 子集中相关类型，含字段与方法；方法元数据可能只保留一个重载 |
| `native-flow.json` | 历史首领调度现场的完整类型摘录 |
| `native-equipment.json` | 已有运行时元数据中的装备、换装和备份类型摘录 |
| `native-gui.json` | 另一轮调研保存的 17 个 GUI／库存根类型及继承链 |
| `rsz-candidates.json` | 序列化 schema 候选，不能当作 TDB 或运行时内存布局 |
| `manifest.json` | 输入路径、完整输入文件 SHA-256、选取类型数 |

`capturedAt` 保留输入原有时间信息；不是本轮重新采集时间，也不保证所有输入来自同一进程。历史方法绝对地址不能用于当前游戏进程。`native-gui.json` 的类型值是继承链数组，其他 TDB 文件的值是类型对象，不应混用解析逻辑。

REFramework 源码核对固定提交 `5bae4701396248a776c1de19f5be9552022295d5`；下载缓存位于 `.local/reframework-source-5bae4701`，公开源码永久链接已写入研究文档。没有把 Capcom 原始源码或完整游戏二进制加入仓库。
