# Credits & Attribution

OpenRash packages the complete reverse-engineered 1996 *Road Rash* experience from [roadrash.fun](https://roadrash.fun) inside a native Linux C++20 GTK4 / WebKitGTK 6.0 / `libsoup-3.0` desktop runtime for preservation, research, and offline Linux desktop play.

---

## Original Road Rash (1994 / 1996)

*Road Rash* was created, developed, and published by **Electronic Arts Inc.** and **Papyrus Design Group**:

- **Original Publisher & Copyright Holder**: Electronic Arts Inc. (EA)
- **Windows 95 PC Port**: Papyrus Design Group
- **Original Creators & Design**: Randy Breen, Dan Geisler, Carl Mey, Walter I. Wright, and the Electronic Arts 3DO & PC development teams
- **Licensed Grunge Soundtrack Artists**:
  - **Soundgarden** (*Rusty Cage*, *Outshined*, *Kickstand*, *Superunknown*)
  - **Paw** (*Jessie*, *The Bridge*, *Pansy*)
  - **Swervedriver** (*Duel*, *Last Train to Satansville*)
  - **Therapy?** (*Auto Surgery*, *Teethgrinder*)
  - **Monster Magnet** (*Dinosaur Vacume*)
  - **Hammerbox** (*Simple Passing*, *Trip*)
- **Live-Action FMV Cast & Stunt Crew**: Original 1994 Electronic Arts full-motion video cast and motorcycle stunt team

All original game assets, characters, track designs, sound effects, music recordings, FMV cutscenes, fonts, and trademarks remain the property of their respective copyright and trademark owners.

---

## `roadrash.fun` Reverse-Engineering & Browser Port

Full credit and gratitude to **Kayode / Emmanuel O. Adegbite (`olucurious`)**:

- **Live Project**: [https://roadrash.fun](https://roadrash.fun)
- **Author Website**: [https://kayode.me](https://kayode.me)

`olucurious` reverse-engineered the 1996 Windows 95 `ROADRASH.EXE` and data archives (`TEXT/ENU.DLL`, course `.TRK` binaries, sprite sheets, cockpit HUDs, physics tables, AI rider personalities, and Mano-a-Mano WebRTC multiplayer) into the complete playable engine bundled in `www/`.

---

## Native Linux Desktop Shell & Open-Source Libraries

The native Linux C++20 desktop shell (`src/`), automated verification suite (`tests/`), asset fetcher (`tools/fetch_real_assets.py`), and Linux packaging (`packaging/`) rely on:

- **GTK 4** (`libgtk-4`) — LGPLv2.1+
- **WebKitGTK 6.0** (`libwebkitgtk-6.0`) — LGPLv2+ / BSD
- **libsoup 3.0** (`libsoup-3.0`) — LGPLv2+
- **GLib / GIO / GObject** — LGPLv2.1+
- **Three.js** (bundled in `www/lib/three.module.js`) — MIT License
- **Flatpak & FreeDesktop Specifications** — LGPLv2.1+
