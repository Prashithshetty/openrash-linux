#pragma once

#include <libsoup/soup.h>

#include <cstdint>
#include <filesystem>
#include <string>

namespace openrash {

class LocalServer {
public:
    explicit LocalServer(std::filesystem::path www_root,
                         std::string upstream_api_origin = "https://roadrash.fun");
    ~LocalServer();

    LocalServer(const LocalServer&) = delete;
    LocalServer& operator=(const LocalServer&) = delete;

    // Ensures GIO proxy resolution does not block 127.0.0.1 inside network-isolated Flatpak sandboxes.
    static void configure_sandbox_environment();

    // Starts listening on 127.0.0.1:<ephemeral_port> attached to the default GMainContext.
    void start();
    void stop();

    std::uint16_t port() const noexcept { return port_; }
    std::string base_url() const;
    const std::filesystem::path& www_root() const noexcept { return www_root_; }

    // Exposed for unit testing MIME mapping & path traversal guards.
    static const char* mime_type_for_path(const std::filesystem::path& path);
    bool resolve_safe_file(const std::string& uri_path, std::filesystem::path* out_file) const;

private:
    static void on_static_request(SoupServer* server,
                                  SoupServerMessage* msg,
                                  const char* path,
                                  GHashTable* query,
                                  gpointer user_data);

    static void on_api_request(SoupServer* server,
                               SoupServerMessage* msg,
                               const char* path,
                               GHashTable* query,
                               gpointer user_data);

    void handle_static(SoupServerMessage* msg, const char* path);
    void handle_api_proxy(SoupServerMessage* msg, const char* path);

    std::filesystem::path www_root_;
    std::string upstream_api_origin_;
    SoupServer* server_ = nullptr;
    SoupSession* proxy_session_ = nullptr;
    std::uint16_t port_ = 0;
};

}  // namespace openrash
