#pragma once
// Wayland wp_fractional_scale_v1 high-DPI scaling helpers
namespace openrash::wayland {
inline double compute_target_scale(int scale_factor, double surface_scale) {
    return (surface_scale > 0.0) ? surface_scale : static_cast<double>(scale_factor);
}
}
