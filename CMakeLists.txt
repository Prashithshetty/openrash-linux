cmake_minimum_required(VERSION 3.22)
project(openrash VERSION 2.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_compile_options(-Wall -Wextra -Werror)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED glib-2.0 gobject-2.0 gio-2.0)
pkg_check_modules(SOUP REQUIRED libsoup-3.0)

add_library(openrash_core STATIC
    src/app_paths.cpp
    src/local_server.cpp
    src/desktop_shell.cpp
)

target_include_directories(openrash_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${GLIB_INCLUDE_DIRS}
    ${SOUP_INCLUDE_DIRS}
)

target_link_libraries(openrash_core PUBLIC
    ${GLIB_LIBRARIES}
    ${SOUP_LIBRARIES}
    ${CMAKE_DL_LIBS}
    pthread
)

add_executable(openrash
    src/main.cpp
)
target_link_libraries(openrash PRIVATE openrash_core)

# Installation targets (Flatpak / system / portable)
install(TARGETS openrash DESTINATION bin)
install(FILES packaging/linux/io.github.prashithshetty.OpenRash.desktop DESTINATION share/applications)
install(FILES packaging/linux/io.github.prashithshetty.OpenRash.png DESTINATION share/icons/hicolor/512x512/apps)
install(FILES packaging/linux/io.github.prashithshetty.OpenRash.metainfo.xml DESTINATION share/metainfo)
if (EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/www")
    install(DIRECTORY www/ DESTINATION share/openrash/www)
endif()

# Automated Test Suite
enable_testing()
add_executable(test_openrash
    tests/test_main.cpp
)
target_link_libraries(test_openrash PRIVATE openrash_core)
add_test(NAME OpenRashTestSuite COMMAND test_openrash)
