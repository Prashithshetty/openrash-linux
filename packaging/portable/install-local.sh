#!/usr/bin/env bash
set -euo pipefail

# install-local.sh
# Installs OpenRash (Road Rash native Linux desktop edition) into ~/.local (no sudo required)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/openrash"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/512x512/apps"

mkdir -p "${BIN_DIR}" "${DATA_DIR}" "${APP_DIR}" "${ICON_DIR}"

echo "Installing OpenRash binary to ${BIN_DIR}/openrash..."
cp -f "${SCRIPT_DIR}/bin/openrash" "${BIN_DIR}/openrash"
chmod +x "${BIN_DIR}/openrash"

if [ -d "${SCRIPT_DIR}/share/openrash/www" ]; then
  echo "Installing complete offline Road Rash asset bundle to ${DATA_DIR}/www..."
  rm -rf "${DATA_DIR}/www"
  cp -a "${SCRIPT_DIR}/share/openrash/www" "${DATA_DIR}/www"
fi

if [ -f "${SCRIPT_DIR}/share/io.github.prashithshetty.OpenRash.png" ]; then
  cp -f "${SCRIPT_DIR}/share/io.github.prashithshetty.OpenRash.png" "${ICON_DIR}/io.github.prashithshetty.OpenRash.png"
fi

if [ -f "${SCRIPT_DIR}/share/io.github.prashithshetty.OpenRash.desktop" ]; then
  sed "s|^Exec=.*|Exec=${BIN_DIR}/openrash|" "${SCRIPT_DIR}/share/io.github.prashithshetty.OpenRash.desktop" > "${APP_DIR}/io.github.prashithshetty.OpenRash.desktop"
  chmod +x "${APP_DIR}/io.github.prashithshetty.OpenRash.desktop"
fi

echo "Road Rash (OpenRash) installed successfully! Launch via 'openrash' or from your desktop Application Menu."
