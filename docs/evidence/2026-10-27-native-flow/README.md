# inPlace：原生代码证据（2026-10-27）

本轮停止玩法写入实验，检查仍运行的 PID 48204。新增反射探针只导出字段偏移和方法地址；通过 ScriptRunner Reset 加载。随后使用 OpenProcess(QUERY_INFORMATION | VM_READ) / ReadProcessMemory 读取函数，不写进程内存、不远程调用函数。

`metadata.json` 来自当前运行版本，不能用旧 `sdk_types.json` 的偏移代替。反射第一次使用了不存在的 get_offset，弹出 Lua 错误；已按官方 REField API 改成 get_offset_from_base，重载成功。该错误未执行任何玩法写入。

## 1. 之前追错了消费列表

当前反射给出的 EnemyManager 字段偏移：

| 字段 | 对象起始偏移 | 当前元素数 |
| --- | --- | --- |
| `_EnemySetInfoList` | 0x410 | 116 |
| `_ZakoSetInfoList` | 0x418 | 0 |

`snow.enemy.EnemyManager.updateEnemySetInfoQuestHost.txt`：

```asm
7ff7c1bc3318 mov r8, qword ptr [r13 + 0x418]
```

后续迭代、检查 InitWait / ReviveWait、生成，都基于 0x418 的列表。`getEnemySetInfo()` 则从 0x410 按 EmSetId 查记录。两者不是同一列表。因此本次实验期间 updateEnemySetInfoQuestHost 的 enableRevival=true，不能说明首领记录会被其消费。

## 2. 首领由 QuestManager 的独立状态机调度

`updateBossEnemy.txt` 使用这些当前版本字段：

| 字段 | 偏移 | 用途 |
| --- | --- | --- |
| `_BossSet` | 0x2f0 | 任务首领记录 |
| `_BossSetCond` | 0x2f8 | 出场条件 |
| `_BossSetNoTbl` | 0x300 | 出场顺序 |
| `_BossSetCount` | 0x308 | 出场进度/下一个顺序索引，不是本表的容量 |
| `_BossLoadStartOk` | 0x328 | 加载开始许可 |
| `_ExtraEmRno` | 0x33c | 首领出场状态机 |

原生枚举 `sdk-dump/Enums_Internal.hpp` 的 ExtraEmRno：
CheckDeleteEnemy=1 → ExtraLot=2 → RequestLoad=5 → LoadWait=6 → SyncLoadWait=7 → CreateEnemy=8 → CheckNextEnemy=9 → End=10。这里只列本函数相关状态；不同条件可改变分支，不能把此箭头视作每帧必经的完整调用日志。

`updateBossEnemy` 在 CheckNextEnemy 阶段检查当前进度对应的 `_BossSetNoTbl`；负数或越界进入 End（7ff7c19b3a7b–7ff7c19b3ac2）。尾部同样按该顺序项寻找 EnemySetInfo；负数时跳过 updateExtraEnemyCommon（7ff7c19b3ad8–7ff7c19b3b25）。没有遍历整个 EnemySetInfoList 寻找被人为重置的旧记录。

当前只读现场 `runtime-state.json`：

```text
_ExtraEmRno = 10 (End)
_BossSetCount = 2
_BossSetNoTbl = [0, 1, -1, -1, -1, -1, -1]
```

**这里的 End 是出场安排耗尽，不是两只都死了或任务已结算。** 第二只仍活着。

## 3. 真正的首领创建入口及其前置阶段

`updateExtraEnemyCommon.txt` 分支 5/6/7/8 对应 RequestLoad / LoadWait / SyncLoadWait / CreateEnemy。

CreateEnemy=8 分支（7ff7c19bec81 开始）：

```text
如果传入 EnemySetInfo.SetStatus != Alive(2)：
    EnemyManager.createEnemyFromSetInfo(info, 1, -1)
QuestEmSetParam.State = Set(1)
++_BossSetCount
++_ExtraSetCount
……
_ExtraEmRno = CheckNextEnemy(9)
```

上述为反汇编转写，非原游戏源码。RequestLoad 分支会查删除条件并请求加载；后两阶段检查加载/同步条件，再进入 CreateEnemy。具体调用地址与当前反射方法名可在 metadata.json 对照，尚未完成所有子调用的语义核对。

结论：只更改 EnemySetInfo.SetStatus / DestroyStatus 不会自动重建任务出场顺序，也不会让已结束的调度器倒退。**复用完整首领调度流程**比继续尝试小怪复活状态有更直接的代码依据；尚未证明重新登记首领所需的全部不变量，也未实际续波。

## 4. repop 的失败有具体次数上限依据

`get_RepopMax.txt` 对参数对象的虚函数槽 0x40 发起调用。`repop.txt` 调用同一槽，将返回值和 `_RepopNum` 比较，控制后续进入 ReviveWait 或 End 的路径。

从当前第一只首领的参数对象解析该虚函数，结果见 `boss-param-repop-limit.txt`：

```asm
7ff7bee94ac0 xor eax, eax
7ff7bee94ac2 ret
```

因此这个参数对象的 RepopMax 为 0。此前 Dead 尸体实验的 `_RepopNum` 也为 0。repop 不是不带条件的“重新创建一次”入口；它还访问 OwnerEnemy，解释了清尸体后的空引用。

## 下一步的证据目标

只读跟踪 updateBossEnemy / updateExtraEnemyCommon 的 `_ExtraEmRno`、当前顺序项、EnemySetInfo 身份与加载阶段；在全新正常 M2a 中记录第一只死亡到第二只创建的完整过渡，核对静态分支。然后找出任务记录登记/清理方法的调用者与写入点，形成明确的最小前置条件后再实验。禁止仅凭以上发现就把状态机强设为 CreateEnemy，或直接调用创建函数跳过加载。

## 复核

```powershell
python scripts/inspect-inplace-native.py --pid <当前PID> --metadata <当前进程导出的JSON> --out <新证据目录>
```

需要 Python capstone。所有地址均为当前进程的绝对地址，重启后必须重新导出。文本为每个入口后 0x2000 字节的线性反汇编，含相邻函数和跳转表；不把整个文本视作一个函数，不把数据字节解码出的指令用于论证。部分入口已有 REFramework hook 跳转；本轮没有更改这些 hook 或机器码。

`manifest.json` 保存捕获块哈希。现场是连续读取而非原子快照。未修改正式 TS 游戏逻辑或正式 bundle。
