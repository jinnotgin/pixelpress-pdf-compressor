document.addEventListener('DOMContentLoaded', function () {
    // --- DOM Element References ---
    const dropZone = document.getElementById('drop-zone');
    const dropZonePrompt = document.getElementById('drop-zone-prompt');
    const fileListContainer = document.getElementById('file-list');
    const fileInput = document.getElementById('pdf-file-input');
    const addFilesBtn = document.getElementById('add-files-btn');
    const contentTitle = document.getElementById('content-title');
    const globalErrorBanner = document.getElementById('global-error-banner');
    const globalErrorMessage = document.getElementById('global-error-message');

    const settingsPanel = document.getElementById('settings-panel');
    const settingsPanelHeader = document.querySelector('.settings-panel-header');
    const dpiInput = document.getElementById('dpi');
    const dpiNumberInput = document.getElementById('dpi-number-input'); // New
    const jpegQualityInput = document.getElementById('jpeg_quality');
    const jpegQualityNumberInput = document.getElementById('jpeg-quality-number-input'); // New
    const jpegQualityGroup = document.getElementById('jpeg-quality-group');
    const imageFormatRadios = document.querySelectorAll('input[name="image_format"]');

    const clearLogBtn = document.getElementById('clear-log-btn');
    const toastContainer = document.getElementById('toast-container');
    const resetSettingsBtn = document.getElementById('reset-settings-btn'); // ADDED

    // --- State Variables ---
    let fileItems = [];
    let isCurrentlyProcessingQueueItem = false;
    let currentPollIntervalId = null;
    let isServerReachable = true;
    let healthCheckIntervalId = null;
    const FRONTEND_HISTORY_LIFESPAN_HOURS = 71;

    // --- Initialization ---
    function initializeApp() {
        addFilesBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.body.addEventListener(eventName, preventDefaults, false);
            dropZone.addEventListener(eventName, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false));
        ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false));
        dropZone.addEventListener('drop', handleDrop, false);

        clearLogBtn.addEventListener('click', clearFinishedItems);
        fileListContainer.addEventListener('click', handleFileItemActions);
        resetSettingsBtn.addEventListener('click', resetSettingsToDefault); // ADDED

        settingsPanelHeader.addEventListener('click', () => {
            if (window.innerWidth <= 768) settingsPanel.classList.toggle('is-collapsed');
        });

        // Setup two-way data binding for range sliders and number inputs
        setupRangeInputSync(dpiInput, dpiNumberInput);
        setupRangeInputSync(jpegQualityInput, jpegQualityNumberInput);
        
        imageFormatRadios.forEach(radio => radio.addEventListener('change', toggleJpegQualityInput));
        toggleJpegQualityInput();

        loadState();
        pruneOldFinishedItems();
        if (window.innerWidth <= 768 && !settingsPanel.classList.contains('is-collapsed')) {
            settingsPanel.classList.add('is-collapsed');
        }
        renderFileList();
        
        processFileQueue();
    }
    
    // --- Server Health & Error Handling ---

    async function checkServerHealth() {
        try {
            const response = await fetch('/health', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Server responded with status ${response.status}`);
            
            if (!isServerReachable) {
                console.log("Server is reachable again. Restoring operations.");
                isServerReachable = true;
                if (healthCheckIntervalId) {
                    clearInterval(healthCheckIntervalId);
                    healthCheckIntervalId = null;
                }
                globalErrorBanner.style.display = 'none';
                addFilesBtn.disabled = false;
                processFileQueue();
            }
        } catch (error) {
            if (isServerReachable) {
                console.error("Server has become unreachable. Pausing operations.", error.message);
                isServerReachable = false;
                addFilesBtn.disabled = true;
                showGlobalError("Oops! Lost connection – we’ll resume once the connection is back.");

                if (currentPollIntervalId) {
                    clearInterval(currentPollIntervalId);
                    currentPollIntervalId = null;
                }
                isCurrentlyProcessingQueueItem = false;

                if (!healthCheckIntervalId) {
                    healthCheckIntervalId = setInterval(checkServerHealth, 5000);
                }
            }
        }
    }

    // MODIFIED: This function now handles specific HTTP status codes as "offline" events.
    async function handleFetchError(error, item) {
        // List of statuses to treat as a total connection loss (e.g., gateway down, service unavailable).
        const offlineStatusCodes = [404, 429, 431, 502, 503, 504, 505, 520, 521, 522, 523, 524, 525, 526, 530];

        const isOfflineEvent = 
            error.message.includes('Failed to fetch') ||
            error.message.includes('NetworkError') ||
            (error.status && offlineStatusCodes.includes(error.status));

        if (isOfflineEvent) {
            console.warn("Fetch failed or received an offline-like status, triggering server health check.", error);
            if (item && ['uploading', 'processing'].includes(item.status)) {
                // Reset the item so it can be picked up again upon reconnection.
                updateItemState(item, {
                    message: "Connection lost. Waiting to reconnect...",
                    reconnected: false 
                });
            }
            await checkServerHealth(); // This function will set the global offline state.
        } else {
            // Treat other errors (e.g., 400, 500) as a task-specific failure.
            if (item) {
                updateItemState(item, { status: 'failed', error: error.message, message: 'An unexpected error occurred' });
            }
            isCurrentlyProcessingQueueItem = false;
            processFileQueue();
        }
    }

    // --- Core File Handling and Processing ---

    function handleFiles(files) {
        if (!isServerReachable) {
            showToast("Cannot add files while server is unreachable.");
            return;
        }

        fileInput.value = '';
        if (!files || files.length === 0) return;

        const currentSettings = {
            dpi: dpiInput.value,
            pageRasterFormat: document.querySelector('input[name="image_format"]:checked').value,
            jpegQuality: (document.querySelector('input[name="image_format"]:checked').value === 'jpeg' ? jpegQualityInput.value : null),
            outputTargetFormat: document.querySelector('input[name="output_target_format"]:checked').value
        };

        const activeFileKeys = new Set(fileItems.filter(item => ['pending', 'processing', 'uploading'].includes(item.status)).map(item => item.originalFilename + item.settings.outputTargetFormat + item.settings.pageRasterFormat + item.settings.dpi));

        for (const file of files) {
            if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
                showToast(`Skipped: "${file.name}" is not a PDF.`);
                continue;
            }
            const uniqueFileKey = file.name + currentSettings.outputTargetFormat + currentSettings.pageRasterFormat + currentSettings.dpi;
            if (activeFileKeys.has(uniqueFileKey)) {
                console.log(`Skipping duplicate active file: ${file.name}`);
                continue;
            }

            const newItem = {
                id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                file: file,
                originalFilename: file.name,
                status: 'pending',
                progress: 0,
                message: 'Waiting in queue...',
                taskId: null,
                downloadUrl: null,
                userFacingOutputFilename: null,
                originalSizeBytes: file.size,
                processedSizeBytes: null,
                settings: { ...currentSettings },
                timestamp: Date.now(),
                error: null,
            };
            fileItems.unshift(newItem);
        }

        saveState();
        renderFileList();
        processFileQueue();
    }

    async function processFileQueue() {
        if (isCurrentlyProcessingQueueItem || !isServerReachable) return;

        const itemToReconnect = fileItems.find(item => item.status === 'processing' && item.taskId && !item.reconnected);
        if (itemToReconnect) {
            isCurrentlyProcessingQueueItem = true;
            itemToReconnect.reconnected = true;
            pollStatusForItem(itemToReconnect);
            return;
        }

        const currentItem = fileItems.find(item => item.status === 'pending');
        if (!currentItem) return;

        isCurrentlyProcessingQueueItem = true;

        const formData = new FormData();
        formData.append('pdf_file', currentItem.file);
        formData.append('dpi', currentItem.settings.dpi);
        formData.append('image_format', currentItem.settings.pageRasterFormat);
        if (currentItem.settings.pageRasterFormat === 'jpeg') formData.append('jpeg_quality', currentItem.settings.jpegQuality);
        formData.append('output_target_format', currentItem.settings.outputTargetFormat);

        updateItemState(currentItem, { status: 'uploading', message: 'Uploading file...', progress: 0 });
        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            currentItem.file = null;

            if (!response.ok) {
                // MODIFIED: Create a custom error with the status code to be handled by handleFetchError.
                const error = new Error();
                error.status = response.status;
                const errorData = await response.json().catch(() => ({}));
                error.message = errorData.error || `Upload failed with status ${response.status}`;
                throw error;
            }

            const data = await response.json();
            if (data.task_id) {
                updateItemState(currentItem, { taskId: data.task_id, status: 'processing', message: 'Processing...', progress: 15 });
                pollStatusForItem(currentItem);
            } else {
                throw new Error(data.error || 'Failed to start processing task.');
            }
        } catch (err) {
            await handleFetchError(err, currentItem);
        }
    }

    function pollStatusForItem(item) {
        if (currentPollIntervalId) clearInterval(currentPollIntervalId);

        currentPollIntervalId = setInterval(async () => {
            if (!isServerReachable) {
                console.log("Polling paused, server is unreachable.");
                return;
            }

            const currentItemInPoll = fileItems.find(fi => fi.id === item.id);
            if (!currentItemInPoll || !currentItemInPoll.taskId || ['completed', 'failed', 'cancelling'].includes(currentItemInPoll.status)) {
                clearInterval(currentPollIntervalId);
                isCurrentlyProcessingQueueItem = false;
                processFileQueue();
                return;
            }

            try {
                const response = await fetch(`/status/${currentItemInPoll.taskId}`, { cache: 'no-store' });
                if (!response.ok) {
                    // MODIFIED: Create a custom error with the status code to be handled by handleFetchError.
                    const error = new Error();
                    error.status = response.status;
                    const errorData = await response.json().catch(() => ({}));
                    error.message = errorData.message || errorData.error || `Server returned status ${response.status}`;
                    throw error;
                }

                const data = await response.json();
                const updates = {
                    message: data.message || currentItemInPoll.message,
                    progress: Math.round(data.progress || currentItemInPoll.progress),
                    status: data.status
                };

                if (data.status === 'completed' || data.status === 'failed') {
                    clearInterval(currentPollIntervalId);
                    isCurrentlyProcessingQueueItem = false;
                    if (data.status === 'completed') {
                        updates.downloadUrl = `/download/${currentItemInPoll.taskId}`;
                        updates.userFacingOutputFilename = data.output_filename;
                        updates.originalSizeBytes = data.original_size_bytes;
                        updates.processedSizeBytes = data.processed_size_bytes;
                    } else {
                        updates.error = data.message || 'Processing failed on server.';
                    }
                    processFileQueue();
                }
                updateItemState(currentItemInPoll, updates);
            } catch (err) {
                clearInterval(currentPollIntervalId);
                await handleFetchError(err, currentItemInPoll);
            }
        }, 2000);
    }

    // --- UI Rendering ---

    function renderFileList() {
        fileListContainer.innerHTML = '';
        if (fileItems.length === 0) {
            dropZonePrompt.classList.remove('hidden');
        } else {
            dropZonePrompt.classList.add('hidden');
            fileItems.forEach(item => {
                const itemEl = createFileItemElement(item);
                updateFileItemElement(itemEl, item);
                fileListContainer.appendChild(itemEl);
            });
        }
        updateAppUI();
    }

    function createFileItemElement(item) {
        const el = document.createElement('div');
        el.className = 'file-item';
        el.dataset.id = item.id;
        return el;
    }

    function updateFileItemElement(el, item) {
        if (item.status === 'completed') {
            el.classList.add('is-completed');
            let sizeInfo = '';
            if (item.originalSizeBytes != null && item.processedSizeBytes != null) {
                const savings = item.originalSizeBytes - item.processedSizeBytes;
                const savingsText = savings > 0 ? `<span class="size-reduction">(${((savings / item.originalSizeBytes) * 100).toFixed(0)}% smaller)</span>` : '';
                sizeInfo = `From ${formatBytes(item.originalSizeBytes)} → ${formatBytes(item.processedSizeBytes)} ${savingsText}`;
            }
            el.innerHTML = `
                <a href="${item.downloadUrl}" download="${item.userFacingOutputFilename}" class="button-download-primary">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                    <span>Download</span>
                </a>
                <div class="file-item-details">
                    <div>
                        <div class="file-name" title="${item.userFacingOutputFilename}">${item.userFacingOutputFilename}</div>
                        <div class="file-message">${sizeInfo}</div>
                    </div>
                </div>
                <div class="file-item-actions">
                    <div class="status-badge-container">COMPLETED</div>
                    <button class="button-icon remove-file-item-btn" title="Remove Item"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg></button>
                </div>`;
            return;
        }

        el.classList.remove('is-completed');
        el.innerHTML = `
            <div class="file-item-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M4,2H16L20,6V20A2,2 0 0,1 18,22H4A2,2 0 0,1 2,20V4A2,2 0 0,1 4,2M15,7H19.5L14,2.5V7A1,1 0 0,0 15,7Z" /></svg></div>
            <div class="file-item-details"><div class="file-name" title="${item.originalFilename}">${item.originalFilename}</div><div class="file-message"></div><div class="progress-bar"><div class="progress-bar-inner"></div></div></div>
            <div class="file-item-actions"></div>`;

        el.querySelector('.file-message').classList.remove('error');
        if (item.status === 'failed' && item.error) {
            el.querySelector('.file-message').textContent = `Error: ${item.error}`;
            el.querySelector('.file-message').classList.add('error');
        } else {
            el.querySelector('.file-message').textContent = item.message || '';
        }
        if (['uploading', 'processing'].includes(item.status)) {
            el.querySelector('.progress-bar').style.display = 'block';
            el.querySelector('.progress-bar-inner').style.width = `${item.progress}%`;
        } else {
            el.querySelector('.progress-bar').style.display = 'none';
        }
        let statusBadge = '';
        switch (item.status) {
            case 'pending': statusBadge = `<span class="status-badge pending">Pending</span>`; break;
            case 'uploading': case 'processing': statusBadge = `<span class="status-badge processing">${item.status}</span>`; break;
            case 'failed': statusBadge = `<span class="status-badge failed">Failed</span>`; break;
            case 'cancelling': statusBadge = `<span class="status-badge warning">Cancelling</span>`; break;
        }
        el.querySelector('.file-item-actions').innerHTML = statusBadge + `<button class="button-icon remove-file-item-btn" title="Remove Item"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg></button>`;
    }

    function updateAppUI() {
        const activeItem = fileItems.find(item => ['uploading', 'processing'].includes(item.status));
        if (activeItem) {
            const finishedCount = fileItems.filter(item => ['completed', 'failed'].includes(item.status)).length;
            contentTitle.textContent = `Processing file ${finishedCount + 1} of ${fileItems.length}`;
        } else if (fileItems.length > 0) {
            const pendingCount = fileItems.filter(item => item.status === 'pending').length;
            contentTitle.textContent = pendingCount > 0 ? `${pendingCount} item${pendingCount > 1 ? 's' : ''} in queue` : 'All tasks complete';
        } else {
            contentTitle.textContent = 'Ready for your PDFs';
        }
        clearLogBtn.disabled = !fileItems.some(item => ['completed', 'failed'].includes(item.status));
    }

    function updateItemState(item, updates) {
        Object.assign(item, updates, { timestamp: Date.now() });
        saveState();
        const itemEl = fileListContainer.querySelector(`.file-item[data-id="${item.id}"]`);
        if (itemEl) updateFileItemElement(itemEl, item);
        else renderFileList();
        updateAppUI();
    }

    // --- State Persistence & Helpers ---

    async function removeItemFromLog(itemId) {
        const itemIndex = fileItems.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return;
        const itemToRemove = fileItems[itemIndex];
        
        if (['uploading', 'processing'].includes(itemToRemove.status)) {
            if (!confirm("This will cancel the active process. Are you sure?")) return;
        }

        if (itemToRemove.taskId && isServerReachable) {
            try {
                updateItemState(itemToRemove, { status: 'cancelling', message: 'Requesting cancellation...' });
                await fetch(`/task/${itemToRemove.taskId}`, { method: 'DELETE', cache: 'no-store' });
            } catch (err) {
                showToast(`Could not remove task on server: ${err.message}`);
            }
        }
        if (itemToRemove.id === fileItems.find(i => ['uploading', 'processing', 'cancelling'].includes(i.status))?.id) {
            clearInterval(currentPollIntervalId);
            currentPollIntervalId = null;
            isCurrentlyProcessingQueueItem = false;
        }
        fileItems.splice(itemIndex, 1);
        saveState();
        renderFileList();
        if (!isCurrentlyProcessingQueueItem) processFileQueue();
    }

    async function clearFinishedItems() {
        const confirmMessage = "This will permanently delete all completed and failed files from the server and clear them from this list. Continue?";
        if (!confirm(confirmMessage)) return;
        const itemsToDelete = fileItems.filter(item => (item.status === 'completed' || item.status === 'failed') && item.taskId);
        if (itemsToDelete.length > 0 && isServerReachable) {
            const deletionPromises = itemsToDelete.map(item => fetch(`/task/${item.taskId}`, { method: 'DELETE', cache: 'no-store' }).catch(err => console.error(`Failed to delete task ${item.taskId} on server:`, err)));
            await Promise.allSettled(deletionPromises);
        }
        fileItems = fileItems.filter(item => item.status !== 'completed' && item.status !== 'failed');
        saveState();
        renderFileList();
    }

    function loadState() {
        const storedState = localStorage.getItem('pixelPressFileItems');
        if (storedState) {
            try {
                fileItems = JSON.parse(storedState);
                fileItems.forEach(item => {
                    if (['pending', 'uploading', 'processing', 'cancelling'].includes(item.status)) {
                        if (item.taskId) { item.status = 'processing'; item.message = "Reconnecting..."; item.reconnected = false; } 
                        else { item.status = 'failed'; item.message = "Process interrupted by page reload."; item.error = item.message; }
                    }
                });
                fileItems.sort((a, b) => b.timestamp - a.timestamp);
            } catch (e) { console.error("Error parsing stored state:", e); fileItems = []; }
        }
    }

    function saveState() {
        const storableItems = fileItems.map(item => { const { file, ...rest } = item; return rest; });
        localStorage.setItem('pixelPressFileItems', JSON.stringify(storableItems));
    }

    function pruneOldFinishedItems() {
        const now = Date.now();
        const maxAge = FRONTEND_HISTORY_LIFESPAN_HOURS * 60 * 60 * 1000;
        const prevLength = fileItems.length;
        fileItems = fileItems.filter(item => {
            if (['completed', 'failed'].includes(item.status)) return (now - (item.timestamp || 0)) < maxAge;
            return true;
        });
        if (fileItems.length < prevLength) saveState();
    }

    // --- UI & Event Helpers ---
    function setupRangeInputSync(rangeEl, numberEl) {
        const min = parseInt(rangeEl.min, 10);
        const max = parseInt(rangeEl.max, 10);
        // Update number input when slider moves
        rangeEl.addEventListener('input', () => {
            numberEl.value = rangeEl.value;
        });
        // Update slider when number input changes
        numberEl.addEventListener('input', () => {
            const value = parseInt(numberEl.value, 10);
            if (!isNaN(value) && value >= min && value <= max) {
                rangeEl.value = value;
            }
        });
        // Validate and clamp on leaving the input field
        numberEl.addEventListener('change', () => {
            let value = parseInt(numberEl.value, 10);
            if (isNaN(value) || value < min) {
                value = min;
            } else if (value > max) {
                value = max;
            }
            // Update both the number input (in case it was clamped) and the slider
            numberEl.value = value;
            rangeEl.value = value;
        });
    }

    // ADDED: Function to reset settings form to its default values
    function resetSettingsToDefault() {
        const defaults = {
            outputFormat: 'pdf',
            dpi: 72,
            imageFormat: 'jpeg',
            jpegQuality: 75
        };

        // Set output format radio
        document.getElementById('format-pdf-output').checked = true;

        // Set DPI
        dpiInput.value = defaults.dpi;
        dpiNumberInput.value = defaults.dpi;

        // Set image format radio
        document.getElementById('format-jpeg').checked = true;

        // Set JPEG Quality
        jpegQualityInput.value = defaults.jpegQuality;
        jpegQualityNumberInput.value = defaults.jpegQuality;
        
        // Ensure UI consistency for conditional fields
        toggleJpegQualityInput();

        // Give user feedback
        showToast("Settings have been reset to default.");
    }

    function showGlobalError(message) { globalErrorMessage.textContent = message; globalErrorBanner.style.display = 'flex'; }
    function handleDrop(e) { handleFiles(e.dataTransfer.files); }
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    function toggleJpegQualityInput() { jpegQualityGroup.style.display = (document.querySelector('input[name="image_format"]:checked').value === 'jpeg') ? 'block' : 'none'; }
    function handleFileItemActions(event) { const button = event.target.closest('.remove-file-item-btn'); if (button) { const itemEl = button.closest('.file-item'); if (itemEl && itemEl.dataset.id) removeItemFromLog(itemEl.dataset.id); } }
    function showToast(message) { const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message; toastContainer.appendChild(toast); setTimeout(() => toast.remove(), 5000); }
    function formatBytes(bytes, decimals = 1) { if (bytes == null || isNaN(bytes)) return 'N/A'; if (bytes === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i]; }

    initializeApp();
});