/**
 * popup.js – Extension Popup UI Controller
 *
 * Manages Start/Stop, engine mode toggle (Analysis / Auto-Play), increment
 * input, and a real-time stats panel that polls chrome.storage for results
 * from the last engine search.
 */

document.addEventListener("DOMContentLoaded", () => {
    const btnStart        = document.getElementById("btn-start");
    const btnStop         = document.getElementById("btn-stop");
    const btnModeAnalysis = document.getElementById("btn-mode-analysis");
    const btnModeAutoplay = document.getElementById("btn-mode-autoplay");
    const eloSelect       = document.getElementById("elo-select");
    const cpuSelect       = document.getElementById("cpu-select");
    const hashSelect      = document.getElementById("hashSize");
    const incrementInput  = document.getElementById("increment");
    const statusBox       = document.getElementById("status-box");
    const statusText      = document.getElementById("status-text");
    const hwInfo          = document.getElementById("hw-info");

    // Stats panel elements
    const statScore = document.getElementById("stat-score");
    const statDepth = document.getElementById("stat-depth");
    const statNodes = document.getElementById("stat-nodes");
    const statTime  = document.getElementById("stat-time");

    /** @type {number|null} Interval ID for stats polling. */
    let statsInterval = null;

    const cores = navigator.hardwareConcurrency || 4;
    hwInfo.innerText = `Hardware Detected: ${cores} Logical Cores`;

    // -----------------------------------------------------------------------
    // Settings Restore
    // -----------------------------------------------------------------------

    chrome.storage.local.get(
        ["elo", "cpuMode", "hashSize", "increment", "engineMode", "isActive", "engineStats"],
        (result) => {
            if (result.elo)        eloSelect.value    = result.elo;
            if (result.cpuMode)    cpuSelect.value    = result.cpuMode;
            if (result.hashSize)   hashSelect.value   = result.hashSize;
            if (result.increment !== undefined) incrementInput.value = result.increment;

            setMode(result.engineMode || "analysis");

            if (result.isActive) {
                setUIActive(true);
                forceEvaluateActiveTab();
            }

            if (result.engineStats) renderStats(result.engineStats);
        }
    );

    // -----------------------------------------------------------------------
    // Mode Toggle
    // -----------------------------------------------------------------------

    /**
     * Sets the engine mode and updates button styles.
     * @param {"analysis"|"autoplay"} mode
     */
    function setMode(mode) {
        btnModeAnalysis.classList.toggle("active", mode === "analysis");
        btnModeAutoplay.classList.toggle("active", mode === "autoplay");
        chrome.storage.local.set({ engineMode: mode });
    }

    btnModeAnalysis.addEventListener("click", () => setMode("analysis"));
    btnModeAutoplay.addEventListener("click", () => setMode("autoplay"));

    // -----------------------------------------------------------------------
    // UI State
    // -----------------------------------------------------------------------

    /**
     * Updates the popup UI to reflect engine running or stopped state.
     * @param {boolean} isActive
     */
    function setUIActive(isActive) {
        if (isActive) {
            statusBox.className  = "status-box active";
            statusText.innerText = "Engine Running";
            btnStart.style.display = "none";
            btnStop.style.display  = "block";
            startStatsPolling();
        } else {
            statusBox.className  = "status-box inactive";
            statusText.innerText = "Standby";
            btnStart.style.display = "block";
            btnStop.style.display  = "none";
            stopStatsPolling();
        }
    }

    // -----------------------------------------------------------------------
    // Stats Panel
    // -----------------------------------------------------------------------

    /**
     * Formats a centipawn score as a human-readable string.
     * @param {number} cp
     * @returns {{ text: string, cls: string }}
     */
    function formatScore(cp) {
        if (cp === undefined || cp === null) return { text: "—", cls: "" };
        if (cp > 20000)  return { text: `♔ Mate in ${Math.ceil((30000 - cp) / 2)}`, cls: "mate" };
        if (cp < -20000) return { text: `♚ Mate in ${Math.ceil((30000 + cp) / 2)}`, cls: "mate" };
        const sign  = cp >= 0 ? "+" : "";
        const pawns = (cp / 100).toFixed(2);
        return { text: `${sign}${pawns}`, cls: cp >= 0 ? "positive" : "negative" };
    }

    /**
     * Formats a node count as a compact string (e.g., "1.23M").
     * @param {number} nodes
     * @returns {string}
     */
    function formatNodes(nodes) {
        if (!nodes) return "—";
        if (nodes >= 1_000_000) return `${(nodes / 1_000_000).toFixed(2)}M`;
        if (nodes >= 1_000)     return `${(nodes / 1_000).toFixed(1)}K`;
        return String(nodes);
    }

    /**
     * Renders engine stats into the stats panel.
     * @param {{ score?: number, depth?: number, nodes?: number, timeMs?: number }} stats
     */
    function renderStats(stats) {
        if (!stats) return;

        const { text, cls } = formatScore(stats.score);
        statScore.textContent = text;
        statScore.className = `stat-value ${cls}`;

        statDepth.textContent = stats.depth !== undefined ? `${stats.depth} ply` : "—";
        statNodes.textContent = formatNodes(stats.nodes);
        statTime.textContent  = stats.timeMs !== undefined ? `${stats.timeMs}ms` : "—";
    }

    /**
     * Starts polling chrome.storage every second for updated engine stats.
     */
    function startStatsPolling() {
        if (statsInterval) return;
        statsInterval = setInterval(() => {
            chrome.storage.local.get("engineStats", (result) => {
                if (result.engineStats) renderStats(result.engineStats);
            });
        }, 1000);
    }

    /**
     * Stops the stats polling interval.
     */
    function stopStatsPolling() {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Sends a FORCE_EVALUATE message to the currently active chess tab.
     */
    function forceEvaluateActiveTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "FORCE_EVALUATE" });
            }
        });
    }

    /**
     * Computes the number of worker threads based on CPU mode.
     * @param {string} cpuMode
     * @returns {number}
     */
    function resolveWorkerCount(cpuMode) {
        if (cpuMode === "balanced") return Math.max(1, Math.floor(cores / 2));
        if (cpuMode === "max")      return cores;
        return 1; // "eco"
    }

    // -----------------------------------------------------------------------
    // Start / Stop
    // -----------------------------------------------------------------------

    btnStart.addEventListener("click", () => {
        const elo       = parseInt(eloSelect.value, 10);
        const cpuMode   = cpuSelect.value;
        const hashSize  = parseInt(hashSelect.value, 10);
        const increment = parseInt(incrementInput.value, 10) || 0;
        const targetWorkers = resolveWorkerCount(cpuMode);

        chrome.storage.local.set({
            elo, cpuMode, hashSize, increment, isActive: true, targetWorkers,
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
