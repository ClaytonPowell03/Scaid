import { getGalleryLatest, isSupabaseConfigured, getUser } from './supabase.js';

// Elements
const loadingEl = document.getElementById('gallery-loading');
const emptyEl = document.getElementById('gallery-empty');
const gridEl = document.getElementById('gallery-grid');
const uploadCta = document.querySelector('.gallery-hero__cta');

async function renderGallery() {
  if (!isSupabaseConfigured()) {
    showError("Database not configured. Run the Supabase SQL scripts.");
    return;
  }

  try {
    const items = await getGalleryLatest(50);
    loadingEl.style.display = 'none';

    if (items.length === 0) {
      emptyEl.style.display = 'block';
    } else {
      gridEl.style.display = 'grid';
      gridEl.innerHTML = items.map(buildCardHtml).join('');
      
      // Animate cards sequentially
      gsap.from('.gallery-card', {
        y: 40,
        opacity: 0,
        duration: 0.6,
        stagger: 0.1,
        ease: "power3.out"
      });
    }

    // Toggle CTA based on auth
    const user = await getUser();
    if (user) {
      uploadCta.innerHTML = `<a href="render.html" class="btn btn-primary">Publish New Design</a>`;
    }

  } catch (err) {
    loadingEl.style.display = 'none';
    showError("Failed to load gallery items: " + err.message);
  }
}

function buildCardHtml(item) {
  const dateStr = new Date(item.created_at).toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
  
  // Minimal escaped markup
  const title = encodeHtml(item.title || 'Untitled');
  const author = encodeHtml(item.author_name || 'Anonymous');
  const desc = encodeHtml(item.description || 'No description provided.');
  const imageHtml = item.thumbnail_url 
    ? `<img src="${item.thumbnail_url}" alt="${title}" class="gallery-card__image" loading="lazy" />`
    : `<div class="gallery-card__placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><line x1="12" y1="22" x2="12" y2="12"></line></svg>
       </div>`;

  return `
    <article class="gallery-card">
      <div class="gallery-card__image-wrap">
        ${imageHtml}
      </div>
      <div class="gallery-card__content">
        <h2 class="gallery-card__title">${title}</h2>
        <div class="gallery-card__author">
          <div class="gallery-card__author-avatar"></div>
          <span>${author}</span>
        </div>
        <p class="gallery-card__description">${desc}</p>
        <div class="gallery-card__footer">
          <span class="gallery-card__date">${dateStr}</span>
          <!-- In the future, this could load the design directly into the editor -->
          <a href="render.html?gallery_id=${item.id}" class="gallery-card__action">Open in Editor →</a>
        </div>
      </div>
    </article>
  `;
}

function encodeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function showError(msg) {
  loadingEl.style.display = 'none';
  gridEl.style.display = 'block';
  gridEl.innerHTML = `<div style="color:#f87171; text-align:center; padding:40px;">${msg}</div>`;
}

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderGallery();
});
