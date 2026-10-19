#include "local_server.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <vector>

namespace openrash {

namespace {

std::string to_lower_ext(const std::filesystem::path& p) {
    std::string ext = p.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return ext;
}

bool is_subpath_of(const std::filesystem::path& child, const std::filesystem::path& root) {
    auto root_it = root.begin();
    auto child_it = child.begin();
    for (; root_it != root.end(); ++root_it, ++child_it) {
        if (child_it == child.end() || *child_it != *root_it) {
            return false;
        }
    }
    return true;
}

struct ProxyContext {
    SoupServerMessage* server_msg;
    SoupMessage* upstream_msg;
};

void on_proxy_finished(GObject* source, GAsyncResult* result, gpointer user_data) {
    auto* ctx = static_cast<ProxyContext*>(user_data);
    auto* session = SOUP_SESSION(source);
    GError* err = nullptr;
    GBytes* body = soup_session_send_and_read_finish(session, result, &err);

    if (!body || err) {
        if (err) g_error_free(err);
        if (body) g_bytes_unref(body);
        static constexpr char kOfflineJson[] = "{\"error\":\"offline\"}";
        soup_server_message_set_status(ctx->server_msg, SOUP_STATUS_SERVICE_UNAVAILABLE, nullptr);
        soup_server_message_set_response(ctx->server_msg, "application/json; charset=utf-8",
                                         SOUP_MEMORY_STATIC, kOfflineJson,
                                         sizeof(kOfflineJson) - 1);
    } else {
        const guint status = soup_message_get_status(ctx->upstream_msg);
        SoupMessageHeaders* up_headers = soup_message_get_response_headers(ctx->upstream_msg);
        const char* ct = soup_message_headers_get_content_type(up_headers, nullptr);
        gsize len = 0;
        const auto* ptr = static_cast<const char*>(g_bytes_get_data(body, &len));
        soup_server_message_set_status(
            ctx->server_msg,
            status ? status : static_cast<guint>(SOUP_STATUS_OK), nullptr);
        soup_server_message_set_response(ctx->server_msg,
                                         ct ? ct : "application/json; charset=utf-8",
                                         SOUP_MEMORY_COPY, ptr, len);
        g_bytes_unref(body);
    }

    soup_server_message_unpause(ctx->server_msg);
    g_object_unref(ctx->upstream_msg);
    g_object_unref(ctx->server_msg);
    delete ctx;
}

}  // namespace

LocalServer::LocalServer(std::filesystem::path www_root, std::string upstream_api_origin)
    : www_root_(std::filesystem::canonical(www_root)),
      upstream_api_origin_(std::move(upstream_api_origin)) {}

LocalServer::~LocalServer() {
    stop();
}

const char* LocalServer::mime_type_for_path(const std::filesystem::path& path) {
    const std::string ext = to_lower_ext(path);
    if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
    if (ext == ".js" || ext == ".mjs") return "text/javascript; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".json" || ext == ".webmanifest") return "application/json; charset=utf-8";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".webp") return "image/webp";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".ttf") return "font/ttf";
    if (ext == ".wav") return "audio/wav";
    if (ext == ".ogg") return "audio/ogg";
    if (ext == ".m4a") return "audio/mp4";
    if (ext == ".mp4") return "video/mp4";
    if (ext == ".wasm") return "application/wasm";
    return "application/octet-stream";
}

bool LocalServer::resolve_safe_file(const std::string& uri_path,
                                    std::filesystem::path* out_file) const {
    std::string rel = uri_path;
    while (!rel.empty() && rel.front() == '/') {
        rel.erase(rel.begin());
    }
    if (rel.empty()) {
        rel = "index.html";
    }
    if (rel.find('\0') != std::string::npos) {
        return false;
    }

    std::error_code ec;
    const auto candidate = std::filesystem::weakly_canonical(www_root_ / rel, ec);
    if (ec || !is_subpath_of(candidate, www_root_)) {
        return false;
    }
    if (!std::filesystem::is_regular_file(candidate, ec)) {
        return false;
    }
    if (out_file) {
        *out_file = candidate;
    }
    return true;
}

void LocalServer::configure_sandbox_environment() {
    // Inside a network-isolated Flatpak sandbox (--unshare=network / Flatseal offline mode),
    // GIO's default portal GProxyResolver fails with org.freedesktop.portal.Error.NotAllowed
    // even for 127.0.0.1 loopback sockets. Detect unshared network via /.flatpak-info before
    // GIO caches its default GProxyResolver so both libsoup and WebKitNetworkProcess use dummy.
    if (!g_file_test("/.flatpak-info", G_FILE_TEST_EXISTS)) {
        return;
    }
    GKeyFile* kf = g_key_file_new();
    bool has_network = false;
    if (g_key_file_load_from_file(kf, "/.flatpak-info", G_KEY_FILE_NONE, nullptr)) {
        gsize len = 0;
        gchar** shared = g_key_file_get_string_list(kf, "Context", "shared", &len, nullptr);
        if (shared) {
            for (gsize i = 0; i < len; ++i) {
                if (g_strcmp0(shared[i], "network") == 0) {
                    has_network = true;
                    break;
                }
            }
            g_strfreev(shared);
        }
    }
    g_key_file_free(kf);

    if (!has_network) {
        g_setenv("GIO_USE_PROXY_RESOLVER", "dummy", TRUE);
    }
}

void LocalServer::start() {
    if (server_) return;

    configure_sandbox_environment();

    proxy_session_ = soup_session_new_with_options("timeout", 6, "user-agent",
                                                   "OpenRash-Linux/2.0", nullptr);

    server_ = soup_server_new("server-header", "OpenRash-Local/1.0", nullptr);
    if (!server_) {
        throw std::runtime_error("Failed to create embedded SoupServer instance");
    }

    soup_server_add_handler(server_, "/api", &LocalServer::on_api_request, this, nullptr);
    soup_server_add_handler(server_, "/", &LocalServer::on_static_request, this, nullptr);

    GError* err = nullptr;
    if (!soup_server_listen_local(server_, 0, SOUP_SERVER_LISTEN_IPV4_ONLY, &err)) {
        std::string msg = err ? err->message : "unknown socket error";
        if (err) g_error_free(err);
        stop();
        throw std::runtime_error("Failed to bind embedded localhost HTTP server: " + msg);
    }

    GSList* uris = soup_server_get_uris(server_);
    if (!uris || !uris->data) {
        if (uris) g_slist_free_full(uris, reinterpret_cast<GDestroyNotify>(g_uri_unref));
        stop();
        throw std::runtime_error("Embedded localhost HTTP server returned no bound URI");
    }

    auto* uri = static_cast<GUri*>(uris->data);
    port_ = static_cast<std::uint16_t>(g_uri_get_port(uri));
    g_slist_free_full(uris, reinterpret_cast<GDestroyNotify>(g_uri_unref));
}

void LocalServer::stop() {
    if (server_) {
        soup_server_disconnect(server_);
        g_object_unref(server_);
        server_ = nullptr;
    }
    if (proxy_session_) {
        soup_session_abort(proxy_session_);
        g_object_unref(proxy_session_);
        proxy_session_ = nullptr;
    }
    port_ = 0;
}

std::string LocalServer::base_url() const {
    return "http://127.0.0.1:" + std::to_string(port_);
}

void LocalServer::on_static_request(SoupServer*,
                                    SoupServerMessage* msg,
                                    const char* path,
                                    GHashTable*,
                                    gpointer user_data) {
    static_cast<LocalServer*>(user_data)->handle_static(msg, path ? path : "/");
}

void LocalServer::on_api_request(SoupServer*,
                                 SoupServerMessage* msg,
                                 const char* path,
                                 GHashTable*,
                                 gpointer user_data) {
    static_cast<LocalServer*>(user_data)->handle_api_proxy(msg, path ? path : "/api");
}

void LocalServer::handle_static(SoupServerMessage* msg, const char* path) {
    const char* method = soup_server_message_get_method(msg);
    const bool is_get = (method && std::strcmp(method, SOUP_METHOD_GET) == 0);
    const bool is_head = (method && std::strcmp(method, SOUP_METHOD_HEAD) == 0);
    if (!is_get && !is_head) {
        soup_server_message_set_status(msg, SOUP_STATUS_METHOD_NOT_ALLOWED, nullptr);
        return;
    }

    std::filesystem::path file_path;
    if (!resolve_safe_file(path, &file_path)) {
        soup_server_message_set_status(msg, SOUP_STATUS_NOT_FOUND, nullptr);
        static constexpr char kNotFound[] = "Not Found";
        soup_server_message_set_response(msg, "text/plain; charset=utf-8",
                                         SOUP_MEMORY_STATIC, kNotFound, sizeof(kNotFound) - 1);
        return;
    }

    std::error_code ec;
    const auto raw_size = std::filesystem::file_size(file_path, ec);
    if (ec) {
        soup_server_message_set_status(msg, SOUP_STATUS_INTERNAL_SERVER_ERROR, nullptr);
        return;
    }

    const auto total_size = static_cast<goffset>(raw_size);
    const char* mime = mime_type_for_path(file_path);
    SoupMessageHeaders* req_headers = soup_server_message_get_request_headers(msg);
    SoupMessageHeaders* resp_headers = soup_server_message_get_response_headers(msg);

    soup_message_headers_replace(resp_headers, "Accept-Ranges", "bytes");
    soup_message_headers_replace(resp_headers, "Cache-Control", "no-cache");

    goffset start = 0;
    goffset end = total_size > 0 ? (total_size - 1) : 0;
    bool partial = false;

    if (total_size > 0 && soup_message_headers_get_one(req_headers, "Range") != nullptr) {
        SoupRange* ranges = nullptr;
        int range_count = 0;
        if (soup_message_headers_get_ranges(req_headers, total_size, &ranges, &range_count)) {
            if (range_count >= 1) {
                start = ranges[0].start;
                end = ranges[0].end;
                partial = true;
            }
            soup_message_headers_free_ranges(req_headers, ranges);
        } else {
            soup_message_headers_set_content_range(resp_headers, -1, -1, total_size);
            soup_server_message_set_status(msg, SOUP_STATUS_REQUESTED_RANGE_NOT_SATISFIABLE,
                                           nullptr);
            return;
        }
    }

    const goffset slice_len = (total_size == 0) ? 0 : (end - start + 1);
    soup_message_headers_set_content_type(resp_headers, mime, nullptr);
    soup_message_headers_set_content_length(resp_headers, slice_len);
    if (partial) {
        soup_message_headers_set_content_range(resp_headers, start, end, total_size);
    }

    if (is_head) {
        soup_server_message_set_status(msg, partial ? SOUP_STATUS_PARTIAL_CONTENT : SOUP_STATUS_OK,
                                       nullptr);
        return;
    }

    std::vector<char> buffer(static_cast<std::size_t>(slice_len));
    if (slice_len > 0) {
        std::ifstream in(file_path, std::ios::binary);
        if (!in) {
            soup_server_message_set_status(msg, SOUP_STATUS_INTERNAL_SERVER_ERROR, nullptr);
            return;
        }
        in.seekg(static_cast<std::streamoff>(start), std::ios::beg);
        in.read(buffer.data(), static_cast<std::streamsize>(slice_len));
        const auto got = in.gcount();
        if (got < 0) {
            soup_server_message_set_status(msg, SOUP_STATUS_INTERNAL_SERVER_ERROR, nullptr);
            return;
        }
        buffer.resize(static_cast<std::size_t>(got));
    }

    soup_server_message_set_status(msg, partial ? SOUP_STATUS_PARTIAL_CONTENT : SOUP_STATUS_OK,
                                   nullptr);
    soup_server_message_set_response(msg, mime, SOUP_MEMORY_COPY,
                                     buffer.empty() ? "" : buffer.data(), buffer.size());
}

void LocalServer::handle_api_proxy(SoupServerMessage* msg, const char* path) {
    if (!proxy_session_ || upstream_api_origin_.empty()) {
        static constexpr char kOfflineJson[] = "{\"error\":\"offline\"}";
        soup_server_message_set_status(msg, SOUP_STATUS_SERVICE_UNAVAILABLE, nullptr);
        soup_server_message_set_response(msg, "application/json; charset=utf-8",
                                         SOUP_MEMORY_STATIC, kOfflineJson,
                                         sizeof(kOfflineJson) - 1);
        return;
    }

    const char* method = soup_server_message_get_method(msg);
    GUri* req_uri = soup_server_message_get_uri(msg);
    const char* query = req_uri ? g_uri_get_query(req_uri) : nullptr;

    std::string target = upstream_api_origin_ + (path ? path : "/api");
    if (query && *query) {
        target += "?";
        target += query;
    }

    SoupMessage* up_msg = soup_message_new(method ? method : SOUP_METHOD_GET, target.c_str());
    if (!up_msg) {
        soup_server_message_set_status(msg, SOUP_STATUS_BAD_REQUEST, nullptr);
        return;
    }

    SoupMessageBody* req_body = soup_server_message_get_request_body(msg);
    if (req_body && req_body->length > 0 && req_body->data) {
        SoupMessageHeaders* req_headers = soup_server_message_get_request_headers(msg);
        const char* ct = soup_message_headers_get_content_type(req_headers, nullptr);
        GBytes* payload = g_bytes_new(req_body->data, static_cast<gsize>(req_body->length));
        soup_message_set_request_body_from_bytes(
            up_msg, ct ? ct : "application/json", payload);
        g_bytes_unref(payload);
    }

    auto* ctx = new ProxyContext{
        static_cast<SoupServerMessage*>(g_object_ref(msg)),
        up_msg,
    };
    soup_server_message_pause(msg);
    soup_session_send_and_read_async(proxy_session_, up_msg, G_PRIORITY_DEFAULT, nullptr,
                                     &on_proxy_finished, ctx);
}

}  // namespace openrash
