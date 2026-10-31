# Flathub Submission & Review Guide

This guide details how OpenRash is submitted to the central Flathub repository ([flathub/flathub](https://github.com/flathub/flathub)).

## Application Metadata Summary

- **App ID**: `io.github.prashithshetty.OpenRash`
- **License**: MIT
- **Runtime**: `org.gnome.Platform//49`
- **SDK**: `org.freedesktop.Sdk//25.08`
- **Primary Category**: Game;ArcadeGame;ActionGame;

## Submission Checklist

- [x] App ID follows reverse-DNS domain standard (`io.github.prashithshetty.OpenRash`)
- [x] AppStream metadata passes `appstreamcli validate` with 0 errors
- [x] High-resolution 512x512 PNG application icon installed
- [x] FreeDesktop `.desktop` entry verified with `desktop-file-validate`
- [x] Offline bundle builds cleanly without network access during build phase
- [x] Permissions audited: `--device=dri`, `--socket=wayland`, `--socket=fallback-x11`, `--socket=pulseaudio`, `--share=ipc`

## PR Command

```bash
gh pr create --repo flathub/flathub \
  --title "Add io.github.prashithshetty.OpenRash" \
  --body "Adds OpenRash (complete native Linux desktop edition of 1996 Road Rash)."
```
