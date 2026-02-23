document.addEventListener('DOMContentLoaded', async () => {
    const loadingEl = document.getElementById('loading');
    const gridEl = document.getElementById('image-grid');
    const noImagesEl = document.getElementById('no-images');
    const countEl = document.getElementById('image-count');
    const downloadAllBtn = document.getElementById('download-all');
    const sortFilterEl = document.getElementById('sort-filter');

    let allImages = [];

    sortFilterEl.addEventListener('change', applySortAndRender);

    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        showError('Cannot scan Edge/system restricted pages.');
        return;
    }

    // Inject content script to extract images dynamically across all frames
    try {
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js']
        });

        if (injectionResults && injectionResults.length > 0) {
            // Aggregate results from main frame and any iframes
            allImages = injectionResults.map(frame => frame.result).flat().filter(Boolean);

            // Deduplicate by URL and assign indices for original DOM order
            const uniqueMap = new Map();
            let index = 0;
            allImages.forEach(img => {
                if (!uniqueMap.has(img.url)) {
                    uniqueMap.set(img.url, { ...img, originalIndex: index++ });
                }
            });
            allImages = Array.from(uniqueMap.values());

            applySortAndRender();
        } else {
            showError('No images found.');
        }
    } catch (err) {
        console.error('Injection Failed:', err);
        showError('Could not read the page. Try refreshing it.');
    }

    function showError(msg) {
        loadingEl.classList.add('hidden');
        noImagesEl.querySelector('p').textContent = msg;
        noImagesEl.classList.remove('hidden');
        countEl.textContent = '0 images';
    }

    function applySortAndRender() {
        const sortMode = sortFilterEl.value;
        let sorted = [...allImages];

        if (sortMode === 'size-desc') {
            sorted.sort((a, b) => {
                const sizeA = (a.width || 0) * (a.height || 0);
                const sizeB = (b.width || 0) * (b.height || 0);
                return sizeB - sizeA;
            });
        } else if (sortMode === 'size-asc') {
            sorted.sort((a, b) => {
                const sizeA = (a.width || 0) * (a.height || 0);
                const sizeB = (b.width || 0) * (b.height || 0);
                return sizeA - sizeB;
            });
        } else if (sortMode === 'type') {
            sorted.sort((a, b) => (a.type || '').localeCompare(b.type || ''));
        } else {
            sorted.sort((a, b) => a.originalIndex - b.originalIndex);
        }

        renderImages(sorted);
    }

    function renderImages(images) {
        loadingEl.classList.add('hidden');
        gridEl.innerHTML = ''; // Clear grid

        if (images.length === 0) {
            noImagesEl.classList.remove('hidden');
            countEl.textContent = '0 images';
            return;
        }

        gridEl.classList.remove('hidden');
        countEl.textContent = `${images.length} image${images.length !== 1 ? 's' : ''}`;

        images.forEach((img, index) => {
            const card = document.createElement('div');
            card.className = 'image-card';

            const previewContainer = document.createElement('div');
            previewContainer.className = 'image-preview-container';

            const imgEl = document.createElement('img');
            imgEl.className = 'image-preview';
            imgEl.src = img.url;

            // Attempt to load original image dimensions if not available
            const updateDimensions = () => {
                const w = Math.round(img.width || imgEl.naturalWidth);
                const h = Math.round(img.height || imgEl.naturalHeight);
                if (w && h) {
                    const meta = card.querySelector('.image-meta');
                    if (meta) meta.textContent = `${w} × ${h}`;
                    // Store back to the object for reference
                    img.width = w;
                    img.height = h;
                    // Note: Update doesn't auto-re-sort if dimensions came in late, 
                    // user can toggle sort again to refresh.
                }
            };

            if (!img.width || !img.height) {
                imgEl.onload = updateDimensions;
            }

            previewContainer.appendChild(imgEl);

            const infoContainer = document.createElement('div');
            infoContainer.className = 'image-info';

            const meta = document.createElement('div');
            meta.className = 'image-meta';
            meta.textContent = (img.width && img.height) ? `${Math.round(img.width)} × ${Math.round(img.height)}` : 'Size Unknown';

            const typeBadge = document.createElement('div');
            typeBadge.className = 'image-type';
            typeBadge.textContent = img.type;

            const btnGroup = document.createElement('div');
            btnGroup.className = 'button-group';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'action-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = () => copyImage(img.url, copyBtn);

            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'action-btn';
            downloadBtn.textContent = 'Save';
            downloadBtn.onclick = () => downloadImage(img.url, index);

            btnGroup.appendChild(copyBtn);
            btnGroup.appendChild(downloadBtn);

            infoContainer.appendChild(meta);
            infoContainer.appendChild(typeBadge);
            infoContainer.appendChild(btnGroup);

            card.appendChild(previewContainer);
            card.appendChild(infoContainer);
            gridEl.appendChild(card);
        });
    }

    async function copyImage(url, btn) {
        try {
            const tempText = btn.textContent;
            btn.textContent = '...';

            const response = await fetch(url);
            let blob = await response.blob();

            // ClipboardItem primarily supports image/png reliably across browsers
            if (blob.type !== 'image/png') {
                blob = await convertToPngBlob(blob);
            }

            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);

            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = tempText; }, 2000);
        } catch (err) {
            console.error('Copy failed:', err);
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        }
    }

    async function convertToPngBlob(blob) {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }

    function downloadImage(url, index) {
        let ext = 'png'; // default fallback

        // Sniff out extension natively
        if (url.startsWith('data:image/jpeg')) ext = 'jpg';
        else if (url.startsWith('data:image/webp')) ext = 'webp';
        else if (url.startsWith('data:image/gif')) ext = 'gif';
        else if (url.startsWith('data:image/svg') || url.includes('.svg')) ext = 'svg';
        else {
            try {
                const urlObj = new URL(url);
                const match = urlObj.pathname.match(/\.([a-zA-Z0-9]+)$/);
                if (match && match[1].length <= 5) {
                    ext = match[1];
                }
            } catch (e) {
                // Fallback simple regex
                const match = url.match(/\.([a-zA-Z0-9]{3,4})(?:[\?#]|$)/);
                if (match && match[1]) {
                    ext = match[1];
                }
            }
        }

        const filename = `image_${index + 1}.${ext}`;

        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
        });
    }

    downloadAllBtn.addEventListener('click', () => {
        allImages.forEach((img, index) => {
            // Step interval to not overload the API queue
            setTimeout(() => {
                downloadImage(img.url, index);
            }, index * 100);
        });
    });
});
