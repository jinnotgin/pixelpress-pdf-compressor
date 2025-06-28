document.addEventListener('DOMContentLoaded', function () {
    const uploadForm = document.getElementById('upload-form');
    const pdfFileInput = document.getElementById('pdf-file');
    const customFileLabel = document.querySelector('.custom-file-label');
    const submitButton = uploadForm.querySelector('button[type="submit"]');

    const imageFormatRadios = document.querySelectorAll('input[name="image_format"]');
    const jpegQualityGroup = document.getElementById('jpeg-quality-group');
    const jpegQualityInput = document.getElementById('jpeg_quality');
    const dpiInput = document.getElementById('dpi');

    const dropZone = document.getElementById('drop-zone');

    const fileProcessingLogArea = document.getElementById('file-processing-log-area');
    const fileLogList = document.getElementById('file-log-list');
    const noFilesMessage = document.getElementById('no-files-message');
    const clearLogBtn = document.getElementById('clear-log-btn');

    const globalErrorArea = document.getElementById('global-error-area');
    const globalErrorMessage = document.getElementById('global-error-message');

    let fileItems = [];
    let isCurrentlyProcessingQueueItem = false;
    let currentPollIntervalId = null;
    let isInitialLoad = true;
    
    let isServerReachable = true;
    let healthCheckIntervalId = null;

    const FRONTEND_HISTORY_LIFESPAN_HOURS = 72 - 1;

    function initializeApp() {
        pdfFileInput.multiple = true;
        if (submitButton.querySelector('span')) submitButton.querySelector('span').textContent = ' Add Selected Files to Queue';
        
        imageFormatRadios.forEach(radio => radio.addEventListener('change', toggleJpegQualityInput));
        toggleJpegQualityInput();

        pdfFileInput.addEventListener('change', (e) => handleFiles(e.target.files));
        
        uploadForm.addEventListener('submit', function(event) {
            event.preventDefault();
            if (pdfFileInput.files.length > 0) {
                handleFiles(pdfFileInput.files);
            }
        });

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false));
        ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false));
        dropZone.addEventListener('drop', handleDrop, false);

        loadState();
        clearOldFinishedItems();
        renderFileLogList();
        isInitialLoad = false;
        
        checkServerHealth().then(() => {
            if (isServerReachable) {
                processFileQueue();
            }
        });

        clearLogBtn.addEventListener('click', async () => {
            const confirmMessage = "This will permanently delete all completed and failed files from the server and clear them from this list. This action cannot be undone. Continue?";
            
            if (confirm(confirmMessage)) {
                const itemsToDeleteOnServer = fileItems.filter(item =>
                    (item.status === 'completed' || item.status === 'failed') && item.taskId
                );

                const deletionPromises = itemsToDeleteOnServer.map(item =>
                    fetch(`/task/${item.taskId}`, { method: 'DELETE', cache: 'no-store'  })
                        .catch(err => console.error(`Failed to delete task ${item.taskId} on server:`, err))
                );

                if (deletionPromises.length > 0) {
                    await Promise.allSettled(deletionPromises);
                }

                fileItems = fileItems.filter(item =>
                    item.status !== 'completed' && item.status !== 'failed'
                );

                saveState();
                renderFileLogList();
            }
        });
        
        pdfFileInput.addEventListener('click', function() {
            this.value = null;
            customFileLabel.textContent = 'Select file(s)...';
        });

        fileLogList.addEventListener('click', function(event) {
            if (event.target.closest('.remove-file-item-btn')) {
                const button = event.target.closest('.remove-file-item-btn');
                const itemId = button.dataset.itemId;
                if (itemId) {
                    removeItemFromLog(itemId);
                }
            }
        });
    }

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
                globalErrorArea.style.display = 'none';
                submitButton.disabled = false;
                processFileQueue();
            }
        } catch (error) {
            if (isServerReachable) {
                console.error("Server has become unreachable. Pausing operations.", error.message);
                isServerReachable = false;
                submitButton.disabled = true;
                showGlobalError("Cannot connect to the server. Will keep trying to reconnect...");

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
    
    async function handleFetchError(error, item) {
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            console.warn("Fetch failed, triggering a server health check.");
            if (item) {
                item.status = 'pending';
                item.message = "Connection lost. Waiting to reconnect to server...";
                item.progress = 0;
            }
            isCurrentlyProcessingQueueItem = false;
            await checkServerHealth();
        } else {
            if (item) {
                item.status = 'failed';
                item.message = error.message;
                item.error = error.message;
            }
            isCurrentlyProcessingQueueItem = false;
            processFileQueue();
        }
    }

    function handleFiles(files) {
        if (!isServerReachable) {
            showGlobalError("Cannot add files. The server is currently unreachable.");
            return;
        }

        pdfFileInput.value = '';
        customFileLabel.textContent = 'Select file(s)...';
        globalErrorArea.style.display = 'none';

        if (!files || files.length === 0) return;
        
        const currentFileNamesAndSettings = new Set(fileItems.map(item => item.originalFilename + item.settings.outputTargetFormat + item.settings.pageRasterFormat + item.settings.dpi));

        if (files.length === 1) customFileLabel.textContent = files[0].name;
        else customFileLabel.textContent = `${files.length} files selected`;

        const currentSettings = {
            dpi: dpiInput.value,
            pageRasterFormat: document.querySelector('input[name="image_format"]:checked').value,
            jpegQuality: (document.querySelector('input[name="image_format"]:checked').value === 'jpeg' ? jpegQualityInput.value : null),
            outputTargetFormat: document.querySelector('input[name="output_target_format"]:checked').value
        };

        let filesAddedCount = 0;
        for (const file of files) {
            if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
                showGlobalError(`File "${file.name}" is not a PDF and was skipped.`);
                continue;
            }
            const uniqueFileKey = file.name + currentSettings.outputTargetFormat + currentSettings.pageRasterFormat + currentSettings.dpi;
            if (currentFileNamesAndSettings.has(uniqueFileKey) && fileItems.find(item => (item.originalFilename + item.settings.outputTargetFormat + item.settings.pageRasterFormat + item.settings.dpi) === uniqueFileKey && ['pending', 'processing', 'uploading'].includes(item.status))) {
                 console.log(`Skipping duplicate or already active file: ${file.name} with same settings.`);
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
            currentFileNamesAndSettings.add(uniqueFileKey);
            filesAddedCount++;
        }
        
        if (filesAddedCount > 0) {
            saveState();
            renderFileLogList(); 
            processFileQueue();
        }
    }

    async function processFileQueue() {
        if (isCurrentlyProcessingQueueItem || !isServerReachable) return;

        const itemToReconnect = fileItems.find(item => item.status === 'processing' && item.taskId);
        if (itemToReconnect) {
            isCurrentlyProcessingQueueItem = true;
            console.log(`Reconnecting to active task: ${itemToReconnect.originalFilename}`);
            pollStatusForItem(itemToReconnect);
            return;
        }

        const currentItem = fileItems.find(item => item.status === 'pending');
        if (!currentItem) return;

        isCurrentlyProcessingQueueItem = true;
        currentItem.status = 'uploading';
        currentItem.message = 'Preparing to upload...';
        currentItem.progress = 0;
        currentItem.timestamp = Date.now();
        renderFileLogList();

        const formData = new FormData();
        formData.append('pdf_file', currentItem.file);
        formData.append('dpi', currentItem.settings.dpi);
        formData.append('image_format', currentItem.settings.pageRasterFormat);
        if (currentItem.settings.pageRasterFormat === 'jpeg' && currentItem.settings.jpegQuality) {
            formData.append('jpeg_quality', currentItem.settings.jpegQuality);
        }
        formData.append('output_target_format', currentItem.settings.outputTargetFormat);

        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            currentItem.file = null;

            if (!response.ok) {
                let errorMsg = `Upload failed: ${response.status}`;
                try { const errorData = await response.json(); errorMsg = errorData.error || errorMsg; } catch (e) {}
                throw new Error(errorMsg);
            }

            const data = await response.json();
            if (data.task_id) {
                currentItem.taskId = data.task_id;
                currentItem.status = 'processing';
                currentItem.message = data.message || 'Processing on server...';
                currentItem.progress = data.progress || 15;
                pollStatusForItem(currentItem);
            } else {
                throw new Error(data.error || 'Failed to start processing task.');
            }
        } catch (err) {
            await handleFetchError(err, currentItem);
        } finally {
            saveState();
            renderFileLogList();
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
            if (!currentItemInPoll || !currentItemInPoll.taskId || currentItemInPoll.status === 'cancelling') {
                clearInterval(currentPollIntervalId);
                isCurrentlyProcessingQueueItem = false;
                processFileQueue();
                return;
            }

            try {
                const response = await fetch(`/status/${currentItemInPoll.taskId}`, { cache: 'no-store' }); 
                if (!response.ok) {
                    clearInterval(currentPollIntervalId);
                    let errorMsg = `Error fetching status: ${response.statusText}`;
                    try { const errorData = await response.json(); errorMsg = errorData.message || errorData.error || errorMsg; } catch (e) {}
                    throw new Error(errorMsg);
                }
                const data = await response.json();
                
                currentItemInPoll.message = data.message || 'Processing...';
                currentItemInPoll.progress = Math.round(data.progress || currentItemInPoll.progress);
                currentItemInPoll.status = data.status;

                if (data.status === 'completed') {
                    clearInterval(currentPollIntervalId);
                    currentItemInPoll.downloadUrl = `/download/${currentItemInPoll.taskId}`;
                    currentItemInPoll.userFacingOutputFilename = data.output_filename;
                    currentItemInPoll.originalSizeBytes = data.original_size_bytes;
                    currentItemInPoll.processedSizeBytes = data.processed_size_bytes;
                    isCurrentlyProcessingQueueItem = false;
                    processFileQueue();
                } else if (data.status === 'failed') {
                    clearInterval(currentPollIntervalId);
                    currentItemInPoll.error = data.message || 'Processing failed on server.';
                    currentItemInPoll.originalSizeBytes = data.original_size_bytes;
                    isCurrentlyProcessingQueueItem = false;
                    processFileQueue();
                }

            } catch (err) {
                console.warn("Polling failed, triggering server health check.");
                clearInterval(currentPollIntervalId);
                await handleFetchError(err, currentItemInPoll);
            } finally {
                const itemToUpdate = fileItems.find(fi => fi.id === item.id);
                if(itemToUpdate) itemToUpdate.timestamp = Date.now();
                saveState();
                renderFileLogList();
            }
        }, 2000);
    }
    
    async function removeItemFromLog(itemId) {
        const itemIndex = fileItems.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return;
        const itemToRemove = fileItems[itemIndex];
        const isActive = ['uploading', 'processing'].includes(itemToRemove.status);
        const confirmMessage = isActive
            ? "Are you sure you want to cancel this active process? This cannot be undone."
            : "Are you sure you want to permanently delete this item and its output file from the server?";
        if (itemToRemove.status === 'pending' || confirm(confirmMessage)) {
            if (itemToRemove.taskId && isServerReachable) {
                try {
                    itemToRemove.status = 'cancelling'; itemToRemove.message = 'Requesting cancellation/deletion...'; renderFileLogList();
                    await fetch(`/task/${itemToRemove.taskId}`, { method: 'DELETE', cache: 'no-store' });
                } catch (err) {
                    itemToRemove.status = 'failed'; itemToRemove.error = `Error: ${err.message}`;
                    itemToRemove.message = `Could not remove task. ${err.message}`;
                    saveState(); renderFileLogList(); return;
                }
            }
            if (itemToRemove.id === fileItems.find(i => i.status === 'uploading' || i.status === 'processing' || i.status === 'cancelling')?.id) {
                clearInterval(currentPollIntervalId); currentPollIntervalId = null; isCurrentlyProcessingQueueItem = false;
            }
            fileItems.splice(itemIndex, 1);
            saveState(); renderFileLogList();
            if (!isCurrentlyProcessingQueueItem) processFileQueue();
        }
    }
    
    function renderFileLogList() {
        fileLogList.innerHTML = '';
        if (fileItems.length === 0) { fileProcessingLogArea.style.display = 'none'; return; }
        fileProcessingLogArea.style.display = 'block'; noFilesMessage.style.display = 'none';
        if (isInitialLoad) fileItems.sort((a, b) => b.timestamp - a.timestamp);
        fileItems.forEach(item => {
            const li = document.createElement('li'); li.className = 'list-group-item'; li.setAttribute('data-id', item.id);
            let statusBadge = '', progressBarHtml = '', itemMessageHtml = '', actionsHtml = '', sizeDetailsHtml = '';
            const lastActivityHtml = `<p class="mb-1"><small class="text-muted" style="font-size: 0.8em;">Last activity: ${new Date(item.timestamp).toLocaleTimeString()}</small></p>`;
            if (item.status === 'failed' && item.error) itemMessageHtml = `<p class="mb-1"><small class="text-danger">Error: ${item.error}</small></p>`;
            else if (item.message) itemMessageHtml = `<p class="mb-1"><small class="text-muted">${item.message}</small></p>`;
            switch (item.status) {
                case 'pending': statusBadge = `<span class="badge badge-info">PENDING</span>`; break;
                case 'uploading': case 'processing':
                    statusBadge = `<span class="badge badge-primary">${item.status.toUpperCase()}</span>`;
                    progressBarHtml = `<div class="progress mt-1" style="height: 10px;"><div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: ${item.progress}%;" aria-valuenow="${item.progress}">${item.progress}%</div></div>`;
                    break;
                case 'cancelling': statusBadge = `<span class="badge badge-warning">CANCELLING</span>`; break;
                case 'completed':
                    statusBadge = `<span class="badge badge-success">COMPLETED</span>`;
                    if (item.downloadUrl) actionsHtml = `<a href="${item.downloadUrl}" download="${item.userFacingOutputFilename}" class="btn btn-sm btn-success mt-2">Download</a>`;
                    if (item.originalSizeBytes != null && item.processedSizeBytes != null) {
                        const original = item.originalSizeBytes, processed = item.processedSizeBytes, savings = original - processed;
                        let savingsText = (savings > 0) ? `<span class="text-success">Saved ${formatBytes(savings)} (${((savings / original) * 100).toFixed(1)}%)</span>` : (savings < 0) ? `<span class="text-danger">Increased by ${formatBytes(Math.abs(savings))}</span>` : `<span class="text-info">No size change</span>`;
                        sizeDetailsHtml = `<p class="mb-0 mt-1"><small class="text-muted">Original: ${formatBytes(original)} | Processed: ${formatBytes(processed)}. ${savingsText}</small></p>`;
                    }
                    break;
                case 'failed':
                    statusBadge = `<span class="badge badge-danger">FAILED</span>`;
                    if (item.originalSizeBytes != null) sizeDetailsHtml = `<p class="mb-0 mt-1"><small class="text-muted">Original Size: ${formatBytes(item.originalSizeBytes)}</small></p>`;
                    break;
            }
            const removeButtonHtml = `<button type="button" class="close remove-file-item-btn ml-2 p-0" data-item-id="${item.id}" title="Remove/Cancel this item" style="font-size: 1.3rem; line-height: 1;"><span aria-hidden="true">×</span></button>`;
            li.innerHTML = `<div class="d-flex justify-content-between align-items-start mb-1"><span class="font-weight-bold" style="flex-grow: 1; margin-right: 10px;">${item.originalFilename}</span><div class="d-flex align-items-center">${statusBadge}${removeButtonHtml}</div></div>${lastActivityHtml}${itemMessageHtml}${sizeDetailsHtml}${progressBarHtml}${actionsHtml}`;
            fileLogList.appendChild(li);
        });
    }

    function showGlobalError(message) { globalErrorMessage.textContent = message; globalErrorArea.style.display = 'block'; }
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    function handleDrop(e) { handleFiles(e.dataTransfer.files); }

    function toggleJpegQualityInput() {
        const selectedFormat = document.querySelector('input[name="image_format"]:checked').value;
        jpegQualityGroup.style.display = (selectedFormat === 'jpeg') ? 'block' : 'none';
        jpegQualityInput.disabled = (selectedFormat !== 'jpeg');
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes == null || isNaN(bytes)) return 'N/A';
        if (bytes === 0) return '0 Bytes';
        const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function loadState() {
        const storedState = localStorage.getItem('pixelPressFileItems');
        if (storedState) {
            try { 
                fileItems = JSON.parse(storedState);
                fileItems.forEach(item => {
                    if (['pending', 'uploading', 'processing', 'cancelling'].includes(item.status)) {
                        if (item.taskId) { item.status = 'processing'; item.message = "Reconnecting to check task status..."; } 
                        else { item.status = 'failed'; item.message = "Process interrupted before server task was created."; item.error = item.message; }
                    }
                    if (!item.timestamp) item.timestamp = Date.now() - FRONTEND_HISTORY_LIFESPAN_HOURS * 3600 * 1000 * 2;
                });
            } 
            catch (e) { console.error("Error parsing stored state:", e); fileItems = []; }
        }
    }

    function saveState() {
        const storableItems = fileItems.map(item => { const { file, ...rest } = item; return rest; });
        localStorage.setItem('pixelPressFileItems', JSON.stringify(storableItems));
    }

    function clearOldFinishedItems() {
        const now = Date.now();
        const maxAge = FRONTEND_HISTORY_LIFESPAN_HOURS * 60 * 60 * 1000;
        const prevLength = fileItems.length;
        fileItems = fileItems.filter(item => {
            if (['completed', 'failed'].includes(item.status)) return (now - (item.timestamp || 0)) < maxAge;
            return true;
        });
        if (fileItems.length < prevLength) saveState();
    }
    
    initializeApp();
});