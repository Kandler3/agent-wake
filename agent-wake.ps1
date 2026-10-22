$ErrorActionPreference = 'Stop'
$codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$settingsPath = if ($env:AGENT_WAKE_CONFIG) {
    $env:AGENT_WAKE_CONFIG
} else {
    Join-Path $codexDirectory 'agent-wake\shared-desktop.json'
}
$nodeExecutable = $null
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $nodeExecutable = $settings.node
}
if ($nodeExecutable) {
    if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
        throw 'Configured Node runtime is missing. Update the node path in your App Server configuration.'
    }
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 22 or newer is required. Install Node or set node in your App Server configuration.' }
    $nodeExecutable = $nodeCommand.Source
}
$entry = Join-Path $PSScriptRoot 'cli.mjs'
& $nodeExecutable $entry @args
exit $LASTEXITCODE
