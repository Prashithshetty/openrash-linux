#!/usr/bin/env bash
set -euo pipefail

# build_packages.sh
# End-to-end release packaging script for OpenRash (Road Rash native Linux desktop edition)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
BUILD_DIR="${ROOT_DIR}/build"

mkdir -p "${DIST_DIR}"

echo "==> 1. Running Repository Integrity Audit..."
"${ROOT_DIR}/tools/verify_clean_repo.sh"

echo "==> 2. Building Native C++20 Release Binary & Running Test Suite..."
rm -rf "${BUILD_DIR}"
flatpak run --system --filesystem=host --command=sh org.freedesktop.Sdk//25.08 -c "
  cd '${ROOT_DIR}'
  cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
  cmake --build build -j\$(nproc)
  ctest --test-dir build --output-on-failure
"

echo "==> 3. Assembling Portable Linux Tarball..."
PORTABLE_DIR="${DIST_DIR}/openrash-linux-x86_64"
rm -rf "${PORTABLE_DIR}"
mkdir -p "${PORTABLE_DIR}/bin" "${PORTABLE_DIR}/share/openrash"

cp -f "${BUILD_DIR}/openrash" "${PORTABLE_DIR}/bin/openrash"
chmod +x "${PORTABLE_DIR}/bin/openrash"

cp -a "${ROOT_DIR}/www" "${PORTABLE_DIR}/share/openrash/www"

cp -f "${ROOT_DIR}/packaging/linux/io.github.prashithshetty.OpenRash.desktop" "${PORTABLE_DIR}/share/"
cp -f "${ROOT_DIR}/packaging/linux/io.github.prashithshetty.OpenRash.png" "${PORTABLE_DIR}/share/"
cp -f "${ROOT_DIR}/packaging/linux/io.github.prashithshetty.OpenRash.metainfo.xml" "${PORTABLE_DIR}/share/"
cp -f "${ROOT_DIR}/packaging/portable/install-local.sh" "${PORTABLE_DIR}/"
chmod +x "${PORTABLE_DIR}/install-local.sh"

cp -f "${ROOT_DIR}/README.md" "${PORTABLE_DIR}/"
cp -f "${ROOT_DIR}/CREDITS.md" "${PORTABLE_DIR}/"
cp -f "${ROOT_DIR}/NOTICE.md" "${PORTABLE_DIR}/"
cp -f "${ROOT_DIR}/LICENSE" "${PORTABLE_DIR}/"

TARBALL="${DIST_DIR}/openrash-linux-x86_64.tar.gz"
rm -f "${TARBALL}"
tar -C "${DIST_DIR}" -czf "${TARBALL}" "openrash-linux-x86_64"
rm -rf "${PORTABLE_DIR}"
echo "Created Portable Tarball: ${TARBALL} ($(du -h "${TARBALL}" | cut -f1))"

echo "==> 4. Building Offline Flatpak Bundle..."
FLATPAK_STATE_DIR="${ROOT_DIR}/.flatpak-builder"
FLATPAK_BUILD_DIR="${ROOT_DIR}/.flatpak-build"
FLATPAK_REPO="${DIST_DIR}/flatpak-repo"
rm -rf "${FLATPAK_BUILD_DIR}" "${FLATPAK_REPO}"

flatpak-builder \
  --force-clean \
  --disable-rofiles-fuse \
  --user \
  --state-dir="${FLATPAK_STATE_DIR}" \
  --repo="${FLATPAK_REPO}" \
  "${FLATPAK_BUILD_DIR}" \
  "${ROOT_DIR}/packaging/flatpak/io.github.prashithshetty.OpenRash.yml"

FLATPAK_BUNDLE="${DIST_DIR}/openrash-linux-x86_64.flatpak"
rm -f "${FLATPAK_BUNDLE}"
flatpak build-bundle "${FLATPAK_REPO}" "${FLATPAK_BUNDLE}" io.github.prashithshetty.OpenRash
rm -rf "${FLATPAK_BUILD_DIR}" "${FLATPAK_REPO}"
rm -rf "${FLATPAK_STATE_DIR}" 2>/dev/null || true

echo "Created Flatpak Bundle: ${FLATPAK_BUNDLE} ($(du -h "${FLATPAK_BUNDLE}" | cut -f1))"

echo ""
echo "=== BUILD COMPLETE! ==="
ls -lh "${TARBALL}" "${FLATPAK_BUNDLE}"
