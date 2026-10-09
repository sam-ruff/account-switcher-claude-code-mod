#!/usr/bin/env sh
# Installs the account-switcher mod into Claude Code on Linux and macOS.
#
# From a copy of this repository:   ./install.sh
# Straight from where it is hosted: curl -fsSL <repo>/raw/main/install.sh | sh -s -- <repo-git-url>
#
# Options: --uninstall to remove it, --scope user|project|local (default user).
set -eu

MARKETPLACE=account-switcher
PLUGIN=account-switcher@account-switcher
MIN_VERSION=2.1.287

say() { printf '%s\n' "$*"; }
fail() { printf 'account-switcher: %s\n' "$*" >&2; exit 1; }

source=""
scope=user
action=install
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) action=uninstall ;;
    --scope) shift; scope=${1:-user} ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) source=$1 ;;
  esac
  shift
done

command -v claude >/dev/null 2>&1 || fail "Claude Code is not installed. Get it from https://code.claude.com, then run this again."

version=$(claude --version 2>/dev/null | awk '{print $1}')
oldest=$(printf '%s\n%s\n' "$MIN_VERSION" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)
if [ "$oldest" != "$MIN_VERSION" ]; then
  fail "mods need Claude Code $MIN_VERSION or later, and you have $version. Run 'claude update' first."
fi

if [ "$action" = uninstall ]; then
  claude plugin uninstall "$PLUGIN" --scope "$scope" || true
  claude plugin marketplace remove "$MARKETPLACE" || true
  say "Removed. Your saved logins are still in ~/.claude/accounts; delete that folder to remove them too."
  exit 0
fi

# With no source given, install from the copy of the repository this script sits in.
if [ -z "$source" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  [ -f "$here/.claude-plugin/marketplace.json" ] || fail "run this from a copy of the repository, or pass the repository's git URL."
  source=$here
fi

claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
claude plugin marketplace add "$source"
claude plugin install "$PLUGIN" --scope "$scope"

say ""
say "Installed. Start a new Claude Code session, or run /reload-plugins in an open one."
say "Press Ctrl+Alt+Shift+numpad minus, or run /account-switch, to open the account sidebar."
