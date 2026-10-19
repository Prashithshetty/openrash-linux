#include "app_paths.hpp"

#include <glib.h>
#include <unistd.h>

#include <array>
#include <cstdlib>
#include <stdexcept>

namespace openrash {

std::filesystem::path resolve_executable_dir() {
    std::array<char, 4096> buf{};
    const ssize_t len = ::readlink("/proc/self/exe", buf.data(), buf.size() - 1);
    if (len > 0) {
        buf[static_cast<std::size_t>(len)] = '\0';
        std::error_code ec;
        const auto exe_path = std::filesystem::canonical(buf.data(), ec);
        if (!ec) {
            return exe_path.parent_path();
        }
        return std::filesystem::path(buf.data()).parent_path();
    }
    return std::filesystem::current_path();
}

bool validate_www_root(const std::filesystem::path& dir, std::string* reason) {
    std::error_code ec;
    if (dir.empty() || !std::filesystem::is_directory(dir, ec)) {
        if (reason) *reason = "Directory does not exist: " + dir.string();
        return false;
    }

    static constexpr std::array<const char*, 12> kRequiredFiles = {
        "index.html",
        "ui.css",
        "app.js",
        "race.js",
        "mano.js",
        "lib/three.module.js",
        "lib/three.core.js",
        "assets/text.json",
        "assets/img/dash/bigmeter.png",
        "data/bikes.json",
        "data/cars.json",
        "data/peds.json",
    };

    for (const char* rel : kRequiredFiles) {
        const auto p = dir / rel;
        if (!std::filesystem::is_regular_file(p, ec) || std::filesystem::file_size(p, ec) == 0) {
            if (reason) *reason = "Missing or empty required game file: " + p.string();
            return false;
        }
    }
    return true;
}

std::filesystem::path resolve_www_root(const std::string& cli_override) {
    std::vector<std::filesystem::path> candidates;

    if (!cli_override.empty()) {
        candidates.emplace_back(cli_override);
    }
    if (const char* env_dir = std::getenv("OPENRASH_WWW_DIR"); env_dir && *env_dir) {
        candidates.emplace_back(env_dir);
    }

    const auto exe_dir = resolve_executable_dir();
    candidates.push_back(exe_dir / ".." / "share" / "openrash" / "www");
    candidates.push_back(exe_dir / ".." / "www");
    candidates.push_back(exe_dir / "www");
    candidates.emplace_back("/app/share/openrash/www");
    candidates.push_back(std::filesystem::path(g_get_user_data_dir()) / "openrash" / "www");
    candidates.push_back(std::filesystem::current_path() / "www");

    std::string last_reason;
    for (const auto& candidate : candidates) {
        std::error_code ec;
        const auto canon = std::filesystem::weakly_canonical(candidate, ec);
        const auto& check = ec ? candidate : canon;
        if (validate_www_root(check, &last_reason)) {
            return check;
        }
    }

    throw std::runtime_error(
        "Unable to locate valid OpenRash game assets directory (www/). Last check: " + last_reason);
}

std::filesystem::path resolve_user_data_dir() {
    const char* base = g_get_user_data_dir();
    std::filesystem::path dir = (base && *base)
                                    ? (std::filesystem::path(base) / "openrash")
                                    : (std::filesystem::temp_directory_path() / "openrash-data");
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    return dir;
}

std::filesystem::path resolve_user_cache_dir() {
    const char* base = g_get_user_cache_dir();
    std::filesystem::path dir = (base && *base)
                                    ? (std::filesystem::path(base) / "openrash")
                                    : (std::filesystem::temp_directory_path() / "openrash-cache");
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    return dir;
}

}  // namespace openrash
