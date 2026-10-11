"""Drives an interactive Claude Code session in a pseudo-terminal.

Usage: drive.py <project-dir> <home> <claude> <mod-dir> <steps-json>

Each step is one of:
  ["type", text]            type text a character at a time
  ["key", name]             press enter, esc, tab, up, down, or ctrl_ (Ctrl+Shift+-)
  ["wait", seconds]         let the screen settle
  ["screen", label]         print the screen with row numbers
  ["png", [path, top, bottom, left?, right?]]   save part of the screen as a PNG (needs pyte and Pillow)
  ["frame", [top, bottom, left?, right?]]      capture a demo frame
  ["gif", path]                              save captured demo frames

Set DRIVE_BASE_URL to point the session at a fake API, and DRIVE_TAG to mark its requests.
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

import pyte

KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "down": "\x1b[B", "up": "\x1b[A", "ctrl_": "\x1f",
    # Ctrl+Alt+Shift+numpad minus as each kind of terminal sends it.
    "kp_minus_kitty": "\x1b[57412;8u",
    "kp_minus_xterm": "\x1b[27;8;45~",
    "kp_minus_plain": "\x1b\x1f",
    "kp_csi_1_8m": "\x1b[1;8m",
    "kp_ss3_8m": "\x1bO8m",
    "kp_ss3_m": "\x1bOm",
    "kp_plain_minus": "\x1b\x1f",
    "chord_x_a": "\x18a",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "a": "a",
    "1": "1",
    "2": "2",
}
for name, raw in json.loads(os.environ.get("DRIVE_KEYS", "{}")).items():
    KEYS[name] = raw

workdir, home, claude, mod, steps = sys.argv[1:6]
cols, rows = int(os.environ.get("DRIVE_COLS", 120)), int(os.environ.get("DRIVE_ROWS", 40))
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)

env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE", "DRIVE_"))}
env.update(HOME=home, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows),
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1")
env.pop("NO_COLOR", None)
env.update(FORCE_COLOR="3", COLORTERM="truecolor")
if os.environ.get("DRIVE_BASE_URL"):
    env["ANTHROPIC_BASE_URL"] = os.environ["DRIVE_BASE_URL"]
if os.environ.get("DRIVE_TAG"):
    env["ANTHROPIC_CUSTOM_HEADERS"] = f"x-session-tag: {os.environ['DRIVE_TAG']}"

pid, fd = pty.fork()
if pid == 0:
    os.chdir(workdir)
    os.execve(claude, [claude, "--plugin-dir", mod], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                stream.feed(os.read(fd, 65536))
            except OSError:
                return


def show(label):
    print(f"===== {label} =====")
    for number, line in enumerate(screen.display):
        if line.strip():
            print(f"{number:2} {line.rstrip()}")


PALETTE = {
    "default": (204, 204, 204), "black": (30, 30, 30), "red": (224, 108, 117), "green": (152, 195, 121),
    "yellow": (229, 192, 123), "blue": (97, 175, 239), "magenta": (198, 120, 221), "cyan": (86, 182, 194),
    "white": (220, 220, 220), "brightblack": (110, 110, 110),
}
BG = (24, 24, 27)

# Quarters each block element fills, as (column, row) with 0 left/top and 1 right/bottom.
TL, TR, BL, BR = (0, 0), (1, 0), (0, 1), (1, 1)
BLOCKS = {
    "█": [TL, TR, BL, BR], "▀": [TL, TR], "▄": [BL, BR], "▌": [TL, BL], "▐": [TR, BR],
    "▘": [TL], "▝": [TR], "▖": [BL], "▗": [BR], "▚": [TL, BR], "▞": [TR, BL],
    "▛": [TL, TR, BL], "▜": [TL, TR, BR], "▙": [TL, BL, BR], "▟": [TR, BL, BR],
}


def colour(value, fallback):
    if value == "default":
        return fallback
    if value in PALETTE:
        return PALETTE[value]
    if len(value) == 6:
        try:
            return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return fallback


def render_png(path, crop):
    from fontTools.ttLib import TTFont
    from PIL import Image, ImageDraw, ImageFont

    regular = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 16)
    bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 16)
    fallbacks = [
        ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf", 16),
        ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf", 16),
    ]
    cmaps = {f: TTFont(f.path).getBestCmap() for f in [regular, *fallbacks]}
    emoji_path = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
    # Noto Color Emoji only comes in a 109px bitmap strike, so glyphs are drawn
    # at that size and scaled down to two cells.
    emoji = ImageFont.truetype(emoji_path, 109) if os.path.exists(emoji_path) else None
    emoji_cmap = TTFont(emoji_path).getBestCmap() if emoji else {}

    def font_for(ch, is_bold):
        if ord(ch) in cmaps[regular]:
            return bold if is_bold else regular
        return next((f for f in fallbacks if ord(ch) in cmaps[f]), regular)

    cw, ch, pad = 10, 21, 16
    top, bottom, left, right = (list(crop) + [0, cols])[:4]
    img = Image.new("RGB", ((right - left) * cw + pad * 2, (bottom - top) * ch + pad * 2), BG)
    draw = ImageDraw.Draw(img)
    for row_index, y in enumerate(range(top, bottom)):
        row = screen.buffer[y]
        for x in range(left, right):
            cell = row[x]
            fg, bg = colour(cell.fg, PALETTE["default"]), colour(cell.bg, BG)
            if cell.reverse:
                fg, bg = bg, fg
            px, py = pad + (x - left) * cw, pad + row_index * ch
            if bg != BG:
                draw.rectangle([px, py, px + cw, py + ch], fill=bg)
            if not cell.data.strip():
                continue
            if cell.data[0] in BLOCKS:
                # Draw block elements as filled quarters so pixel art keeps its shape.
                for qx, qy in BLOCKS[cell.data[0]]:
                    x0, y0 = px + qx * cw // 2, py + qy * ch // 2
                    draw.rectangle([x0, y0, x0 + cw // 2, y0 + ch // 2], fill=fg)
                continue
            if emoji and ord(cell.data[0]) >= 0x1F000 and ord(cell.data[0]) in emoji_cmap:
                glyph = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
                ImageDraw.Draw(glyph).text((0, 0), cell.data, font=emoji, embedded_color=True)
                glyph = glyph.crop(glyph.getbbox() or (0, 0, 1, 1))
                size = ch - 3
                glyph = glyph.resize((size, size), Image.LANCZOS)
                img.paste(glyph, (px + (2 * cw - size) // 2, py + 2), glyph)
                continue
            draw.text((px, py + 2), cell.data, font=font_for(cell.data[0], cell.bold), fill=fg)
    if path:
        img.save(path)
    return img


pump(6)
frames = []
for kind, arg in json.loads(steps):
    if kind == "type":
        for character in arg:
            os.write(fd, character.encode())
            pump(0.03)
    elif kind == "key":
        # A chord's keys arrive as separate presses.
        if arg.startswith("chord_"):
            for part in KEYS[arg]:
                os.write(fd, part.encode())
                pump(0.2)
        else:
            os.write(fd, KEYS[arg].encode())
    elif kind == "wait":
        pump(float(arg))
        continue
    elif kind == "screen":
        show(arg)
        continue
    elif kind == "png":
        render_png(arg[0], arg[1:])
        continue
    elif kind == "frame":
        frames.append(render_png(None, arg))
        continue
    elif kind == "gif":
        if frames:
            frames[0].save(arg, save_all=True, append_images=frames[1:], duration=1800, loop=0)
        continue
    pump(0.6)

# Exit cleanly so Claude Code releases its own locks, then make sure it is gone.
for character in "/exit":
    os.write(fd, character.encode())
    pump(0.03)
os.write(fd, b"\r")
pump(3)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
