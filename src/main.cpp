#include "app_paths.hpp"
#include "desktop_shell.hpp"
#include "local_server.hpp"

#include <cstring>
#include <iostream>
#include <string>

namespace {

void print_help(const char* prog) {
    std::cout << "OpenRash (Native Linux Desktop Edition of roadrash.fun)\n"
              << "Usage: " << prog << " [options]\n\n"
              << "Options:\n"
              << "  -f, --fullscreen      Launch directly in fullscreen mode (toggle anytime with F11)\n"
              << "  --www-dir <path>      Override path to bundled www/ game assets directory\n"
              << "  --check-assets        Verify offline game asset bundle & embedded server, then exit\n"
              << "  --smoke-test          Boot embedded server + GTK4/WebKitGTK shell, verify UI & WebGL, exit\n"
              << "  --require-gui         Fail --smoke-test if no X11/Wayland display is available\n"
              << "  -v, --version         Print version information\n"
              << "  -h, --help            Show this help message\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::string www_override;
    bool fullscreen = false;
    bool check_assets = false;
    bool smoke_test = false;
    bool require_gui = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg(argv[i]);
        if (arg == "-h" || arg == "--help") {
            print_help(argv[0]);
            return 0;
        }
        if (arg == "-v" || arg == "--version") {
            std::cout << "openrash 2.0.0 (native Linux GTK4/WebKitGTK roadrash.fun build)\n";
            return 0;
        }
        if (arg == "-f" || arg == "--fullscreen") {
            fullscreen = true;
        } else if (arg == "--check-assets") {
            check_assets = true;
        } else if (arg == "--smoke-test") {
            smoke_test = true;
        } else if (arg == "--require-gui") {
            require_gui = true;
        } else if (arg == "--www-dir" && i + 1 < argc) {
            www_override = argv[++i];
        } else {
            std::cerr << "Unknown option: " << arg << "\n";
            print_help(argv[0]);
            return 2;
        }
    }

    try {
        const auto www_root = openrash::resolve_www_root(www_override);
        openrash::LocalServer server(www_root);
        server.start();

        if (check_assets) {
            std::cout << "[OK] Verified complete Road Rash bundle at: " << www_root << "\n"
                      << "[OK] Embedded localhost server bound at: " << server.base_url() << "\n";
            server.stop();
            return 0;
        }

        openrash::ShellOptions opts;
        opts.app_url = server.base_url();
        opts.user_data_dir = openrash::resolve_user_data_dir();
        opts.user_cache_dir = openrash::resolve_user_cache_dir();
        opts.start_fullscreen = fullscreen;
        opts.smoke_test = smoke_test;
        opts.require_gui = require_gui;

        const int rc = openrash::run_desktop_shell(opts);
        server.stop();
        return rc;
    } catch (const std::exception& ex) {
        std::cerr << "OpenRash fatal error: " << ex.what() << "\n";
        return 1;
    }
}
