#!/usr/bin/env bash
set -euo pipefail

# Install intel services as managed daemons (launchd on macOS, systemd on Linux).
# Services: collector (long-running), forecast-snapshot (weekly), forecast-evaluate (daily).
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

    # Warn if database is empty or missing — forecast services will no-op
    local db_path="$HOME/.local/share/intel/intel.db"
    if [[ ! -f "$db_path" ]]; then
        echo "Warning: Database not found at $db_path."
        echo "Forecast services will skip until the collector has run at least once."
    elif command -v "$intel_bin" &>/dev/null; then
        local event_count
        event_count=$("$intel_bin" stats 2>/dev/null | grep -oP 'events:\s*\K\d+' || echo "0")
        if [[ "$event_count" -eq 0 ]]; then
            echo "Warning: Database exists but contains 0 events."
            echo "Forecast services will skip until the collector has ingested data."
        fi
    fi
}

# --- macOS (launchd) ---

install_launchd() {
    local intel_bin current_path
    intel_bin="$(command -v intel)"
    current_path="$PATH"

    mkdir -p "$HOME/Library/LaunchAgents"
    mkdir -p "$HOME/Library/Logs"

    local plists=(
        com.intel.collector
        com.intel.forecast-snapshot
        com.intel.forecast-evaluate
    )

    for label in "${plists[@]}"; do
        local plist_src="$SCRIPT_DIR/launchd/${label}.plist"
        local plist_dest="$HOME/Library/LaunchAgents/${label}.plist"

        # Resolve placeholders
        sed \
            -e "s|__INTEL_BIN__|${intel_bin}|g" \
            -e "s|__HOME__|${HOME}|g" \
            -e "s|__PATH__|${current_path}|g" \
            "$plist_src" > "$plist_dest"

        echo "Installed plist to $plist_dest"

        # Load the service
        launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$plist_dest"
    done

    echo "Services started. Check status with:"
    echo "  launchctl print gui/$(id -u)/com.intel.collector"
    echo "  launchctl print gui/$(id -u)/com.intel.forecast-snapshot"
    echo "  launchctl print gui/$(id -u)/com.intel.forecast-evaluate"
    echo "  tail -f ~/Library/Logs/intel-collector.log"
    echo "  tail -f ~/Library/Logs/intel-forecast.log"
}

uninstall_launchd() {
    local plists=(
        com.intel.collector
        com.intel.forecast-snapshot
        com.intel.forecast-evaluate
    )

    for label in "${plists[@]}"; do
        launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true

        local plist_dest="$HOME/Library/LaunchAgents/${label}.plist"
        if [[ -f "$plist_dest" ]]; then
            rm "$plist_dest"
            echo "Removed $plist_dest"
        fi
    done

    echo "Services stopped and uninstalled."
}

# --- Linux (systemd) ---

install_systemd() {
    mkdir -p "$HOME/.config/systemd/user"

    local intel_bin
    intel_bin="$(command -v intel)"
    local expected_bin="$HOME/.local/bin/intel"

    # Install collector service
    local unit_src="$SCRIPT_DIR/systemd/intel-collector.service"
    local unit_dest="$HOME/.config/systemd/user/intel-collector.service"

    if [[ "$intel_bin" != "$expected_bin" ]]; then
        sed "s|%h/.local/bin/intel|${intel_bin}|g" "$unit_src" > "$unit_dest"
        echo "Note: intel found at $intel_bin (not ~/.local/bin/intel); patched unit file."
    else
        cp "$unit_src" "$unit_dest"
    fi
    echo "Installed unit to $unit_dest"

    # Install forecast timer/service pairs
    local forecast_units=(
        intel-forecast-snapshot
        intel-forecast-evaluate
    )

    for unit in "${forecast_units[@]}"; do
        for ext in service timer; do
            local src="$SCRIPT_DIR/systemd/${unit}.${ext}"
            local dest="$HOME/.config/systemd/user/${unit}.${ext}"

            if [[ "$ext" == "service" && "$intel_bin" != "$expected_bin" ]]; then
                sed "s|%h/.local/bin/intel|${intel_bin}|g" "$src" > "$dest"
            else
                cp "$src" "$dest"
            fi
            echo "Installed unit to $dest"
        done
    done

    systemctl --user daemon-reload

    # Enable and start collector
    systemctl --user enable intel-collector.service
    systemctl --user start intel-collector.service

    # Enable and start forecast timers
    for unit in "${forecast_units[@]}"; do
        systemctl --user enable "${unit}.timer"
        systemctl --user start "${unit}.timer"
    done

    echo "Services started. Check status with:"
    echo "  systemctl --user status intel-collector"
    echo "  systemctl --user list-timers 'intel-forecast-*'"
    echo "  journalctl --user -u intel-collector -f"
}

uninstall_systemd() {
    # Stop and disable collector
    systemctl --user stop intel-collector.service 2>/dev/null || true
    systemctl --user disable intel-collector.service 2>/dev/null || true

    # Stop and disable forecast timers
    local forecast_units=(
        intel-forecast-snapshot
        intel-forecast-evaluate
    )

    for unit in "${forecast_units[@]}"; do
        systemctl --user stop "${unit}.timer" 2>/dev/null || true
        systemctl --user disable "${unit}.timer" 2>/dev/null || true
    done

    # Remove unit files
    local removed=false
    local all_units=(
        intel-collector.service
        intel-forecast-snapshot.service
        intel-forecast-snapshot.timer
        intel-forecast-evaluate.service
        intel-forecast-evaluate.timer
    )

    for unit_file in "${all_units[@]}"; do
        local unit_dest="$HOME/.config/systemd/user/${unit_file}"
        if [[ -f "$unit_dest" ]]; then
            rm "$unit_dest"
            echo "Removed $unit_dest"
            removed=true
        fi
    done

    if [[ "$removed" == true ]]; then
        systemctl --user daemon-reload
    fi

    echo "Services stopped and uninstalled."
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
