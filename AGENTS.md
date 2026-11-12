# Agent 工作约定

## 文档与本地实验记录

正式文档正常纳入 Git；`docs/evidence/` 及 `research-*`、`review-*`、`playtest-*`、`fix-playtest-*`、`runtime-*`、`release-readiness-*` Markdown 是本地研究记录，新文件默认忽略。文件没有删除，默认搜索可能看不到它们。

```powershell
# 常规文档，遵循忽略规则
fd -t f -e md . docs
rg -n -g '*.md' 'Steam|多人' docs
# 显式包括本地研究与评审
fd --no-ignore-vcs -t f '^review-.*\.md$' docs
rg --no-ignore-vcs -n -g '*.md' 'Steam|isSingleQuest' docs
# 按日期或证据类型限定范围
fd --no-ignore-vcs --full-path -t f '2026-10-31' docs/evidence
rg --no-ignore-vcs -n -g '*.json' -g '*.lua' 'generation|requestId' docs/evidence/2026-10-31-party-mixed
# 只检查已跟踪文档
git ls-files docs
git grep -n 'Steam' -- docs
```

先搜索再判断文件不存在。结论写入正式文档；确需共享证据时只 `git add -f <具体文件>`，不要批量强加证据目录。不要使用 skip-worktree / assume-unchanged 隐藏修改，也不要擅自取消跟踪或改历史。

## Instance 地址与环境变量

本机已配置用户级环境变量 `MHR_IN1`、`MHR_IN2`、`MHR_IN3`、`MHR_IN4`，分别对应 Instance1 至 Instance4。运行命令时直接引用已有变量，不需要提前设置环境变量；不要重复赋值，也不要在命令、脚本或操作说明中硬编码 instance 的 HTTP 地址。

PowerShell 示例：

```powershell
node cli/mhr.mjs doctor --base-url "$env:MHR_IN1" --json
node cli/mhr.mjs saves list --base-url "$env:MHR_IN2" --json
```

若当前工具进程没有继承这些变量，先检查已有用户级环境变量并修正进程继承；不要据此认定变量未配置，更不要用明文地址重新定义或覆盖它们。

## 发布

只提交源码和必要文档，不提交 DLL、EXE、OBJ、MAP、生成 Lua、前端 dist、运行日志和临时探针。发布必须走 `scripts/release-files.json` 白名单与 `scripts/test-release.ps1`。Nightly 与标签发布复用 `.github/workflows/release.yml`；不能把离线模拟或单机验证写成真实双客户端验收。
