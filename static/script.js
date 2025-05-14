document.addEventListener('DOMContentLoaded', function () {
	const uploadForm = document.getElementById('upload-form');
	const pdfFileInput = document.getElementById('pdf-file');
	const dpiInput = document.getElementById('dpi');
	const customFileLabel = document.querySelector('.custom-file-label');

	const imageFormatRadios = document.querySelectorAll('input[name="image_format"]');
	const jpegQualityGroup = document.getElementById('jpeg-quality-group');
	const jpegQualityInput = document.getElementById('jpeg_quality');

	const progressArea = document.getElementById('progress-area');
	const progressBar = document.getElementById('progress-bar');
	const statusMessage = document.getElementById('status-message');

	const resultArea = document.getElementById('result-area');
	const resultCardHeader = resultArea.querySelector('.card-header');
	const resultMessage = document.getElementById('result-message');
	const downloadLink = document.getElementById('download-link');

	const compressionStatsDiv = document.getElementById('compression-stats');
	const originalSizeSpan = document.getElementById('original-size');
	const processedSizeSpan = document.getElementById('processed-size');
	const savingsPercentSpan = document.getElementById('savings-percent');

	const errorArea = document.getElementById('error-area');
	const errorMessage = document.getElementById('error-message');

	let pollInterval;

	pdfFileInput.addEventListener('change', function(e){
					var fileName = e.target.files[0] ? e.target.files[0].name : 'Select file...';
					customFileLabel.textContent = fileName;
	});

	function toggleJpegQualityInput() {
					const selectedFormat = document.querySelector('input[name="image_format"]:checked').value;
					if (selectedFormat === 'jpeg') {
									jpegQualityGroup.style.display = 'block';
									jpegQualityInput.disabled = false;
					} else {
									jpegQualityGroup.style.display = 'none';
									jpegQualityInput.disabled = true;
					}
	}

	imageFormatRadios.forEach(radio => {
					radio.addEventListener('change', toggleJpegQualityInput);
	});
	toggleJpegQualityInput(); // Initial call


	uploadForm.addEventListener('submit', async function (event) {
					event.preventDefault();

					// Reset UI elements
					progressArea.style.display = 'none';
					resultArea.style.display = 'none';
					errorArea.style.display = 'none';
					downloadLink.style.display = 'none';
					if (compressionStatsDiv) compressionStatsDiv.style.display = 'none';
					
					// Reset result card styling
					resultCardHeader.classList.remove('bg-danger', 'bg-warning');
					resultCardHeader.classList.add('bg-success');
					resultCardHeader.querySelector('h5').textContent = 'Processing Complete!';
					resultMessage.classList.remove('alert-danger', 'alert-warning');
					resultMessage.classList.add('alert-success');


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

					const selectedPageRasterFormat = document.querySelector('input[name="image_format"]:checked').value;
					formData.append('image_format', selectedPageRasterFormat); // This is 'page_raster_format' on backend
					if (selectedPageRasterFormat === 'jpeg') {
									formData.append('jpeg_quality', jpegQualityInput.value);
					}

					const selectedOutputTargetFormat = document.querySelector('input[name="output_target_format"]:checked').value;
					formData.append('output_target_format', selectedOutputTargetFormat);

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
													progressBar.style.width = '5%';
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
									} catch (e) { /* Ignore */ }
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
									resultCardHeader.classList.remove('bg-danger', 'bg-warning');
									resultCardHeader.classList.add('bg-success');
									resultCardHeader.querySelector('h5').textContent = 'Processing Complete!';
									resultMessage.className = 'alert alert-success';
									resultMessage.textContent = data.message || "Your file is ready!";
									
									if (data.output_filename) {
											downloadLink.href = `/download/${taskId}`;
											downloadLink.download = data.output_filename; // Backend provides full name with extension
											downloadLink.style.display = 'inline-block';
									} else {
											downloadLink.style.display = 'none';
											resultMessage.textContent = data.message || "Processing finished, but no downloadable file was specified.";
									}


									if (data.original_size_bytes != null && data.processed_size_bytes != null && data.original_size_bytes > 0) {
											const originalSize = data.original_size_bytes;
											const processedSize = data.processed_size_bytes;

											originalSizeSpan.textContent = `Original Size: ${formatBytes(originalSize)}`;
											processedSizeSpan.textContent = `Processed Size: ${formatBytes(processedSize)}`;

											const savings = originalSize - processedSize;
											if (savings > 0) {
													const percentageSavings = ((savings / originalSize) * 100).toFixed(1);
													savingsPercentSpan.textContent = `Savings: ${formatBytes(savings)} (${percentageSavings}%)`;
													savingsPercentSpan.className = 'font-weight-bold text-success d-block';
											} else if (savings < 0) {
													const percentageIncrease = ((Math.abs(savings) / originalSize) * 100).toFixed(1);
													savingsPercentSpan.textContent = `File Size Increased by: ${formatBytes(Math.abs(savings))} (${percentageIncrease}%)`;
													savingsPercentSpan.className = 'font-weight-bold text-danger d-block';
											} else {
													savingsPercentSpan.textContent = 'No significant change in file size.';
													savingsPercentSpan.className = 'font-weight-bold text-info d-block';
											}
											compressionStatsDiv.style.display = 'block';
									} else if (data.original_size_bytes != null && data.processed_size_bytes == null && data.output_target_format === 'image') {
											// Special case: 0-page PDF for image output (failed, no processed file)
											originalSizeSpan.textContent = `Original Size: ${formatBytes(data.original_size_bytes)}`;
											processedSizeSpan.textContent = `Processed Size: N/A`;
											savingsPercentSpan.textContent = 'No image was generated.';
											savingsPercentSpan.className = 'font-weight-bold text-warning d-block';
											compressionStatsDiv.style.display = 'block';
									}
									 else {
											compressionStatsDiv.style.display = 'none';
									}

							} else if (data.status === 'failed') {
									clearInterval(pollInterval);
									progressArea.style.display = 'none';
									resultArea.style.display = 'block'; // Show result area for failed message

									resultCardHeader.classList.remove('bg-success', 'bg-warning');
									resultCardHeader.classList.add('bg-danger');
									resultCardHeader.querySelector('h5').textContent = 'Processing Failed';
									
									resultMessage.className = 'alert alert-danger';
									resultMessage.textContent = data.message || 'Processing failed unexpectedly.';
									downloadLink.style.display = 'none'; // No download for failed tasks

									// Show original size if available, even on failure
									if (data.original_size_bytes != null) {
											originalSizeSpan.textContent = `Original Size: ${formatBytes(data.original_size_bytes)}`;
											processedSizeSpan.textContent = `Processed Size: N/A (Failed)`;
											savingsPercentSpan.textContent = '';
											compressionStatsDiv.style.display = 'block';
									} else {
											compressionStatsDiv.style.display = 'none';
									}
							}
					} catch (err) {
							clearInterval(pollInterval);
							showError('Error polling status: ' + err.message);
							progressArea.style.display = 'none';
					}
			}, 2000);
	}

	function showError(message) {
			errorMessage.textContent = message;
			errorArea.style.display = 'block';
			if (progressArea) progressArea.style.display = 'none';
			if (resultArea) resultArea.style.display = 'none';
			if (compressionStatsDiv) compressionStatsDiv.style.display = 'none';
	}

	function formatBytes(bytes, decimals = 2) {
			if (bytes == null || typeof bytes !== 'number' || isNaN(bytes)) return 'N/A';
			if (bytes === 0 && (arguments.length > 0 && typeof arguments[0] === 'number') ) return '0 Bytes'; // More specific check for 0

			const k = 1024;
			const dm = decimals < 0 ? 0 : decimals;
			const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

			const i = Math.floor(Math.log(bytes) / Math.log(k));
			
			if (i < 0 || i >= sizes.length) { // Handle extremely small or large numbers that might result in invalid index
					return parseFloat(bytes.toExponential(dm)) + ' Bytes'; // Fallback for extreme values
			}

			return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
	}

	// Clear file input on click to allow re-selection of the same file
	pdfFileInput.addEventListener('click', function() {
			this.value = null;
			customFileLabel.textContent = 'Select file...';
	});
});