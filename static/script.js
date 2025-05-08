document.addEventListener('DOMContentLoaded', function () {
	const uploadForm = document.getElementById('upload-form');
	const pdfFileInput = document.getElementById('pdf-file');
	const dpiInput = document.getElementById('dpi');
	const customFileLabel = document.querySelector('.custom-file-label');

	const progressArea = document.getElementById('progress-area');
	const progressBar = document.getElementById('progress-bar');
	const statusMessage = document.getElementById('status-message');

	const resultArea = document.getElementById('result-area');
	const resultMessage = document.getElementById('result-message');
	const downloadLink = document.getElementById('download-link');

	const errorArea = document.getElementById('error-area');
	const errorMessage = document.getElementById('error-message');

	let pollInterval;

	// Update custom file input label with selected filename
	pdfFileInput.addEventListener('change', function(e){
			var fileName = e.target.files[0] ? e.target.files[0].name : 'Select file...';
			customFileLabel.textContent = fileName;
	});


	uploadForm.addEventListener('submit', async function (event) {
			event.preventDefault();

			// Reset UI
			progressArea.style.display = 'none';
			resultArea.style.display = 'none';
			errorArea.style.display = 'none';
			downloadLink.style.display = 'none';
			progressBar.style.width = '0%';
			progressBar.setAttribute('aria-valuenow', 0);
			progressBar.textContent = '0%';
			statusMessage.textContent = 'Initializing...';

			const formData = new FormData();
			if (!pdfFileInput.files[0]) {
					showError("Please select a PDF file to upload.");
					return;
			}
			formData.append('pdf_file', pdfFileInput.files[0]);
			formData.append('dpi', dpiInput.value);

			progressArea.style.display = 'block';
			statusMessage.textContent = 'Uploading your PDF...';

			try {
					const response = await fetch('/upload', {
							method: 'POST',
							body: formData,
					});

					if (!response.ok) {
							let errorMsg = `Server error: ${response.status}`;
							try {
									const errorData = await response.json();
									errorMsg = errorData.error || errorMsg;
							} catch (e) { /* Ignore if response is not JSON */ }
							throw new Error(errorMsg);
					}

					const data = await response.json();
					if (data.task_id) {
							statusMessage.textContent = 'File uploaded. Queued for processing...';
							progressBar.style.width = '5%'; // Small initial progress
							progressBar.setAttribute('aria-valuenow', 5);
							progressBar.textContent = '5%';
							pollStatus(data.task_id);
					} else {
							throw new Error(data.error || 'Failed to start processing task.');
					}

			} catch (err) {
					showError(err.message);
					progressArea.style.display = 'none';
			}
	});

	function pollStatus(taskId) {
			if (pollInterval) clearInterval(pollInterval);

			pollInterval = setInterval(async () => {
					try {
							const response = await fetch(`/status/${taskId}`);
							if (!response.ok) {
									clearInterval(pollInterval);
									let errorMsg = `Error fetching status: ${response.statusText} (Task ID: ${taskId})`;
									 try {
											const errorData = await response.json();
											errorMsg = errorData.message || errorData.error || errorMsg;
									} catch (e) { /* Ignore if response is not JSON */ }
									showError(errorMsg);
									progressArea.style.display = 'none';
									return;
							}
							const data = await response.json();

							statusMessage.textContent = data.message || 'Processing...';
							const progress = Math.round(data.progress || 0);
							progressBar.style.width = `${progress}%`;
							progressBar.setAttribute('aria-valuenow', progress);
							progressBar.textContent = `${progress}%`;


							if (data.status === 'completed') {
									clearInterval(pollInterval);
									progressArea.style.display = 'none';
									resultArea.style.display = 'block';
									resultMessage.textContent = data.message; // This should now contain the user-friendly filename
									downloadLink.href = `/download/${taskId}`;
									downloadLink.download = data.output_filename; // Suggests filename to browser
									downloadLink.style.display = 'inline-block';
							} else if (data.status === 'failed') {
									clearInterval(pollInterval);
									showError(data.message || 'Processing failed unexpectedly.');
									progressArea.style.display = 'none';
							}
					} catch (err) {
							clearInterval(pollInterval);
							showError('Error polling status: ' + err.message);
							progressArea.style.display = 'none';
					}
			}, 2000); // Poll every 2 seconds
	}

	function showError(message) {
			errorMessage.textContent = message;
			errorArea.style.display = 'block';
			// Ensure progress area is hidden on error
			if (progressArea) progressArea.style.display = 'none';
	}

	// Clear file input on click to allow re-selection of the same file
	pdfFileInput.addEventListener('click', function() {
			this.value = null;
			customFileLabel.textContent = 'Select file...';
	});
});