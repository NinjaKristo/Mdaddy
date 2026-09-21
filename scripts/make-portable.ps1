# 组装 U 盘便携版 zip：exe + Data/ 说明文件。
# 前置：npm run build && cargo build --release 已完成且 tauri.conf.json 版本号已更新
# （version 嵌入 exe 的 getVersion，改版本后必须重编再打包）。
# 用法：powershell -File scripts\make-portable.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "src-tauri\target\release\md-editor.exe"
if (-not (Test-Path $exe)) { throw "未找到 release exe：$exe（先完成 release 构建）" }

# 版本从 tauri.conf.json 读（唯一真值源），zip 文件名带版本（禁同名覆盖）
$conf = [System.IO.File]::ReadAllText((Join-Path $root "src-tauri\tauri.conf.json")) | ConvertFrom-Json
$v = $conf.version
if (-not $v -match '^\d+\.\d+\.\d+$') { throw "版本号异常：'$v'" }

$stage = Join-Path $root "dist-portable\md-editor-portable-v$v"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\Data" | Out-Null
Copy-Item $exe "$stage\md-editor.exe" -Force
$note = @(
  "本文件夹存放 MD 编辑器便携版的全部数据（配置 / 主题 / 会话 / 日志），跟随 U 盘移动。",
  "整个文件夹（md-editor-portable-v$v）拷到 U 盘任意位置，双击 md-editor.exe 即可运行。",
  "升级：用新版覆盖 md-editor.exe，本 Data 文件夹保留即可。",
  "删除本文件夹 = 退出便携模式（程序回到把数据存系统用户目录的默认行为）。"
) -join "`r`n"
[System.IO.File]::WriteAllText("$stage\Data\README.txt", $note, (New-Object System.Text.UTF8Encoding($false)))

$zip = Join-Path $root "dist-portable\md-editor-portable-v$v.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip

# 终值断言：zip 存在 + exe/Data 都在 + exe 版本与 conf 一致（终端值回显，防拼错路径空 zip）
$zipSize = (Get-Item $zip).Length
if ($zipSize -lt 1MB) { throw "zip 异常偏小：$zipSize 字节" }
$exeVer = (Get-Item "$stage\md-editor.exe").VersionInfo.ProductVersion
Write-Host "OK zip=$zip ($([math]::Round($zipSize/1MB,1))MB) conf=v$v exeProduct=$exeVer data=$(Test-Path "$stage\Data\README.txt")"
