#include "desktop_shell.hpp"

#include <dlfcn.h>
#include <gio/gio.h>
#include <glib-object.h>
#include <glib.h>

#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>

namespace openrash {

namespace {

struct GdkRGBA4 {
    float red;
    float green;
    float blue;
    float alpha;
};

struct NativeApis {
    void* gtk_lib = nullptr;
    void* webkit_lib = nullptr;

    // GTK4 C ABI
    gboolean (*gtk_init_check)() = nullptr;
    GApplication* (*gtk_application_new)(const char*, int) = nullptr;
    void* (*gtk_application_window_new)(GApplication*) = nullptr;
    void (*gtk_window_set_title)(void*, const char*) = nullptr;
    void (*gtk_window_set_default_size)(void*, int, int) = nullptr;
    void (*gtk_window_set_child)(void*, void*) = nullptr;
    void (*gtk_window_present)(void*) = nullptr;
    void (*gtk_window_close)(void*) = nullptr;
    void (*gtk_window_fullscreen)(void*) = nullptr;
    void (*gtk_window_unfullscreen)(void*) = nullptr;
    gboolean (*gtk_window_is_fullscreen)(void*) = nullptr;
    void (*gtk_window_set_icon_name)(void*, const char*) = nullptr;
    void (*gtk_widget_set_size_request)(void*, int, int) = nullptr;
    void (*gtk_widget_add_controller)(void*, void*) = nullptr;
    void (*gtk_widget_grab_focus)(void*) = nullptr;
    void* (*gtk_event_controller_key_new)() = nullptr;
    void (*gtk_event_controller_set_propagation_phase)(void*, int) = nullptr;
    void* (*gtk_css_provider_new)() = nullptr;
    void (*gtk_css_provider_load_from_string)(void*, const char*) = nullptr;
    void (*gtk_style_context_add_provider_for_display)(void*, void*, guint) = nullptr;
    void* (*gdk_display_get_default)() = nullptr;

    // WebKitGTK-6.0 C ABI
    void* (*webkit_network_session_new)(const char*, const char*) = nullptr;
    void* (*webkit_settings_new)() = nullptr;
    void (*webkit_settings_set_enable_webgl)(void*, gboolean) = nullptr;
    void (*webkit_settings_set_enable_webaudio)(void*, gboolean) = nullptr;
    void (*webkit_settings_set_media_playback_requires_user_gesture)(void*, gboolean) = nullptr;
    void (*webkit_settings_set_enable_developer_extras)(void*, gboolean) = nullptr;
    void (*webkit_settings_set_enable_page_cache)(void*, gboolean) = nullptr;
    void (*webkit_settings_set_hardware_acceleration_policy)(void*, int) = nullptr;
    void* (*webkit_user_content_manager_new)() = nullptr;
    void (*webkit_user_content_manager_add_script)(void*, void*) = nullptr;
    gboolean (*webkit_user_content_manager_register_script_message_handler)(void*,
                                                                            const char*,
                                                                            const char*) = nullptr;
    void* (*webkit_user_script_new)(const char*,
                                    int,
                                    int,
                                    const char* const*,
                                    const char* const*) = nullptr;
    void (*webkit_user_script_unref)(void*) = nullptr;
    GType (*webkit_web_view_get_type)() = nullptr;
    void (*webkit_web_view_set_background_color)(void*, const GdkRGBA4*) = nullptr;
    void (*webkit_web_view_load_uri)(void*, const char*) = nullptr;
    void (*webkit_policy_decision_ignore)(void*) = nullptr;
    void (*webkit_policy_decision_use)(void*) = nullptr;
    void* (*webkit_navigation_policy_decision_get_navigation_action)(void*) = nullptr;
    void* (*webkit_navigation_action_get_request)(void*) = nullptr;
    const char* (*webkit_uri_request_get_uri)(void*) = nullptr;
    char* (*jsc_value_to_string)(void*) = nullptr;

    ~NativeApis() {
        // Keep shared libraries mapped until process exit so GType destructors remain valid.
    }
};

template <typename FnPtr>
void load_sym(void* handle, const char* name, FnPtr& out) {
    void* sym = ::dlsym(handle, name);
    if (!sym) {
        throw std::runtime_error(std::string("Missing required native symbol: ") + name);
    }
    out = reinterpret_cast<FnPtr>(sym);
}

NativeApis load_native_apis() {
    NativeApis api;
    api.gtk_lib = ::dlopen("libgtk-4.so.1", RTLD_LAZY | RTLD_GLOBAL);
    if (!api.gtk_lib) {
        const char* err = ::dlerror();
        throw std::runtime_error(
            std::string("Failed to load GTK4 runtime (libgtk-4.so.1): ") +
            (err ? err : "not found"));
    }

    api.webkit_lib = ::dlopen("libwebkitgtk-6.0.so.4", RTLD_LAZY | RTLD_GLOBAL);
    if (!api.webkit_lib) {
        const char* err = ::dlerror();
        throw std::runtime_error(
            std::string("Failed to load WebKitGTK 6.0 runtime (libwebkitgtk-6.0.so.4): ") +
            (err ? err : "not found"));
    }

    load_sym(api.gtk_lib, "gtk_init_check", api.gtk_init_check);
    load_sym(api.gtk_lib, "gtk_application_new", api.gtk_application_new);
    load_sym(api.gtk_lib, "gtk_application_window_new", api.gtk_application_window_new);
    load_sym(api.gtk_lib, "gtk_window_set_title", api.gtk_window_set_title);
    load_sym(api.gtk_lib, "gtk_window_set_default_size", api.gtk_window_set_default_size);
    load_sym(api.gtk_lib, "gtk_window_set_child", api.gtk_window_set_child);
    load_sym(api.gtk_lib, "gtk_window_present", api.gtk_window_present);
    load_sym(api.gtk_lib, "gtk_window_close", api.gtk_window_close);
    load_sym(api.gtk_lib, "gtk_window_fullscreen", api.gtk_window_fullscreen);
    load_sym(api.gtk_lib, "gtk_window_unfullscreen", api.gtk_window_unfullscreen);
    load_sym(api.gtk_lib, "gtk_window_is_fullscreen", api.gtk_window_is_fullscreen);
    load_sym(api.gtk_lib, "gtk_window_set_icon_name", api.gtk_window_set_icon_name);
    load_sym(api.gtk_lib, "gtk_widget_set_size_request", api.gtk_widget_set_size_request);
    load_sym(api.gtk_lib, "gtk_widget_add_controller", api.gtk_widget_add_controller);
    load_sym(api.gtk_lib, "gtk_widget_grab_focus", api.gtk_widget_grab_focus);
    load_sym(api.gtk_lib, "gtk_event_controller_key_new", api.gtk_event_controller_key_new);
    load_sym(api.gtk_lib, "gtk_event_controller_set_propagation_phase",
             api.gtk_event_controller_set_propagation_phase);
    load_sym(api.gtk_lib, "gtk_css_provider_new", api.gtk_css_provider_new);
    load_sym(api.gtk_lib, "gtk_css_provider_load_from_string",
             api.gtk_css_provider_load_from_string);
    load_sym(api.gtk_lib, "gtk_style_context_add_provider_for_display",
             api.gtk_style_context_add_provider_for_display);
    load_sym(api.gtk_lib, "gdk_display_get_default", api.gdk_display_get_default);

    load_sym(api.webkit_lib, "webkit_network_session_new", api.webkit_network_session_new);
    load_sym(api.webkit_lib, "webkit_settings_new", api.webkit_settings_new);
    load_sym(api.webkit_lib, "webkit_settings_set_enable_webgl",
             api.webkit_settings_set_enable_webgl);
    load_sym(api.webkit_lib, "webkit_settings_set_enable_webaudio",
             api.webkit_settings_set_enable_webaudio);
    load_sym(api.webkit_lib, "webkit_settings_set_media_playback_requires_user_gesture",
             api.webkit_settings_set_media_playback_requires_user_gesture);
    load_sym(api.webkit_lib, "webkit_settings_set_enable_developer_extras",
             api.webkit_settings_set_enable_developer_extras);
    load_sym(api.webkit_lib, "webkit_settings_set_enable_page_cache",
             api.webkit_settings_set_enable_page_cache);
    load_sym(api.webkit_lib, "webkit_settings_set_hardware_acceleration_policy",
             api.webkit_settings_set_hardware_acceleration_policy);
    load_sym(api.webkit_lib, "webkit_user_content_manager_new",
             api.webkit_user_content_manager_new);
    load_sym(api.webkit_lib, "webkit_user_content_manager_add_script",
             api.webkit_user_content_manager_add_script);
    load_sym(api.webkit_lib, "webkit_user_content_manager_register_script_message_handler",
             api.webkit_user_content_manager_register_script_message_handler);
    load_sym(api.webkit_lib, "webkit_user_script_new", api.webkit_user_script_new);
    load_sym(api.webkit_lib, "webkit_user_script_unref", api.webkit_user_script_unref);
    load_sym(api.webkit_lib, "webkit_web_view_get_type", api.webkit_web_view_get_type);
    load_sym(api.webkit_lib, "webkit_web_view_set_background_color",
             api.webkit_web_view_set_background_color);
    load_sym(api.webkit_lib, "webkit_web_view_load_uri", api.webkit_web_view_load_uri);
    load_sym(api.webkit_lib, "webkit_policy_decision_ignore", api.webkit_policy_decision_ignore);
    load_sym(api.webkit_lib, "webkit_policy_decision_use", api.webkit_policy_decision_use);
    load_sym(api.webkit_lib, "webkit_navigation_policy_decision_get_navigation_action",
             api.webkit_navigation_policy_decision_get_navigation_action);
    load_sym(api.webkit_lib, "webkit_navigation_action_get_request",
             api.webkit_navigation_action_get_request);
    load_sym(api.webkit_lib, "webkit_uri_request_get_uri", api.webkit_uri_request_get_uri);
    load_sym(api.webkit_lib, "jsc_value_to_string", api.jsc_value_to_string);

    return api;
}

struct ShellState {
    NativeApis api;
    ShellOptions opts;
    GApplication* app = nullptr;
    void* window = nullptr;
    void* web_view = nullptr;
    guint smoke_timeout_id = 0;
    bool smoke_passed = false;

    void toggle_fullscreen() {
        if (!window) return;
        if (api.gtk_window_is_fullscreen(window)) {
            api.gtk_window_unfullscreen(window);
        } else {
            api.gtk_window_fullscreen(window);
        }
    }
};

gboolean on_key_pressed(void*,
                        guint keyval,
                        guint /*keycode*/,
                        guint state,
                        gpointer user_data) {
    auto* st = static_cast<ShellState*>(user_data);
    constexpr guint kGdkKeyF11 = 0xffc8;
    constexpr guint kGdkKeyReturn = 0xff0d;
    constexpr guint kGdkKeyKpEnter = 0xff8d;
    constexpr guint kGdkAltMask = 0x8;

    const bool is_f11 = (keyval == kGdkKeyF11);
    const bool is_alt_enter =
        ((state & kGdkAltMask) != 0) && (keyval == kGdkKeyReturn || keyval == kGdkKeyKpEnter);
    if (is_f11 || is_alt_enter) {
        st->toggle_fullscreen();
        return TRUE;
    }
    return FALSE;
}

void on_script_message(void*, void* jsc_value, gpointer user_data) {
    auto* st = static_cast<ShellState*>(user_data);
    if (!jsc_value) return;

    char* raw = st->api.jsc_value_to_string(jsc_value);
    if (!raw) return;
    std::string msg(raw);
    g_free(raw);

    if (msg == "toggleFullscreen") {
        st->toggle_fullscreen();
    } else if (msg == "quit") {
        if (st->window) {
            st->api.gtk_window_close(st->window);
        }
        if (st->app) {
            g_application_quit(st->app);
        }
    } else if (msg.rfind("smokeReady:", 0) == 0) {
        st->smoke_passed = true;
        std::cout << "[SMOKE] Native GTK4/WebKitGTK shell verified Road Rash boot ("
                  << msg.substr(11) << ")\n";
        if (st->smoke_timeout_id) {
            g_source_remove(st->smoke_timeout_id);
            st->smoke_timeout_id = 0;
        }
        if (st->window) {
            st->api.gtk_window_close(st->window);
        }
        if (st->app) {
            g_application_quit(st->app);
        }
    } else if (msg.rfind("smokeError:", 0) == 0) {
        std::cerr << "[SMOKE] Frontend boot error: " << msg.substr(11) << "\n";
        if (st->app) {
            g_application_quit(st->app);
        }
    }
}

gboolean on_decide_policy(void*, void* decision, int decision_type, gpointer user_data) {
    auto* st = static_cast<ShellState*>(user_data);
    constexpr int kDecisionNavigation = 0;
    constexpr int kDecisionNewWindow = 1;

    if (decision_type != kDecisionNavigation && decision_type != kDecisionNewWindow) {
        return FALSE;
    }

    void* nav_action = st->api.webkit_navigation_policy_decision_get_navigation_action(decision);
    void* req = nav_action ? st->api.webkit_navigation_action_get_request(nav_action) : nullptr;
    const char* uri_c = req ? st->api.webkit_uri_request_get_uri(req) : nullptr;
    if (!uri_c || !*uri_c) {
        return FALSE;
    }

    const std::string uri(uri_c);
    const bool is_local =
        (uri.rfind(st->opts.app_url, 0) == 0) || (uri.rfind("blob:", 0) == 0) ||
        (uri.rfind("data:", 0) == 0) || (uri == "about:blank");

    if (decision_type == kDecisionNewWindow || !is_local) {
        if (uri.rfind("http://", 0) == 0 || uri.rfind("https://", 0) == 0) {
            g_app_info_launch_default_for_uri(uri.c_str(), nullptr, nullptr);
        }
        st->api.webkit_policy_decision_ignore(decision);
        return TRUE;
    }

    st->api.webkit_policy_decision_use(decision);
    return TRUE;
}

gboolean on_smoke_timeout(gpointer user_data) {
    auto* st = static_cast<ShellState*>(user_data);
    st->smoke_timeout_id = 0;
    std::cerr << "[SMOKE] Timed out waiting for Road Rash main menu to render.\n";
    if (st->app) {
        g_application_quit(st->app);
    }
    return G_SOURCE_REMOVE;
}

void on_activate(GApplication* app, gpointer user_data) {
    auto* st = static_cast<ShellState*>(user_data);

    if (void* display = st->api.gdk_display_get_default()) {
        void* css = st->api.gtk_css_provider_new();
        st->api.gtk_css_provider_load_from_string(
            css, "window, webview { background-color: #000000; }");
        constexpr guint kStyleProviderPriorityApplication = 600;
        st->api.gtk_style_context_add_provider_for_display(
            display, css, kStyleProviderPriorityApplication);
        g_object_unref(css);
    }

    st->window = st->api.gtk_application_window_new(app);
    st->api.gtk_window_set_title(st->window, "Road Rash");
    st->api.gtk_window_set_default_size(st->window, 1280, 800);
    st->api.gtk_window_set_icon_name(st->window, "io.github.prashithshetty.OpenRash");
    st->api.gtk_widget_set_size_request(st->window, 640, 480);

    void* key_ctrl = st->api.gtk_event_controller_key_new();
    constexpr int kGtkPhaseCapture = 1;
    st->api.gtk_event_controller_set_propagation_phase(key_ctrl, kGtkPhaseCapture);
    g_signal_connect(key_ctrl, "key-pressed", G_CALLBACK(on_key_pressed), st);
    st->api.gtk_widget_add_controller(st->window, key_ctrl);

    const auto web_data = (st->opts.user_data_dir / "webdata").string();
    const auto web_cache = (st->opts.user_cache_dir / "webcache").string();
    void* net_session =
        st->api.webkit_network_session_new(web_data.c_str(), web_cache.c_str());

    void* settings = st->api.webkit_settings_new();
    st->api.webkit_settings_set_enable_webgl(settings, TRUE);
    st->api.webkit_settings_set_enable_webaudio(settings, TRUE);
    st->api.webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
    st->api.webkit_settings_set_enable_page_cache(settings, FALSE);
    // In WebKitGTK 6.0, WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS == 0.
    st->api.webkit_settings_set_hardware_acceleration_policy(settings, 0);
    st->api.webkit_settings_set_enable_developer_extras(
        settings, std::getenv("OPENRASH_DEVTOOLS") != nullptr ? TRUE : FALSE);

    void* ucm = st->api.webkit_user_content_manager_new();
    st->api.webkit_user_content_manager_register_script_message_handler(ucm, "openrash", nullptr);
    g_signal_connect(ucm, "script-message-received::openrash", G_CALLBACK(on_script_message), st);

    std::string boot_js = "window.__OPENRASH_NATIVE__ = true;\n";
    if (st->opts.smoke_test) {
        boot_js += R"JS(
window.addEventListener("error", function (e) {
  window.webkit?.messageHandlers?.openrash?.postMessage("smokeError:" + (e.message || "error"));
});
window.addEventListener("unhandledrejection", function (e) {
  window.webkit?.messageHandlers?.openrash?.postMessage("smokeError:" + (e.reason || "rejection"));
});
(function pollReady() {
  const playBtn = document.querySelector("[data-play]");
  const careerBtn = document.querySelector("[data-career]");
  const garageBtn = document.querySelector("[data-garage]");
  if (playBtn && careerBtn && garageBtn) {
    let glOk = false;
    try {
      const c = document.createElement("canvas");
      glOk = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (_) {}
    const btns = document.querySelectorAll("button").length;
    window.webkit.messageHandlers.openrash.postMessage(
      "smokeReady:buttons=" + btns + ",webgl=" + glOk
    );
    return;
  }
  setTimeout(pollReady, 50);
})();
)JS";
    }

    // WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES = 0, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START = 0
    void* user_script =
        st->api.webkit_user_script_new(boot_js.c_str(), 0, 0, nullptr, nullptr);
    st->api.webkit_user_content_manager_add_script(ucm, user_script);
    st->api.webkit_user_script_unref(user_script);

    st->web_view = g_object_new(st->api.webkit_web_view_get_type(),
                                "network-session", net_session,
                                "settings", settings,
                                "user-content-manager", ucm,
                                nullptr);

    const GdkRGBA4 black{0.0f, 0.0f, 0.0f, 1.0f};
    st->api.webkit_web_view_set_background_color(st->web_view, &black);
    g_signal_connect(st->web_view, "decide-policy", G_CALLBACK(on_decide_policy), st);

    st->api.gtk_window_set_child(st->window, st->web_view);
    if (st->opts.start_fullscreen) {
        st->api.gtk_window_fullscreen(st->window);
    }

    st->api.webkit_web_view_load_uri(st->web_view, (st->opts.app_url + "/").c_str());
    st->api.gtk_window_present(st->window);
    st->api.gtk_widget_grab_focus(st->web_view);

    if (st->opts.smoke_test) {
        st->smoke_timeout_id = g_timeout_add(15000, on_smoke_timeout, st);
    }

    g_object_unref(net_session);
    g_object_unref(settings);
    g_object_unref(ucm);
}

}  // namespace

int run_desktop_shell(const ShellOptions& opts) {
    ShellState state;
    state.api = load_native_apis();
    state.opts = opts;

    if (!state.api.gtk_init_check()) {
        if (opts.smoke_test && !opts.require_gui) {
            std::cout << "[SMOKE] No active X11/Wayland display detected; skipping GUI stage.\n";
            return 0;
        }
        std::cerr << "Error: Unable to initialize GTK4 display connection (X11/Wayland).\n";
        return 1;
    }

    state.app = state.api.gtk_application_new("io.github.prashithshetty.OpenRash",
                                              G_APPLICATION_NON_UNIQUE);
    if (!state.app) {
        std::cerr << "Error: Failed to create GtkApplication.\n";
        return 1;
    }

    g_signal_connect(state.app, "activate", G_CALLBACK(on_activate), &state);
    const int status = g_application_run(state.app, 0, nullptr);
    g_object_unref(state.app);

    if (opts.smoke_test && !state.smoke_passed) {
        return 1;
    }
    return status;
}

}  // namespace openrash
