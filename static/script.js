document.addEventListener('DOMContentLoaded', function () {
    // --- DOM Element References ---
    const dropZone = document.getElementById('drop-zone');
    const dropZonePrompt = document.getElementById('drop-zone-prompt');
    const fileListContainer = document.getElementById('file-list');
    const fileInput = document.getElementById('pdf-file-input');
    const addFilesBtn = document.getElementById('add-files-btn');
    const contentTitle = document.getElementById('content-title');

    const settingsPanel = document.getElementById('settings-panel');
    const settingsPanelHeader = document.querySelector('.settings-panel-header');
    const dpiInput = document.getElementById('dpi');
    const dpiValueDisplay = document.getElementById('dpi-value');
    const jpegQualityInput = document.getElementById('jpeg_quality');
    const jpegQualityValueDisplay = document.getElementById('jpeg-quality-value');
    const jpegQualityGroup = document.getElementById('jpeg-quality-group');
    const imageFormatRadios = document.querySelectorAll('input[name="image_format"]');

    const clearLogBtn = document.getElementById('clear-log-btn');
    const toastContainer = document.getElementById('toast-container');

    // --- State Variables ---
    let fileItems = [];
    let isCurrentlyProcessingQueueItem = false;
    let currentPollIntervalId = null;
    const FRONTEND_HISTORY_LIFESPAN_HOURS = 71; // 1 hour less than server for safety

    // --- Initialization ---
    function initializeApp() {
        // Event Listeners for adding files
        addFilesBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        // Drag and Drop Listeners
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.body.addEventListener(eventName, preventDefaults, false);
            dropZone.addEventListener(eventName, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false));
        ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false));
        dropZone.addEventListener('drop', handleDrop, false);

        // Action Listeners
        clearLogBtn.addEventListener('click', clearFinishedItems);
        fileListContainer.addEventListener('click', handleFileItemActions);

        // Mobile Settings Collapse Listener
        settingsPanelHeader.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                settingsPanel.classList.toggle('is-collapsed');
            }
        });

        // Form Input UI Listeners
        dpiInput.addEventListener('input', () => dpiValueDisplay.textContent = `${dpiInput.value} DPI`);
        jpegQualityInput.addEventListener('input', () => jpegQualityValueDisplay.textContent = `${jpegQualityInput.value}%`);
        imageFormatRadios.forEach(radio => radio.addEventListener('change', toggleJpegQualityInput));
        toggleJpegQualityInput();

        // Load State and Start Processing
        loadState();
        pruneOldFinishedItems();
        if (window.innerWidth <= 768) settingsPanel.classList.remove('is-collapsed');
        else settingsPanel.classList.add('is-collapsed');
        renderFileList();
        processFileQueue();
    }

    // --- Core File Handling and Processing ---

    function handleFiles(files) {
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
        if (isCurrentlyProcessingQueueItem) return;

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
        updateItemState(currentItem, { status: 'uploading', message: 'Preparing to upload...', progress: 0 });

        const formData = new FormData();
        formData.append('pdf_file', currentItem.file);
        formData.append('dpi', currentItem.settings.dpi);
        formData.append('image_format', currentItem.settings.pageRasterFormat);
        if (currentItem.settings.pageRasterFormat === 'jpeg') formData.append('jpeg_quality', currentItem.settings.jpegQuality);
        formData.append('output_target_format', currentItem.settings.outputTargetFormat);

        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            currentItem.file = null;

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `Upload failed with status ${response.status}`);
            }

            const data = await response.json();
            if (data.task_id) {
                updateItemState(currentItem, { taskId: data.task_id, status: 'processing', message: 'Processing...', progress: 15 });
                pollStatusForItem(currentItem);
            } else {
                throw new Error(data.error || 'Failed to start processing task.');
            }
        } catch (err) {
            updateItemState(currentItem, { status: 'failed', error: err.message, message: 'Upload failed' });
            isCurrentlyProcessingQueueItem = false;
            processFileQueue();
        }
    }

    function pollStatusForItem(item) {
        if (currentPollIntervalId) clearInterval(currentPollIntervalId);

        currentPollIntervalId = setInterval(async () => {
            const currentItemInPoll = fileItems.find(fi => fi.id === item.id);
            if (!currentItemInPoll || !currentItemInPoll.taskId || ['completed', 'failed'].includes(currentItemInPoll.status)) {
                clearInterval(currentPollIntervalId);
                isCurrentlyProcessingQueueItem = false;
                processFileQueue();
                return;
            }

            try {
                const response = await fetch(`/status/${currentItemInPoll.taskId}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`Server returned status ${response.status}`);

                const data = await response.json();
                const updates = {
                    message: data.message || currentItemInPoll.message,
                    progress: Math.round(data.progress || currentItemInPoll.progress),
                    status: data.status
                };

                if (data.status === 'completed') {
                    clearInterval(currentPollIntervalId);
                    updates.downloadUrl = `/download/${currentItemInPoll.taskId}`;
                    updates.userFacingOutputFilename = data.output_filename;
                    updates.originalSizeBytes = data.original_size_bytes;
                    updates.processedSizeBytes = data.processed_size_bytes;
                    isCurrentlyProcessingQueueItem = false;
                    processFileQueue();
                } else if (data.status === 'failed') {
                    clearInterval(currentPollIntervalId);
                    updates.error = data.message || 'Processing failed on server.';
                    isCurrentlyProcessingQueueItem = false;
                    processFileQueue();
                }
                updateItemState(currentItemInPoll, updates);
            } catch (err) {
                console.error("Polling failed:", err.message);
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
            // MODIFIED: Removed truncateFilename, added title attribute for hover
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
            <div class="file-item-details"><div class="file-name"></div><div class="file-message"></div><div class="progress-bar"><div class="progress-bar-inner"></div></div></div>
            <div class="file-item-actions"></div>`;

        // MODIFIED: Removed truncateFilename, added title attribute for hover
        const fileNameEl = el.querySelector('.file-name');
        fileNameEl.textContent = item.originalFilename;
        fileNameEl.title = item.originalFilename;

        const messageEl = el.querySelector('.file-message');
        const actionsEl = el.querySelector('.file-item-actions');
        const progressEl = el.querySelector('.progress-bar');
        const progressInnerEl = el.querySelector('.progress-bar-inner');

        messageEl.classList.remove('error');
        if (item.status === 'failed' && item.error) {
            messageEl.textContent = `Error: ${item.error}`;
            messageEl.classList.add('error');
        } else {
            messageEl.textContent = item.message || '';
        }
        if (['uploading', 'processing'].includes(item.status)) {
            progressEl.style.display = 'block';
            progressInnerEl.style.width = `${item.progress}%`;
        } else {
            progressEl.style.display = 'none';
        }
        let statusBadge = '';
        switch (item.status) {
            case 'pending': statusBadge = `<span class="status-badge pending">Pending</span>`; break;
            case 'uploading': case 'processing': statusBadge = `<span class="status-badge processing">${item.status}</span>`; break;
            case 'failed': statusBadge = `<span class="status-badge failed">Failed</span>`; break;
        }
        actionsEl.innerHTML = statusBadge + `<button class="button-icon remove-file-item-btn" title="Remove Item"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg></button>`;
    }

    function updateAppUI() {
        const activeItem = fileItems.find(item => ['uploading', 'processing'].includes(item.status));

        // MODIFIED: Changed header logic to be more informative
        if (activeItem) {
            const finishedCount = fileItems.filter(item => ['completed', 'failed'].includes(item.status)).length;
            const totalCount = fileItems.length;
            contentTitle.textContent = `Processing file ${finishedCount + 1} of ${totalCount}`;
        } else if (fileItems.length > 0) {
            const pendingCount = fileItems.filter(item => item.status === 'pending').length;
            if (pendingCount > 0) {
                contentTitle.textContent = `${pendingCount} item${pendingCount > 1 ? 's' : ''} in queue`;
            } else {
                contentTitle.textContent = 'All tasks complete';
            }
        } else {
            contentTitle.textContent = 'Ready for your PDFs';
        }
        clearLogBtn.disabled = !fileItems.some(item => ['completed', 'failed'].includes(item.status));
    }

    function updateItemState(item, updates) {
        Object.assign(item, updates, { timestamp: Date.now() });
        saveState();
        renderFileList();
    }

    // --- State Persistence & Helpers ---

    async function removeItemFromLog(itemId) {
        const itemIndex = fileItems.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return;
        const itemToRemove = fileItems[itemIndex];
        if (itemToRemove.taskId && ['uploading', 'processing'].includes(itemToRemove.status)) {
            try { await fetch(`/task/${itemToRemove.taskId}`, { method: 'DELETE', cache: 'no-store' }); } catch (err) { showToast(`Could not remove task on server: ${err.message}`); }
        }
        if (itemToRemove.id === fileItems.find(i => ['uploading', 'processing'].includes(i.status))?.id) {
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
        const deletionPromises = itemsToDelete.map(item => fetch(`/task/${item.taskId}`, { method: 'DELETE', cache: 'no-store' }).catch(err => console.error(`Failed to delete task ${item.taskId} on server:`, err)));
        if (deletionPromises.length > 0) await Promise.allSettled(deletionPromises);
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
                        if (item.taskId) { item.status = 'processing'; item.message = "Reconnecting..."; } else { item.status = 'failed'; item.message = "Process interrupted by page reload."; item.error = item.message; }
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
        fileItems = fileItems.filter(item => {
            if (['completed', 'failed'].includes(item.status)) return (now - (item.timestamp || 0)) < maxAge;
            return true;
        });
        saveState();
    }

    function handleDrop(e) { handleFiles(e.dataTransfer.files); }
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    function toggleJpegQualityInput() { jpegQualityGroup.style.display = (document.querySelector('input[name="image_format"]:checked').value === 'jpeg') ? 'block' : 'none'; }
    function handleFileItemActions(event) { const button = event.target.closest('.remove-file-item-btn'); if (button) { const itemEl = button.closest('.file-item'); if (itemEl && itemEl.dataset.id) removeItemFromLog(itemEl.dataset.id); } }
    function showToast(message) { const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message; toastContainer.appendChild(toast); setTimeout(() => toast.remove(), 5000); }
    function formatBytes(bytes, decimals = 1) { if (bytes == null || isNaN(bytes)) return 'N/A'; if (bytes === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i]; }

    initializeApp();
});