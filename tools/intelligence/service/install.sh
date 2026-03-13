#!/usr/bin/env bash
set -euo pipefail

# Install intel-collector as a managed service (launchd on macOS, systemd on Linux).
#
# Usage:
#   ./install.sh          # install and start
#   ./install.sh uninstall # stop and remove
#
# Prerequisites:
#   - `intel` binary on PATH (run `npm link` in tools/intelligence/ first)
#   - Config file at ~/.config/intel/config.yaml
#   - Database directory exists: ~/.local/share/intel/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTION="${1:-install}"

# --- Validation ---

check_prereqs() {
    local intel_bin
    intel_bin="$(command -v intel 2>/dev/null || true)"

    if [[ -z "$intel_bin" ]]; then
        echo "Error: 'intel' not found on PATH."
        echo "Run 'npm link' in tools/intelligence/ first, or set INTEL_BIN."
        exit 1
    fi
    echo "Found intel at: $intel_bin"

    if [[ ! -f "$HOME/.config/intel/config.yaml" ]]; then
        echo "Warning: ~/.config/intel/config.yaml not found."
        echo "Copy tools/intelligence/config/feeds.example.yaml and customize it."
    fi

    # Ensure data and runtime directories exist
    mkdir -p "$HOME/.local/share/intel"
    mkdir -p "$HOME/.local/run/intel"
}

# --- macOS (launchd) ---

install_launchd() {
    local intel_bin current_path plist_src plist_dest
    intel_bin="$(command -v intel)"
    current_path="$PATH"
    plist_src="$SCRIPT_DIR/launchd/com.intel.collector.plist"
    plist_dest="$HOME/Library/LaunchAgents/com.intel.collector.plist"

    mkdir -p "$HOME/Library/LaunchAgents"
    mkdir -p "$HOME/Library/Logs"

    # Resolve placeholders
    sed \
        -e "s|__INTEL_BIN__|${intel_bin}|g" \
        -e "s|__HOME__|${HOME}|g" \
        -e "s|__PATH__|${current_path}|g" \
        "$plist_src" > "$plist_dest"

    echo "Installed plist to $plist_dest"

    # Load the service
    launchctl bootout "gui/$(id -u)/com.intel.collector" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist_dest"

    echo "Service started. Check status with:"
    echo "  launchctl print gui/$(id -u)/com.intel.collector"
    echo "  tail -f ~/Library/Logs/intel-collector.log"
}

uninstall_launchd() {
    local plist_dest="$HOME/Library/LaunchAgents/com.intel.collector.plist"

    launchctl bootout "gui/$(id -u)/com.intel.collector" 2>/dev/null || true

    if [[ -f "$plist_dest" ]]; then
        rm "$plist_dest"
        echo "Removed $plist_dest"
    fi

    echo "Service stopped and uninstalled."
}

# --- Linux (systemd) ---

install_systemd() {
    local unit_src unit_dest
    unit_src="$SCRIPT_DIR/systemd/intel-collector.service"
    unit_dest="$HOME/.config/systemd/user/intel-collector.service"

    mkdir -p "$HOME/.config/systemd/user"

    # Check if intel is at the expected path; patch ExecStart if needed
    local intel_bin
    intel_bin="$(command -v intel)"
    local expected_bin="$HOME/.local/bin/intel"

    if [[ "$intel_bin" != "$expected_bin" ]]; then
        sed "s|%h/.local/bin/intel|${intel_bin}|g" "$unit_src" > "$unit_dest"
        echo "Note: intel found at $intel_bin (not ~/.local/bin/intel); patched unit file."
    else
        cp "$unit_src" "$unit_dest"
    fi

    echo "Installed unit to $unit_dest"

    systemctl --user daemon-reload
    systemctl --user enable intel-collector.service
    systemctl --user start intel-collector.service

    echo "Service started. Check status with:"
    echo "  systemctl --user status intel-collector"
    echo "  journalctl --user -u intel-collector -f"
}

uninstall_systemd() {
    systemctl --user stop intel-collector.service 2>/dev/null || true
    systemctl --user disable intel-collector.service 2>/dev/null || true

    local unit_dest="$HOME/.config/systemd/user/intel-collector.service"
    if [[ -f "$unit_dest" ]]; then
        rm "$unit_dest"
        systemctl --user daemon-reload
        echo "Removed $unit_dest"
    fi

    echo "Service stopped and uninstalled."
}

# --- Main ---

main() {
    local os
    os="$(uname -s)"

    case "$ACTION" in
        install)
            check_prereqs
            case "$os" in
                Darwin) install_launchd ;;
                Linux)  install_systemd ;;
                *)      echo "Unsupported OS: $os"; exit 1 ;;
            esac
            ;;
        uninstall)
            case "$os" in
                Darwin) uninstall_launchd ;;
                Linux)  uninstall_systemd ;;
                *)      echo "Unsupported OS: $os"; exit 1 ;;
            esac
            ;;
        *)
            echo "Usage: $0 [install|uninstall]"
            exit 1
            ;;
    esac
}

main
