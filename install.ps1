# Installs the account-switcher mod into Claude Code on Windows.
#
# From a copy of this repository:   .\install.ps1
# Straight from where it is hosted: & ([scriptblock]::Create((irm <repo>/raw/main/install.ps1))) -Source <repo-git-url>
#
# Options: -Uninstall to remove it, -Scope user|project|local (default user).
param(
  [string]$Source = '',
  [ValidateSet('user', 'project', 'local')][string]$Scope = 'user',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Marketplace = 'account-switcher'
$Plugin = 'account-switcher@account-switcher'
$MinVersion = [version]'2.1.287'

function Fail($message) {
  Write-Host "account-switcher: $message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail 'Claude Code is not installed. Get it from https://code.claude.com, then run this again.'
}

$version = [version](((claude --version) -split ' ')[0])
if ($version -lt $MinVersion) {
  Fail "mods need Claude Code $MinVersion or later, and you have $version. Run 'claude update' first."
}

if ($Uninstall) {
  claude plugin uninstall $Plugin --scope $Scope
  claude plugin marketplace remove $Marketplace
  Write-Host "Removed. Your saved logins are still in $env:USERPROFILE\.claude\accounts; delete that folder to remove them too."
  exit 0
}

# With no source given, install from the copy of the repository this script sits in.
if (-not $Source) {
  if (-not $PSScriptRoot -or -not (Test-Path (Join-Path $PSScriptRoot '.claude-plugin\marketplace.json'))) {
    Fail "run this from a copy of the repository, or pass the repository's git URL with -Source."
  }
  $Source = $PSScriptRoot
}

claude plugin marketplace remove $Marketplace 2>$null | Out-Null
claude plugin marketplace add $Source
if ($LASTEXITCODE -ne 0) { Fail 'could not add the marketplace.' }
claude plugin install $Plugin --scope $Scope
if ($LASTEXITCODE -ne 0) { Fail 'could not install the mod.' }

Write-Host ''
Write-Host 'Installed. Start a new Claude Code session, or run /reload-plugins in an open one.'
Write-Host 'Press Ctrl+Alt+Shift+numpad minus, or run /account-switch, to open the account sidebar.'
