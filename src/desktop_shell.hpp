#pragma once

#include <filesystem>
#include <string>

namespace openrash {

struct ShellOptions {
    std::string app_url;
    std::filesystem::path user_data_dir;
    std::filesystem::path user_cache_dir;
    bool start_fullscreen = false;
    bool smoke_test = false;
    bool require_gui = false;
};

// Launches the native Linux GTK4 + WebKitGTK-6.0 desktop window hosting the game.
// Returns 0 on clean exit, non-zero on error.
int run_desktop_shell(const ShellOptions& opts);

}  // namespace openrash
