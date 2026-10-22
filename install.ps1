param(
    [string]$LauncherDirectory = (Join-Path $env:USERPROFILE '.local\bin')
)

$ErrorActionPreference = 'Stop'
$codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$destination = [IO.Path]::GetFullPath((Join-Path $codexDirectory 'agent-wake'))
$binDirectory = [IO.Path]::GetFullPath($LauncherDirectory)
$skillDirectory = [IO.Path]::GetFullPath((Join-Path $codexDirectory 'skills\agent-wake'))
if (Test-Path -LiteralPath (Join-Path $destination 'package.json')) {
    $existing = Get-Content -LiteralPath (Join-Path $destination 'package.json') -Raw | ConvertFrom-Json
    if ($existing.name -notin @('local-agent-wake', 'agent-wake')) { throw 'Refusing to overwrite another package.' }
}
$skillPath = Join-Path $skillDirectory 'SKILL.md'
if ((Test-Path -LiteralPath $skillPath) -and -not ((Get-Content -LiteralPath $skillPath -Raw).Contains('<!-- agent-wake managed skill -->'))) {
    throw 'An unrelated agent-wake skill already exists.'
}
$shimPath = Join-Path $binDirectory 'agent-wake.ps1'
if ((Test-Path -LiteralPath $shimPath) -and -not ((Get-Content -LiteralPath $shimPath -Raw).Contains('# agent-wake managed launcher'))) {
    throw 'An unrelated agent-wake launcher already exists.'
}
$cmdPath = Join-Path $binDirectory 'agent-wake.cmd'
if ((Test-Path -LiteralPath $cmdPath) -and -not ((Get-Content -LiteralPath $cmdPath -Raw).Contains('rem agent-wake managed launcher'))) {
    throw 'An unrelated agent-wake cmd launcher already exists.'
}
foreach ($folder in @($destination,$binDirectory,$skillDirectory)) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
foreach ($name in @('package.json','rpc.mjs','store.mjs','worker.mjs','cli.mjs','agent-wake.ps1','agent-wake.cmd','README.md','README.ru.md','LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $destination $name) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'skills\agent-wake\SKILL.md') -Destination $skillPath -Force
$agentMetadata = Join-Path $skillDirectory 'agents'
[IO.Directory]::CreateDirectory($agentMetadata) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'skills\agent-wake\agents\openai.yaml') -Destination (Join-Path $agentMetadata 'openai.yaml') -Force
foreach ($tree in @('docs','examples')) {
    $treeDestination = Join-Path $destination $tree
    [IO.Directory]::CreateDirectory($treeDestination) | Out-Null
    Copy-Item -Path (Join-Path $PSScriptRoot "$tree\*") -Destination $treeDestination -Recurse -Force
}

$escapedDestination = $destination.Replace("'","''")
$shim = @'
# agent-wake managed launcher
$ErrorActionPreference = 'Stop'
& '__ENTRY__' @args
exit $LASTEXITCODE
'@
$shim = $shim.Replace('__ENTRY__', (Join-Path $escapedDestination 'agent-wake.ps1'))
[IO.File]::WriteAllText($shimPath, $shim, [Text.UTF8Encoding]::new($false))
$cmd = [string]::Join([Environment]::NewLine, @('@echo off','rem agent-wake managed launcher','pwsh.exe -NoProfile -NonInteractive -File "%~dp0agent-wake.ps1" %*','exit /b %errorlevel%',''))
[IO.File]::WriteAllText($cmdPath, $cmd, [Text.ASCIIEncoding]::new())
[pscustomobject]@{ installed = $destination; command = $shimPath; skill = $skillPath } | ConvertTo-Json -Compress
