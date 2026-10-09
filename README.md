# Account switcher

A Claude Code mod for people with more than one Claude subscription. Each session can run on a different account, and you can switch a session live without logging out. Two terminals open side by side can be on your work and personal accounts at the same time.

![Opening the account sidebar, changing Clawd's hat, switching to the Work account and checking /status](docs/demo.gif)

It needs Claude Code 2.1.287 or later, the first release that loads mods. It has been tested on Linux with 2.1.295. The macOS and Windows code paths have unit tests but have not been run on either system.

## Quick start

Install it, start Claude Code, and run `/login` once for each account you want to use. After that, press Ctrl+Alt+Shift+numpad minus or run `/account-switch` to open the sidebar.

The one-liners below install from where the repository is hosted. Replace `<repo>` with its address, such as `https://github.com/you/account-switcher`. From a clone, run `./install.sh` or `.\install.ps1` in the repository folder instead.

### 🐧 Linux

```sh
curl -fsSL <repo>/raw/main/install.sh | sh -s -- <repo>.git
```

### 🍎 macOS

```sh
curl -fsSL <repo>/raw/main/install.sh | sh -s -- <repo>.git
```

### 🪟 Windows

In PowerShell:

```powershell
& ([scriptblock]::Create((irm <repo>/raw/main/install.ps1))) -Source <repo>.git
```

Each script checks your Claude Code version, adds this repository as a plugin marketplace and installs the mod. To remove it, run the same script with `--uninstall` (`-Uninstall` on Windows).

## Using it

`/login` signs in to an account and saves it. A new login never replaces the one other sessions are using: the mod files it as an account of its own, and the session you ran `/login` in switches to it.

Open the sidebar with Ctrl+Alt+Shift+numpad minus, with `/account-switch`, or by clicking the "Account:" line above the prompt.

| Key | In the sidebar |
| :- | :- |
| Up, Down | Move between accounts |
| Enter | Switch this session to the selected account |
| Right, Left | Change the hat Clawd wears for that account |
| a | Add an account (runs `/login`) |
| Esc | Close |

![The account sidebar, with the active account at the top and two others below](docs/sidebar.png)

The account at the top, under ACTIVE, is the one this session uses. Every other session keeps its own. Clawd sits beside each account, and his hat tells them apart at a glance. There are 13 to choose from, and each account remembers its own.

The same things work as commands, which is handy in `claude -p` where there is no sidebar:

```text
/account-switch work                 switch by label, email, or the start of either
/account-switch 2                    switch by position in the list
/account-switch list
/account-switch rename sam@acme.example Work
/account-switch hat work crown
/account-switch forget client
```

Don't use `/logout` to change accounts. Claude Code revokes the login on Anthropic's side when you log out, so every session using that account is signed out and you would have to sign in to it again. The mod asks before letting `/logout` go ahead.

![The confirmation shown before /logout](docs/logout.png)

## Configuration

The shortcut and the hat keys live in `~/.claude/keybindings.json`, which the mod edits the first time it runs. It binds Ctrl+Alt+Shift+- to open the sidebar, and Right and Left in mod panes to change hats.

- To turn both off, run `/account-switch keys off`. `/account-switch keys on` puts them back.
- To use a different key, change the `ctrl+alt+shift+-` entry in the `Global` block to any key you like. Keep its value, `app:toggleDiffPreSession`.
- If you already bound Right or Left in the `Pane` context, the mod leaves your binding alone. Hats can then still be set with `/account-switch hat`.

The numpad minus works in terminals that report modifier keys on it: kitty, WezTerm, Ghostty, foot, iTerm2 with the kitty keyboard protocol, and xterm with `modifyOtherKeys`. Claude Code can't tell numpad minus from the main minus key, so Ctrl+Alt+Shift with the main minus opens the sidebar too. In a terminal that reports neither, rebind it as above.

`CLAUDE_CONFIG_DIR` is respected if you keep Claude Code's files somewhere other than `~/.claude`.

## How it works

Claude Code reads its login from the directory named by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, or from `~/.claude` when that is unset. The mod gives each account a directory of its own under `~/.claude/accounts/` and points each session's variable at the account it should use. Token refreshes then land in that account's own copy, and a second session on another account never sees them. The login in `~/.claude` itself is the default account, which sessions start on and which `claude` without the mod keeps using.

On Linux and Windows each account's login is a `.credentials.json` in its directory, readable only by you, the same way Claude Code stores its own. On macOS, where Claude Code keeps logins in the Keychain, each account is a Keychain item named after its directory.

There is one catch. `~/.claude.json` holds a single "signed in as" record that every session shares, and `/status` reads it. So `/status` first points that record at the session's own account and waits about a second and a half for Claude Code to re-read the file. Requests never depend on that record, because they use each session's own login.

A session remembers its account across `claude --resume`.

## Previewing the sidebar

`scripts/preview-designs.sh` opens Claude Code with made-up accounts and every sidebar design that was considered, in a throwaway home directory. Nothing touches your real login. `/design hats` there shows every hat.

## Development

```sh
cd mods/account-switcher && claude plugin test       # unit tests, no session or network
scripts/integration-test.sh [path-to-claude]         # two real sessions against a fake API
scripts/screenshots.sh [path-to-claude]              # regenerates docs/
```

The integration test runs two Claude Code sessions side by side on one throwaway home directory. One stays on the default account and the other switches away and back. A fake API records which token each session sent, and both sessions run `/status`. It needs Python with `pyte`, and the screenshot script also needs `Pillow` and `fonttools`.
