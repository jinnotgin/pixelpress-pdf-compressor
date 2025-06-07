document.addEventListener('DOMContentLoaded', function () {
    const uploadForm = document.getElementById('upload-form');
    const pdfFileInput = document.getElementById('pdf-file');
    const customFileLabel = document.querySelector('.custom-file-label');
    const submitButtonSpan = uploadForm.querySelector('button[type="submit"] span');

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

    const FRONTEND_HISTORY_LIFESPAN_HOURS = 1;

    function initializeApp() {
        pdfFileInput.multiple = true;
        if (submitButtonSpan) submitButtonSpan.textContent = ' Add Selected Files to Queue';
        
        imageFormatRadios.forEach(radio => radio.addEventListener('change', toggleJpegQualityInput));
        toggleJpegQualityInput();

        pdfFileInput.addEventListener('change', (e) => handleFiles(e.target.files));
        
        uploadForm.addEventListener('submit', function(event) {
            event.preventDefault();
            if (pdfFileInput.files.length > 0) {
                handleFiles(pdfFileInput.files);
                pdfFileInput.value = ''; 
                customFileLabel.textContent = 'Select file(s)...';
            } else if (fileItems.filter(item => item.status === 'pending').length === 0) {
                 showGlobalError("Please select PDF files to add to the queue.");
                 return;
            }
            processFileQueue();
        });

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false);
        });
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false);
        });
        dropZone.addEventListener('drop', handleDrop, false);

        loadState(); 
        clearOldFinishedItems();
        renderFileLogList();
        isInitialLoad = false;

        clearLogBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to clear all completed and failed items?")) {
                fileItems = fileItems.filter(item => item.status === 'pending' || item.status === 'uploading' || item.status === 'processing');
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

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    }

    function handleFiles(files) {
        globalErrorArea.style.display = 'none';
        if (!files || files.length === 0) {
            customFileLabel.textContent = 'Select file(s)...';
            return;
        }
        
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
            if (currentFileNamesAndSettings.has(uniqueFileKey) && fileItems.find(item => (item.originalFilename + item.settings.outputTargetFormat + item.settings.pageRasterFormat + item.settings.dpi) === uniqueFileKey && (item.status === 'pending' || item.status === 'processing' || item.status === 'uploading'))) {
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
                addedOrder: fileItems.length 
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
        pdfFileInput.value = '';
        customFileLabel.textContent = 'Select file(s)...';
    }

    async function processFileQueue() {
        if (isCurrentlyProcessingQueueItem) return;

        const currentItem = fileItems.find(item => item.status === 'pending');
        if (!currentItem) {
            isCurrentlyProcessingQueueItem = false;
            return;
        }

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
            currentItem.progress = 5;
            currentItem.message = `Uploading: ${currentItem.originalFilename}...`;
            currentItem.timestamp = Date.now();
            renderFileLogList();

            const response = await fetch('/upload', { method: 'POST', body: formData });
            
            currentItem.progress = 10;
            currentItem.message = `Uploaded: ${currentItem.originalFilename}. Waiting for server...`;
            currentItem.timestamp = Date.now();
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
                currentItem.message = data.message || 'Processing on server...'; // Keep backend message for processing steps
                currentItem.progress = data.progress || 15;
                currentItem.timestamp = Date.now();
                renderFileLogList();
                pollStatusForItem(currentItem);
            } else {
                throw new Error(data.error || 'Failed to start processing task.');
            }
        } catch (err) {
            currentItem.status = 'failed';
            currentItem.message = err.message;
            currentItem.error = err.message;
            currentItem.timestamp = Date.now();
            currentItem.file = null;
            saveState();
            renderFileLogList();
            isCurrentlyProcessingQueueItem = false;
            processFileQueue();
        }
    }

    function pollStatusForItem(item) {
        if (currentPollIntervalId) clearInterval(currentPollIntervalId);
        if (!fileItems.find(fi => fi.id === item.id)) {
            isCurrentlyProcessingQueueItem = false;
            processFileQueue();
            return;
        }

        currentPollIntervalId = setInterval(async () => {
            const currentItemInPoll = fileItems.find(fi => fi.id === item.id);
            if (!currentItemInPoll || !currentItemInPoll.taskId) {
                clearInterval(currentPollIntervalId);
                isCurrentlyProcessingQueueItem = false;
                processFileQueue();
                return;
            }

            try {
                const response = await fetch(`/status/${currentItemInPoll.taskId}`);
                if (!response.ok) {
                    clearInterval(currentPollIntervalId);
                    let errorMsg = `Error fetching status for ${currentItemInPoll.originalFilename}: ${response.statusText}`;
                    try { const errorData = await response.json(); errorMsg = errorData.message || errorData.error || errorMsg; } catch (e) {}
                    
                    currentItemInPoll.status = 'failed'; currentItemInPoll.message = errorMsg; currentItemInPoll.error = errorMsg;
                    currentItemInPoll.timestamp = Date.now();
                    saveState(); renderFileLogList();
                    isCurrentlyProcessingQueueItem = false; processFileQueue();
                    return;
                }
                const data = await response.json();
                // Only update message if it's not the generic success one for completed items or if status is not completed
                if (data.status !== 'completed' || (data.message && !data.message.toLowerCase().startsWith("success! your processed file is ready"))) {
                     currentItemInPoll.message = data.message || 'Processing...';
                } else if (data.status === 'completed') {
                    currentItemInPoll.message = ''; // Clear generic success message for completed
                }

                currentItemInPoll.progress = Math.round(data.progress || currentItemInPoll.progress);
                currentItemInPoll.timestamp = Date.now();

                if (data.status === 'completed') {
                    clearInterval(currentPollIntervalId);
                    currentItemInPoll.status = 'completed';
                    currentItemInPoll.progress = 100;
                    currentItemInPoll.userFacingOutputFilename = data.output_filename;
                    currentItemInPoll.downloadUrl = `/download/${currentItemInPoll.taskId}`;
                    currentItemInPoll.originalSizeBytes = data.original_size_bytes;
                    currentItemInPoll.processedSizeBytes = data.processed_size_bytes;
                } else if (data.status === 'failed') {
                    clearInterval(currentPollIntervalId);
                    currentItemInPoll.status = 'failed';
                    currentItemInPoll.message = data.message || 'Processing failed on server.'; // Keep error message
                    currentItemInPoll.error = data.message || 'Processing failed on server.';
                    currentItemInPoll.originalSizeBytes = data.original_size_bytes;
                }
                
                saveState(); renderFileLogList();

                if (data.status === 'completed' || data.status === 'failed') {
                    isCurrentlyProcessingQueueItem = false; processFileQueue();
                }

            } catch (err) {
                clearInterval(currentPollIntervalId);
                const itemToFail = fileItems.find(fi => fi.id === item.id);
                if (itemToFail) {
                    itemToFail.status = 'failed'; itemToFail.message = 'Error polling status: ' + err.message; itemToFail.error = err.message;
                    itemToFail.timestamp = Date.now();
                    saveState(); renderFileLogList();
                }
                isCurrentlyProcessingQueueItem = false; processFileQueue();
            }
        }, 2000);
    }

    function removeItemFromLog(itemId) {
        if (confirm("Are you sure you want to remove this item?")) {
            const itemIndex = fileItems.findIndex(item => item.id === itemId);
            if (itemIndex > -1) {
                const itemToRemove = fileItems[itemIndex];
                if (isCurrentlyProcessingQueueItem && currentPollIntervalId && itemToRemove.status !== 'completed' && itemToRemove.status !== 'failed') {
                    const activeItem = fileItems.find(i => i.status === 'uploading' || i.status === 'processing');
                    if (activeItem && activeItem.id === itemId) {
                         clearInterval(currentPollIntervalId);
                         currentPollIntervalId = null;
                         isCurrentlyProcessingQueueItem = false;
                    }
                }
                fileItems.splice(itemIndex, 1);
                saveState();
                renderFileLogList();
                if (!isCurrentlyProcessingQueueItem) {
                    processFileQueue();
                }
            }
        }
    }
    
    function renderFileLogList() {
        fileLogList.innerHTML = ''; 

        if (fileItems.length === 0) {
            fileProcessingLogArea.style.display = 'none';
            noFilesMessage.style.display = 'block';
            return;
        }
        
        fileProcessingLogArea.style.display = 'block';
        noFilesMessage.style.display = 'none';

        if (isInitialLoad) {
            fileItems.sort((a, b) => b.timestamp - a.timestamp);
        }

        fileItems.forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-group-item'; // Removed position-relative, will handle X button in flow
            li.setAttribute('data-id', item.id);

            let statusBadge = '';
            let progressBarHtml = '';
            let itemMessageHtml = ''; // This will hold the relevant message
            let actionsHtml = '';
            let sizeDetailsHtml = '';

            const lastActivityHtml = `<p class="mb-1"><small class="text-muted" style="font-size: 0.8em;">Last activity: ${new Date(item.timestamp).toLocaleTimeString()}</small></p>`;

            // Determine itemMessageHtml based on status and content
            if (item.status === 'failed' && item.error) {
                itemMessageHtml = `<p class="mb-1"><small class="text-danger">Error: ${item.error}</small></p>`;
            } else if (item.message && item.message.trim() !== '' && !(item.status === 'completed' && item.message.toLowerCase().startsWith("success! your processed file is ready"))) {
                // Show item.message if it's not empty and not the generic success for completed items
                itemMessageHtml = `<p class="mb-1"><small class="text-muted">${item.message}</small></p>`;
            }


            switch (item.status) {
                case 'pending':
                    statusBadge = `<span class="badge badge-info">PENDING</span>`;
                    // itemMessageHtml already set if item.message exists
                    break;
                case 'uploading':
                case 'processing':
                    statusBadge = `<span class="badge badge-primary">${item.status.toUpperCase()}</span>`;
                    // itemMessageHtml already set
                    progressBarHtml = `
                        <div class="progress mt-1 file-item-progress-bar" style="height: 10px;">
                            <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" 
                                 style="width: ${item.progress}%;" aria-valuenow="${item.progress}" 
                                 aria-valuemin="0" aria-valuemax="100">${item.progress}%</div>
                        </div>`;
                    break;
                case 'completed':
                    statusBadge = `<span class="badge badge-success">COMPLETED</span>`;
                    // itemMessageHtml is intentionally blank for generic success, or set if backend sent a different completion message
                     if (item.downloadUrl && item.userFacingOutputFilename) {
                        actionsHtml = `<a href="${item.downloadUrl}" download="${item.userFacingOutputFilename}" class="btn btn-sm btn-success mt-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" class="bi bi-download mr-1" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
                            Download
                        </a>`;
                    }
                    if (item.originalSizeBytes != null && item.processedSizeBytes != null) {
                        let savingsText = '';
                        const original = item.originalSizeBytes;
                        const processed = item.processedSizeBytes;
                        const savings = original - processed;
                        if (original > 0) {
                            if (savings > 0) savingsText = `<span class="text-success">Saved ${formatBytes(savings)} (${((savings / original) * 100).toFixed(1)}%)</span>`;
                            else if (savings < 0) savingsText = `<span class="text-danger">Increased by ${formatBytes(Math.abs(savings))} (${((Math.abs(savings) / original) * 100).toFixed(1)}%)</span>`;
                            else savingsText = `<span class="text-info">No size change</span>`;
                        }
                         sizeDetailsHtml = `<p class="mb-0 mt-1"><small class="text-muted">
                            Original: ${formatBytes(original)} | Processed: ${formatBytes(processed)}. ${savingsText}
                         </small></p>`;
                    }
                    break;
                case 'failed':
                    statusBadge = `<span class="badge badge-danger">FAILED</span>`;
                    // itemMessageHtml for error is already set
                     if (item.originalSizeBytes != null) {
                        sizeDetailsHtml = `<p class="mb-0 mt-1"><small class="text-muted">Original Size: ${formatBytes(item.originalSizeBytes)}</small></p>`;
                    }
                    break;
            }

            const removeButtonHtml = `
                <button type="button" class="close remove-file-item-btn ml-2 p-0" data-item-id="${item.id}" aria-label="Remove item" style="font-size: 1.3rem; line-height: 1; outline: none; box-shadow: none;">
                    <span aria-hidden="true">×</span>
                </button>`;

            li.innerHTML = `
                <div class="d-flex justify-content-between align-items-start mb-1">
                    <span class="font-weight-bold" style="flex-grow: 1; margin-right: 10px;">${item.originalFilename}</span>
                    <div class="d-flex align-items-center">
                        ${statusBadge}
                        ${removeButtonHtml}
                    </div>
                </div>
                ${lastActivityHtml}
                ${itemMessageHtml}
                ${sizeDetailsHtml}
                ${progressBarHtml}
                ${actionsHtml}
            `;
            fileLogList.appendChild(li);
        });
        clearLogBtn.style.display = fileItems.some(item => item.status === 'completed' || item.status === 'failed') ? 'block' : 'none';
    }

    function showGlobalError(message) {
        globalErrorMessage.textContent = message;
        globalErrorArea.style.display = 'block';
    }

    function loadState() {
        const storedState = localStorage.getItem('pixelPressFileItems');
        if (storedState) {
            try { 
                fileItems = JSON.parse(storedState);
                fileItems.forEach(item => {
                    if (item.status === 'uploading' || item.status === 'processing') {
                        item.status = 'failed';
                        item.message = "Process interrupted by page reload/close.";
                        item.progress = 0;
                        item.error = item.message;
                    }
                    if (!item.timestamp) item.timestamp = Date.now() - FRONTEND_HISTORY_LIFESPAN_HOURS * 3600 * 1000 * 2;
                });
            } 
            catch (e) { console.error("Error parsing stored state:", e); fileItems = []; }
        }
    }

    function saveState() {
        const storableItems = fileItems.map(item => {
            const { file, ...rest } = item;
            return rest;
        });
        localStorage.setItem('pixelPressFileItems', JSON.stringify(storableItems));
    }

    function clearOldFinishedItems() {
        const now = Date.now();
        const maxAge = FRONTEND_HISTORY_LIFESPAN_HOURS * 60 * 60 * 1000;
        const prevLength = fileItems.length;
        fileItems = fileItems.filter(item => {
            if (item.status === 'completed' || item.status === 'failed') {
                return (now - (item.timestamp || 0)) < maxAge;
            }
            return true;
        });
        if (fileItems.length < prevLength) {
            saveState();
        }
    }

    function toggleJpegQualityInput() {
        const selectedFormat = document.querySelector('input[name="image_format"]:checked').value;
        jpegQualityGroup.style.display = (selectedFormat === 'jpeg') ? 'block' : 'none';
        jpegQualityInput.disabled = (selectedFormat !== 'jpeg');
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes == null || typeof bytes !== 'number' || isNaN(bytes)) return 'N/A';
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i < 0 || i >= sizes.length) return parseFloat(bytes.toExponential(dm)) + ' Bytes';
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    
    initializeApp();
});