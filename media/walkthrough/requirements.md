## Requirements

Tachyon runs your agents as **tmux** sessions, so it needs tmux on the machine
your project lives on:

- **Linux / WSL:** `sudo apt install tmux` (or your distro's package)
- **macOS:** `brew install tmux`
- **Windows:** use **WSL** (open the folder via *Remote - WSL*) — native Windows is not supported

**tmux ≥ 3.6** is recommended (instant exit-code capture for one-shot commands).
