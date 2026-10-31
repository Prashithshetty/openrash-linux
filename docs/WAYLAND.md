# Wayland Display Architecture & Fractional Scaling

OpenRash supports modern Linux Wayland compositors (GNOME Shell / Mutter, KDE KWin, Sway, Hyprland) with native sub-pixel fractional scaling.

## Architecture

1. **Protocol Support**:
   - `wp_fractional_scale_manager_v1`
   - `wp_viewport`
   - Dynamic buffer scaling without Xwayland blur

2. **Configuration**:
   - Run under native Wayland (default on modern systems):
     ```bash
     GDK_BACKEND=wayland openrash
     ```
   - Force X11 / Xwayland fallback if needed:
     ```bash
     GDK_BACKEND=x11 openrash
     ```

3. **High-DPI WebGL Buffering**:
   The WebKitGTK 6.0 rendering pipeline maps the internal WebGL framebuffer directly to Wayland surface dimensions, ensuring razor-sharp 2D sprite scaling and 3D road rendering at 125%, 150%, 175%, and 200% desktop scale factors.
