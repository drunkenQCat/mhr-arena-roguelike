import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unavailable, usage } from './exit.mjs';
const exec = promisify(execFile);

/** Local process management only. No shell interpolation of caller arguments. */
export async function launchGame(baseUrl) {
  if (process.platform !== 'win32') throw unavailable('启动游戏目前仅支持 Windows');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname))
    throw usage('远端 URL 不支持本机游戏进程管理');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$riseProcess = Get-Process -Name MonsterHunterRise -ErrorAction SilentlyContinue; if ($riseProcess) { @{requested=$false; alreadyRunning=$true; pid=@($riseProcess.Id)} | ConvertTo-Json -Compress } else { Start-Process -FilePath 'steam://rungameid/1446780' -WindowStyle Hidden; @{requested=$true; alreadyRunning=$false} | ConvertTo-Json -Compress }"],
    { windowsHide: true, timeout: 15000 });
  return { ok: true, ...JSON.parse(stdout.trim()), note: '启动请求不代表已进村；继续运行 game enter --slot N --timeout 120' };
}
