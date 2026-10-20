#include "app_paths.hpp"
#include "local_server.hpp"

#include <libsoup/soup.h>

#include <array>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

#define REQUIRE(cond, msg)                                                                    \
    do {                                                                                      \
        if (!(cond)) {                                                                        \
            std::ostringstream oss;                                                           \
            oss << "Test assertion failed at " << __FILE__ << ":" << __LINE__ << " -> " << msg; \
            throw std::runtime_error(oss.str());                                              \
        }                                                                                     \
    } while (0)

std::string read_text(const std::filesystem::path& p) {
    std::ifstream in(p, std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

struct HttpReply {
    guint status = 0;
    std::string content_type;
    std::string content_range;
    std::string body;
    bool done = false;
};

HttpReply sync_http_request(SoupSession* session,
                            const char* method,
                            const std::string& url,
                            const char* range_header = nullptr) {
    HttpReply out;
    SoupMessage* msg = soup_message_new(method, url.c_str());
    REQUIRE(msg != nullptr, "Failed to construct SoupMessage for " << url);

    if (range_header) {
        soup_message_headers_replace(soup_message_get_request_headers(msg), "Range", range_header);
    }

    soup_session_send_and_read_async(
        session, msg, G_PRIORITY_DEFAULT, nullptr,
        +[](GObject* src, GAsyncResult* res, gpointer data) {
            auto* r = static_cast<HttpReply*>(data);
            GError* err = nullptr;
            GBytes* bytes = soup_session_send_and_read_finish(SOUP_SESSION(src), res, &err);
            if (err) {
                g_error_free(err);
            }
            if (bytes) {
                gsize sz = 0;
                const auto* ptr = static_cast<const char*>(g_bytes_get_data(bytes, &sz));
                if (ptr && sz > 0) {
                    r->body.assign(ptr, sz);
                }
                g_bytes_unref(bytes);
            }
            r->done = true;
        },
        &out);

    while (!out.done) {
        g_main_context_iteration(nullptr, TRUE);
    }

    out.status = soup_message_get_status(msg);
    SoupMessageHeaders* hdrs = soup_message_get_response_headers(msg);
    if (const char* ct = soup_message_headers_get_content_type(hdrs, nullptr)) {
        out.content_type = ct;
    }
    if (const char* cr = soup_message_headers_get_one(hdrs, "Content-Range")) {
        out.content_range = cr;
    }

    g_object_unref(msg);
    return out;
}

void test_asset_bundle_completeness(const std::filesystem::path& www) {
    static constexpr std::array<const char*, 5> kCourses = {
        "city", "hiway", "medly", "napa", "canyn",
    };

    for (const char* c : kCourses) {
        REQUIRE(std::filesystem::exists(www / "data" / (std::string(c) + ".json")),
                "Missing course JSON: " << c);
        REQUIRE(std::filesystem::exists(www / "data" / (std::string(c) + "-sections.json")),
                "Missing sections JSON: " << c);
        REQUIRE(std::filesystem::exists(www / "data" / (std::string(c) + "-hazards.json")),
                "Missing hazards JSON: " << c);
        REQUIRE(std::filesystem::exists(www / "data" / "atlas" / (std::string(c) + "-0.png")),
                "Missing scenery atlas PNG: " << c);
    }

    for (const char* dash : {"bigmeter.png", "rat.png", "sport.png", "super.png"}) {
        REQUIRE(std::filesystem::exists(www / "assets" / "img" / "dash" / dash),
                "Missing cockpit/HUD dashboard: " << dash);
    }

    for (int i = 0; i < 15; ++i) {
        REQUIRE(std::filesystem::exists(www / "data" / ("rider" + std::to_string(i) + ".png")),
                "Missing rider sprite: " << i);
    }

    for (const char* vid : {"start1.mp4", "win1.mp4", "lose1.mp4", "wreck1.mp4", "busted1.mp4",
                            "jessie.mp4", "duel.mp4", "finalwin.mp4", "rat/banzai.mp4"}) {
        const auto p = www / "assets" / "video" / vid;
        REQUIRE(std::filesystem::exists(p) && std::filesystem::file_size(p) > 1024,
                "Missing or truncated cutscene/showroom video: " << vid);
    }

    // Verify web-only telemetry & redirects were stripped cleanly
    const std::string html = read_text(www / "index.html");
    REQUIRE(html.find("cloudflareinsights.com") == std::string::npos,
            "Cloudflare beacon must be stripped from index.html");
    REQUIRE(html.find("roadrash.kayode.me") == std::string::npos,
            "Legacy domain redirect shim must be stripped from index.html");

    const std::string analytics = read_text(www / "analytics.js");
    REQUIRE(analytics.find("posthog.com") == std::string::npos,
            "PostHog remote telemetry must be stripped from analytics.js");
}

void test_mime_and_path_traversal(const openrash::LocalServer& server) {
    REQUIRE(std::strcmp(openrash::LocalServer::mime_type_for_path("app.js"),
                        "text/javascript; charset=utf-8") == 0,
            "JS MIME mismatch");
    REQUIRE(std::strcmp(openrash::LocalServer::mime_type_for_path("cut.mp4"), "video/mp4") == 0,
            "MP4 MIME mismatch");
    REQUIRE(std::strcmp(openrash::LocalServer::mime_type_for_path("tune.ogg"), "audio/ogg") == 0,
            "OGG MIME mismatch");
    REQUIRE(std::strcmp(openrash::LocalServer::mime_type_for_path("car.webp"), "image/webp") == 0,
            "WebP MIME mismatch");

    std::filesystem::path resolved;
    REQUIRE(server.resolve_safe_file("/", &resolved), "Root '/' must resolve to index.html");
    REQUIRE(resolved.filename() == "index.html", "Root '/' did not map to index.html");
    REQUIRE(!server.resolve_safe_file("/../../etc/passwd", &resolved),
            "Path traversal /../../etc/passwd must be rejected");
    REQUIRE(!server.resolve_safe_file("/../CMakeLists.txt", &resolved),
            "Parent traversal /../CMakeLists.txt must be rejected");
}

void test_embedded_http_and_range_streaming(const std::filesystem::path& www) {
    // Pass empty upstream origin to simulate 100% offline mode
    openrash::LocalServer server(www, "");
    server.start();
    REQUIRE(server.port() > 0, "Server must bind a non-zero ephemeral loopback port");

    SoupSession* client = soup_session_new_with_options("proxy-resolver", nullptr, nullptr);
    const std::string base = server.base_url();

    // 1. Index HTML
    const auto r_index = sync_http_request(client, SOUP_METHOD_GET, base + "/");
    REQUIRE(r_index.status == 200, "Expected 200 OK for '/', got " << r_index.status);
    REQUIRE(r_index.body.find("<div id=\"app\"></div>") != std::string::npos,
            "Index response missing #app mount");

    // 2. Partial Content (RFC 7233 Range) for MP4 cutscene streaming
    const auto r_range =
        sync_http_request(client, SOUP_METHOD_GET, base + "/assets/video/start1.mp4", "bytes=0-63");
    REQUIRE(r_range.status == 206,
            "Expected 206 Partial Content for byte range, got " << r_range.status);
    REQUIRE(r_range.body.size() == 64,
            "Expected 64-byte slice, got " << r_range.body.size());
    REQUIRE(r_range.content_range.rfind("bytes 0-63/", 0) == 0,
            "Unexpected Content-Range header: " << r_range.content_range);

    // 3. Out-of-bounds Range -> 416
    const auto r_bad_range = sync_http_request(
        client, SOUP_METHOD_GET, base + "/assets/video/start1.mp4", "bytes=999999999-999999999");
    REQUIRE(r_bad_range.status == 416,
            "Expected 416 for invalid byte range, got " << r_bad_range.status);

    // 4. Offline /api fallback -> immediate 503 JSON
    const auto r_api = sync_http_request(client, SOUP_METHOD_POST, base + "/api/race");
    REQUIRE(r_api.status == 503, "Expected 503 offline fallback for /api/race, got " << r_api.status);
    REQUIRE(r_api.body.find("offline") != std::string::npos,
            "Expected offline JSON payload from /api/race");

    g_object_unref(client);
    server.stop();
}

}  // namespace

int main() {
    try {
        const auto www = openrash::resolve_www_root();
        std::cout << "[TEST 1/3] Verifying complete Road Rash asset bundle at " << www << " ...\n";
        test_asset_bundle_completeness(www);

        std::cout << "[TEST 2/3] Verifying MIME mappings and path traversal guards ...\n";
        openrash::LocalServer check_srv(www, "");
        test_mime_and_path_traversal(check_srv);

        std::cout << "[TEST 3/3] Verifying embedded localhost HTTP, Range streaming & offline API ...\n";
        test_embedded_http_and_range_streaming(www);

        std::cout << "ALL OPENRASH TESTS PASSED.\n";
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "TEST FAILURE: " << ex.what() << "\n";
        return 1;
    }
}
