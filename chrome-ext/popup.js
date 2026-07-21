document.addEventListener('DOMContentLoaded', () => {
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const eloSelect = document.getElementById('elo-select');
    const cpuSelect = document.getElementById('cpu-select');
    const hashSelect = document.getElementById('hashSize');
    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    const hwInfo = document.getElementById('hw-info');

    // Hardware detection
    const cores = navigator.hardwareConcurrency || 4;
    hwInfo.innerText = `Hardware Detected: ${cores} Logical Cores`;

    // Load saved settings
    chrome.storage.local.get(['elo', 'cpuMode', 'hashSize', 'isActive'], (result) => {
        if (result.elo) eloSelect.value = result.elo;
        if (result.cpuMode) cpuSelect.value = result.cpuMode;
        if (result.hashSize) hashSelect.value = result.hashSize;
        if (result.isActive) {
            setUIActive(true); chrome.tabs.query({active: true, currentWindow: true}, function(tabs) { if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, {type: 'FORCE_EVALUATE'}); });
        }
    });

    function setUIActive(isActive) {
        if (isActive) {
            statusBox.className = 'status-box active';
            statusText.innerText = 'Engine Running';
            btnStart.style.display = 'none';
            btnStop.style.display = 'block';
        } else {
            statusBox.className = 'status-box inactive';
            statusText.innerText = 'Standby';
            btnStart.style.display = 'block';
            btnStop.style.display = 'none';
        }
    }

    btnStart.addEventListener('click', () => {
        const elo = parseInt(eloSelect.value, 10);
        const cpuMode = cpuSelect.value;
        const hashSize = parseInt(hashSelect.value, 10);
        
        let targetWorkers = 1;
        if (cpuMode === 'balanced') targetWorkers = Math.max(1, Math.floor(cores / 2));
        else if (cpuMode === 'max') targetWorkers = cores;

        chrome.storage.local.set({ elo: elo, cpuMode: cpuMode, hashSize: hashSize, isActive: true, targetWorkers: targetWorkers });
        
        chrome.runtime.sendMessage({ 
            type: 'START_ENGINE', 
            elo: elo,
            targetWorkers: targetWorkers,
            hashSize: hashSize
        });
        setUIActive(true); chrome.tabs.query({active: true, currentWindow: true}, function(tabs) { if(tabs[0]) chrome.tabs.sendMessage(tabs[0].id, {type: 'FORCE_EVALUATE'}); });
    });

    btnStop.addEventListener('click', () => {
        chrome.storage.local.set({ isActive: false });
        chrome.runtime.sendMessage({ type: 'STOP_ENGINE' });
        setUIActive(false);
    });
});


