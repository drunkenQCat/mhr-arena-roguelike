# T3 repop 实机实验（2026-10-26）

## A：尸体清理后，在 re.on_frame 单独调用 repop()

- 任务 900102，unique 928028325。第一只 98 / UID 0 已被原生登记讨伐，第二只 54 / UID 100 保持存活。
- 调用前：槽 0 SetStatus=End(4)，DestroyStatus=Dead(2)，原 UID 已从 boss 列表移除。怪种、位置、UID、原生目标计数均未主动改写。
- 18:50:30，调用一次 repop()，原生抛出 c0000005，Lua 捕获 VMContext::Exception。游戏仍可正常完成第二只讨伐并返回村庄。
- 错误 RIP 0x7ff7c1336006 = repop 入口 0x7ff7c1335fa0 + 0x66。
- 只读读取该进程函数机器码：mov rax,[rdi+0x50]；mov ecx,[rax+0x2d0]。错误寄存器 RAX=0。
- EnemySetInfo 的 OwnerEnemy 字段元数据偏移 0x40，加对象头 0x10 对应对象内 0x50。因此本次异常是读取已清空的 OwnerEnemy；并非仅凭方法名推断。
- 入口前 5 字节被 REFramework hook 改为跳转，后续代码与异常地址对应。没有修改任何机器码。
- 本次否定「已清理槽直接 repop」，不否定尸体尚存时的 repop，也不否定其他运行时队列复用路线。

原始 JSON、异常日志、探针版本及 SHA256、反汇编存于 on-frame/。trace 实际列表长度为 116；items 仅导出前 12 条，不是队列总长。

## 下一对照

保留原生 Dead 状态、OwnerEnemy 尚存的第一只尸体，继续在 re.on_frame 调用同一 repop() 一次。只改变生命周期时机；不更改种类、UID、原生计数或出怪参数。新版探针记录 OwnerEnemy 是否存在，滚动保留 180 份样本并始终输出 latest，避免旧版到上限后冻结观测。

## B：Dead 且 OwnerEnemy 尚存时调用 repop()

任务 unique -82576120。19:07:22 (Unix 1793012842)，原生已登记 UID 0 讨伐、死亡行为已启动，槽状态 Dead=3 / Destroy=0 / OwnerEnemy=true。单次 repop() 正常返回，状态立即变 End=4，RepopNum=0、EmGenId=0、UID=0、WaitSecond=0 均不变。随后观察到尸体自然清理，未出现新 UID，createEnemyFromSetInfo 仍为调用前的 4 次。没有重新出怪。

这证明 A 的异常与 OwnerEnemy 生命周期有关，但消除异常仍不足以获得首领复活。不能将方法成功返回当作刷怪成功。原始证据见 dead-owner/。

## C：已清理槽仅恢复 InitWait

任务 unique 714039215。Unix 1793018260，End=4 / DestroyDead=2 / OwnerEnemy=false 的第一只槽上仅调用 updateSetStatus(InitWait=0)。正常返回，SetStatus 变为 0；DestroyStatus 保持 2，EmGenId / UID 不变。至 1793018697（437 秒）仍无生成，createEnemyFromSetInfo 维持 4 次，场上仅 UID 100 的第二只。

因此单改 SetStatus 不足以复用已清理槽。下一步需区分 DestroyStatus 门控与 QuestManager 已释放 BossSet 的门控；不能直接跳到更改怪种或宣布无限复活成立。原始证据见 init-only/。

## 当前边界

三轮均为单次独立写入，无一证明首领原地复活。repop 的空引用原因已定位；队列重置需要更多前置条件，T3 保持开放。正式模组仍使用 reentry。离线守卫检查与 Lua 语法检查通过，它们仅验证探针本身，不能代替上述实机结果。
