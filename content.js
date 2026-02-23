(async () => {
    const images = new Map();

    async function addImage(url, width, height, type) {
        if (!url || typeof url !== 'string' || url.startsWith('chrome-extension://')) return;

        // Skip SVG extensions and SVG Data URLs
        if (url.toLowerCase().includes('.svg') || url.toLowerCase().startsWith('data:image/svg')) {
            return;
        }

        // Resolve relative URLs and cleanup
        try {
            if (url.startsWith('//')) {
                url = window.location.protocol + url;
            } else if (url.startsWith('/')) {
                url = window.location.origin + url;
            } else if (!url.startsWith('http') && !url.startsWith('data:') && !url.startsWith('blob:')) {
                const urlObj = new URL(url, window.location.href);
                url = urlObj.href;
            }
        } catch (e) {
            return;
        }

        // Convert blob URLs to data URIs so they can be downloaded from the extension popup
        if (url.startsWith('blob:')) {
            try {
                const response = await fetch(url);
                const blob = await response.blob();
                url = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            } catch (e) {
                // If blob fetching fails (e.g., due to revocation or CORS), ignore it
                return;
            }
        }

        if (!images.has(url)) {
            images.set(url, { url, width: width || 0, height: height || 0, type });
        }
    }

    // Parse srcset to grab the highest resolution image
    function getBestSrcset(srcset) {
        if (!srcset) return null;
        try {
            const sources = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                const url = parts[0];
                const width = parts[1] ? parseInt(parts[1], 10) : 0;
                return { url, width };
            }).filter(s => s.url);

            if (sources.length === 0) return null;
            sources.sort((a, b) => b.width - a.width); // Sort descending by width
            return sources[0].url; // Return highest res
        } catch (e) {
            return null;
        }
    }

    async function traverse(root) {
        // Traverse the DOM to find all potential image sources
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
        let node;
        const nodes = [root]; // Include root (helpful when traversing shadow roots)

        while (node = walker.nextNode()) {
            nodes.push(node);
        }

        for (const el of nodes) {
            if (!el) continue;

            // Safely get tagName, handle cases where it's undefined (like document or shadow root)
            const tagName = (el.tagName || '').toLowerCase();

            // 1. Deep Shadow DOM traversal
            if (el.shadowRoot) {
                await traverse(el.shadowRoot);
            }

            // 2. CSS background-image
            if (tagName !== '') {
                try {
                    const style = window.getComputedStyle(el);
                    const bgImage = style.getPropertyValue('background-image');
                    if (bgImage && bgImage !== 'none') {
                        // Extract the URL from `url("...")`
                        const match = bgImage.match(/url\(['"]?(.*?)['"]?\)/);
                        if (match && match[1]) {
                            let bgUrl = match[1];
                            // Fix conditionally escaped quotes
                            bgUrl = bgUrl.replace(/\\"/g, '"').replace(/\\'/g, "'");
                            await addImage(bgUrl, el.offsetWidth, el.offsetHeight, 'background');
                        }
                    }
                } catch (e) {
                    // Ignore uncomputable styles
                }
            }

            // 3. Normal <img> and <picture> structures
            if (tagName === 'img') {
                const src =
                    el.getAttribute('data-src') || // Lazy loaders
                    el.getAttribute('data-original') ||
                    el.getAttribute('data-lazy-src') ||
                    getBestSrcset(el.getAttribute('srcset')) ||
                    el.src;

                await addImage(src, el.naturalWidth || el.offsetWidth, el.naturalHeight || el.offsetHeight, 'image');
            }



            // 6. <canvas> raster data (Converts directly to PNG Base64)
            if (tagName === 'canvas') {
                try {
                    const dataUri = el.toDataURL('image/png');
                    await addImage(dataUri, el.width, el.height, 'canvas');
                } catch (e) {
                    // Silently fail on tainted canvases (CORS restrictions prevent .toDataURL)
                }
            }
        }
    }

    try {
        // Kick off recursive DOM traversal
        await traverse(document);
    } catch (err) {
        // Ignore traversal errors gracefully
    }

    return Array.from(images.values());
})();
