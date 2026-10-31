# OpenRash — Complete 1996 Road Rash (`roadrash.fun`) Native Linux Desktop Edition

[![Platform](https://img.shields.io/badge/Platform-Linux%20x86__64%20%2F%20Bazzite%20%2F%20Steam%20Deck-orange.svg)](https://github.com/Prashithshetty/openrash-linux)
[![Runtime](https://img.shields.io/badge/Native%20Shell-C%2B%2B20%20%2B%20GTK4%20%2B%20WebKitGTK%206.0-blue.svg)](CMakeLists.txt)
[![Bundle](https://img.shields.io/badge/Offline%20Assets-100%25%20Complete%20(202.2%20MiB)-brightgreen.svg)](tools/fetch_real_assets.py)
[![Flatpak](https://img.shields.io/badge/Package-Flatpak%20%26%20Portable%20tar.gz-purple.svg)](packaging/flatpak/io.github.prashithshetty.OpenRash.yml)

**OpenRash** brings the **exact, complete [roadrash.fun](https://roadrash.fun) 1996 Road Rash game** to Linux as a standalone native desktop application—no web browser, no Wine/Proton, and 100% playable offline out of the box.

---

## Highlights

- **100% Complete `roadrash.fun` Experience Offline (`859/859` Verified Assets, `202.2 MiB`)**:
  - **All Game Modes**: Quick Race (*Thrash Mode*), full 5-level *Big Game Mode* Career across **The City**, **The Peninsula**, **Pacific Coast Highway**, **Sierra Nevada**, and **Napa Valley**, *Olley's Bike Shop*, *Jukebox*, *Leaderboards*, and *Mano-a-Mano* online multiplayer.
  - **Every Asset Bundled Locally in `www/`**:
    - All **102 JSON data tables** (`text.json`, `bikes.json`, `cars.json`, `peds.json`, sprite rects, and 19 track/scenery/building/hill/spline JSONs per course).
    - All **5 2048px scenery atlases**, **76 road/cliff/rail/tunnel textures**, **32 traffic car sprites**, **163 pedestrian & roadside hazard sprites**, **15 rider sprite sheets**, police (`cop`) & flat ground shadow (`shadow`) sheets, and **5 sky horizons**.
    - All **4 authentic cockpit dashboards** (*Rat*, *Sport*, *Super*, and *Big Meter*), **24 character portraits**, **33 Olley's Bike Shop photos**, **13 postcards**, **28 race outcome screens**, and original Futura (`FUTB`, `FUTD`, `FUTR`) fonts.
    - All **48 WAV sound effects** (engine loops, tyre skids, crashes, weapons, police sirens, and 26 voice clips), all **14 licensed grunge soundtrack tracks** (`.ogg` + `.m4a`), and all **56 MP4 full-motion videos** (15 bike showroom spin videos, 2 MTV music videos `jessie.mp4` & `duel.mp4`, race intros, wins, losses, wrecks, busts, level promotions, and `finalwin.mp4`).
- **Native C++20 Linux Desktop Runtime (`src/`)**:
  - **Embedded Loopback HTTP + RFC 7233 Byte-Range Media Server (`libsoup-3.0`)**: Serves `www/` from `127.0.0.1:<ephemeral_port>` with `206 Partial Content` streaming for instant MP4 cutscene playback, canonical path-traversal protection, and an asynchronous `/api/*` reverse proxy to `https://roadrash.fun/api/*` that degrades cleanly to immediate `503` JSON when offline.
  - **Hardware-Accelerated GTK4 + WebKitGTK 6.0 Shell**: Dynamically binds `libgtk-4.so.1` and `libwebkitgtk-6.0.so.4` (`WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS`), enables WebGL + WebAudio + gesture-free FMV/music playback, persists career saves in `$XDG_DATA_HOME/openrash/webdata`, and works even inside network-isolated (`--unshare=network` / Flatseal) Flatpak sandboxes.
  - **Desktop Ergonomics**: Native `Fullscreen` (`F11` / `Alt+Enter`) and `Quit` menu integration, stripped web telemetry/Cloudflare/PostHog beacons and PWA install prompts, external link handoff via `xdg-open`, and native Linux gamepad support.

---

## Architecture Overview

```text
openrash-linux/
├── src/
│   ├── main.cpp            # CLI entrypoint (--fullscreen, --check-assets, --smoke-test)
│   ├── app_paths.{hpp,cpp} # XDG data/cache & portable/Flatpak www/ bundle discovery
│   ├── local_server.{hpp,cpp} # Embedded libsoup-3.0 static, Range (206), & /api/* proxy server
│   └── desktop_shell.{hpp,cpp} # Native GTK4 + WebKitGTK 6.0 window, WebGL, & JS bridge
├── www/                    # Complete offline roadrash.fun ES-module engine & 202.2 MiB assets
│   ├── app.js              # Menus, Career/Big Game progression, Bike Shop, FMV & Jukebox UI
│   ├── race.js             # 60 Hz 1996 Road Rash Three.js/WebGL renderer, physics, AI & combat
│   ├── mano.js             # Mano-a-Mano WebRTC DataChannel + wss://roadrash.fun/mano signaling
│   ├── audio.js            # WebAudio engine pitch synthesis, spatial sirens, SFX & music mixer
│   ├── data/               # 101 course/physics/sprite JSONs, atlases, cars, peds, riders, tex
│   └── assets/             # Cockpits, portraits, 48 WAV SFX, 14 grunge tracks, 56 MP4 videos
├── tests/
│   └── test_main.cpp       # Automated asset completeness, path-guard, & HTTP Range test suite
├── tools/
│   ├── fetch_real_assets.py # Recursive manifest crawler & verifier (859/859 asset checks)
│   └── verify_clean_repo.sh # Repository integrity check
└── packaging/              # Flatpak (org.gnome.Platform//49) & portable Linux desktop files
```

---

## Controls

| Action | Keyboard | Gamepad (Xbox / Steam Deck / Linux Controller) |
| :--- | :--- | :--- |
| **Accelerate** | `Up Arrow` / `W` | `R2` Trigger / `A` (South) |
| **Brake** | `Down Arrow` / `S` | `L2` Trigger / `B` (East) |
| **Steer Left / Right** | `Left` / `Right` or `A` / `D` | `Left Stick` / `D-Pad` |
| **Attack (Punch / Weapon)** | `Space` / `Enter` / `Z` | `X` (West) / `L1` / `R1` |
| **Kick** | `X` / `Shift` | `Y` (North) |
| **Toggle Camera / Dashboard** | `V` | `Select` / `Back` |
| **Mute / Unmute Music** | `M` | — |
| **Pause / Back** | `Escape` / `P` | `Start` / `Menu` |
| **Toggle Native Fullscreen** | `F11` / `Alt+Enter` | Main Menu `Fullscreen` Button |

*(Classic 1996 cheats such as `XYZZY`, `SPOON!`, `THWACK!`, `CHAIN`, `CLUB`, and `YES,OCCIFER` are also fully supported during races.)*

---

## Installation & Running

### Option 1: Pre-Built Offline Flatpak Bundle (Recommended for Bazzite, SteamOS, Fedora, Ubuntu, Arch)

Requires `org.gnome.Platform//49` runtime:

```bash
flatpak install --user -y dist/openrash-linux-x86_64.flatpak
flatpak run io.github.prashithshetty.OpenRash
```

### Option 2: Portable Linux Tarball (`.tar.gz`)

Runs directly on any modern Linux desktop with GTK4 (`libgtk-4.so.1`), WebKitGTK 6.0 (`libwebkitgtk-6.0.so.4`), and `libsoup-3.0`:

```bash
tar -xzf dist/openrash-linux-x86_64.tar.gz
cd openrash-linux-x86_64

# Run directly in-place:
./bin/openrash

# Or install into ~/.local/bin and your Desktop Application Menu (no sudo required):
./install-local.sh
openrash
```

### CLI Options

```text
openrash [options]
  -f, --fullscreen      Launch directly in fullscreen mode (toggle anytime with F11)
  --www-dir <path>      Override path to bundled www/ game assets directory
  --check-assets        Verify offline game asset bundle & embedded server, then exit
  --smoke-test          Boot embedded server + GTK4/WebKitGTK shell, verify UI & WebGL, exit
  --require-gui         Fail --smoke-test if no X11/Wayland display is available
  -v, --version         Print version information
  -h, --help            Show help message
```

---

## Building From Source

### Build Both Release Packages (`.tar.gz` + `.flatpak`)

```bash
./scripts/build_packages.sh
```

### Compile & Run Automated Tests via Flatpak SDK (Bazzite / Silverblue / SteamOS)

```bash
flatpak run --system --filesystem=host --command=sh org.freedesktop.Sdk//25.08 -c "
  cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
  cmake --build build -j\$(nproc)
  ctest --test-dir build --output-on-failure
"
./build/openrash --check-assets
./build/openrash --smoke-test --require-gui
```

### Compile Natively with System Packages

Prerequisites: `cmake >= 3.22`, C++20 compiler (`g++ >= 13` or `clang++ >= 16`), `glib-2.0`, `libsoup-3.0` development headers, and runtime `gtk4` + `webkitgtk-6.0`.

```bash
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
ctest --test-dir build --output-on-failure
./build/openrash
```

---

## Credits & Attribution

- **Original 1994/1996 Game**: Developed and published by **Electronic Arts Inc.** and **Papyrus Design Group** (Randy Breen, Dan Geisler, Carl Mey, Walter I. Wright, and the original cast, crew, and soundtrack artists: Soundgarden, Paw, Swervedriver, Therapy?, Monster Magnet, and Hammerbox).
- **Web Reverse-Engineering & Engine (`roadrash.fun`)**: **Kayode (`olucurious` / Emmanuel O. Adegbite)** — [roadrash.fun](https://roadrash.fun) / [kayode.me](https://kayode.me).
- **Native Linux Desktop Runtime & Packaging**: See [CREDITS.md](CREDITS.md) and [NOTICE.md](NOTICE.md). Native C++20 shell code is licensed under [MIT](LICENSE).
