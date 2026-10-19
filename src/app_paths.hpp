#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace openrash {

// Returns the directory containing the currently running executable.
std::filesystem::path resolve_executable_dir();

// Validates that a candidate directory contains the complete roadrash.fun web root.
bool validate_www_root(const std::filesystem::path& dir, std::string* reason = nullptr);

// Locates the bundled www/ game directory across CLI override, env var,
// Flatpak/system/portable share paths, and developer build directories.
std::filesystem::path resolve_www_root(const std::string& cli_override = "");

// Returns and creates the persistent XDG user data directory for saves/localStorage.
std::filesystem::path resolve_user_data_dir();

// Returns and creates the XDG user cache directory for WebKit shaders/media cache.
std::filesystem::path resolve_user_cache_dir();

}  // namespace openrash
