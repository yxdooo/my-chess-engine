/**
 * popup.js – Extension Popup UI Controller
 *
 * Manages the Start/Stop Engine buttons, reads hardware info,
 * persists settings to chrome.storage.local, and notifies the
 * background service worker and active chess tab.
 */

document.addEventListener("DOMContentLoaded", () => {
    const btnStart  = document.getElementById("btn-start");
    const btnStop   = document.getElementById("btn-stop");
    const eloSelect = document.getElementById("elo-select");
    const cpuSelect = document.getElementById("cpu-select");
    const hashSelect = document.getElementById("hashSize");
    const statusBox = document.getElementById("status-box");
    const statusText = document.getElementById("status-text");
    const hwInfo    = document.getElementById("hw-info");

    // Display detected logical core count.
    const cores = navigator.hardwareConcurrency || 4;
    hwInfo.innerText = `Hardware Detected: ${cores} Logical Cores`;

    // Restore previously saved settings and engine state.
    chrome.storage.local.get(
        ["elo", "cpuMode", "hashSize", "isActive"],
        (result) => {
            if (result.elo) eloSelect.value = result.elo;
            if (result.cpuMode) cpuSelect.value = result.cpuMode;
            if (result.hashSize) hashSelect.value = result.hashSize;

            if (result.isActive) {
                setUIActive(true);
                forceEvaluateActiveTab();
            }
        }
    );

    // -----------------------------------------------------------------------
    // UI State
    // -----------------------------------------------------------------------

    /**
     * Updates the popup UI to reflect engine running or stopped state.
     * @param {boolean} isActive
     */
    function setUIActive(isActive) {
        if (isActive) {
            statusBox.className = "status-box active";
            statusText.innerText = "Engine Running";
            btnStart.style.display = "none";
            btnStop.style.display = "block";
        } else {
            statusBox.className = "status-box inactive";
            statusText.innerText = "Standby";
            btnStart.style.display = "block";
            btnStop.style.display = "none";
        }
    }

    /**
     * Sends a FORCE_EVALUATE message to the currently active chess tab
     * so the content script immediately runs position analysis.
     */
    function forceEvaluateActiveTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "FORCE_EVALUATE" });
            }
        });
    }

    /**
     * Computes the number of worker threads based on CPU mode selection.
     * @param {string} cpuMode - "eco" | "balanced" | "max"
     * @returns {number}
     */
    function resolveWorkerCount(cpuMode) {
        if (cpuMode === "balanced") return Math.max(1, Math.floor(cores / 2));
        if (cpuMode === "max") return cores;
        return 1; // "eco"
    }

    // -----------------------------------------------------------------------
    // Event Handlers
    // -----------------------------------------------------------------------

    btnStart.addEventListener("click", () => {
        const elo = parseInt(eloSelect.value, 10);
        const cpuMode = cpuSelect.value;
        const hashSize = parseInt(hashSelect.value, 10);
        const targetWorkers = resolveWorkerCount(cpuMode);

        chrome.storage.local.set({
            elo,
            cpuMode,
            hashSize,
            isActive: true,
            targetWorkers,
        });

        chrome.runtime.sendMessage({
            type: "START_ENGINE",
            elo,
            targetWorkers,
            hashSize,
        });

        setUIActive(true);
        forceEvaluateActiveTab();
    });

    btnStop.addEventListener("click", () => {
        chrome.storage.local.set({ isActive: false });
        chrome.runtime.sendMessage({ type: "STOP_ENGINE" });
        setUIActive(false);
    });
});
