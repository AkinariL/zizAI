let siteFailed = false,
  sitePageLeaving = false,
  sitePageReloading = false;
addEventListener('pagehide', () => {
  if (sitePageLeaving) return;
  sitePageLeaving = true;
  const reason = Error('Page left');
  reason.code = 'SITE_PAGE_HIDDEN';
  try {
    stopMainAnimation(reason);
  } finally {
    comp?.dispose();
  }
});
addEventListener('pageshow', event => {
  if (event.persisted && sitePageLeaving && !sitePageReloading) {
    sitePageReloading = true;
    location.reload();
  }
});
function siteFatal(problem) {
  if (siteFailed || sitePageLeaving) return;
  siteFailed = true;
  const error = problem instanceof Error ? problem : Error(String(problem?.message || problem));
  stopMainAnimation(error);
  comp?.dispose();
  GPU_DIAG.failure = {
    message: error.message,
    time: Date.now(),
    route: 'render-worker + independent-generation-worker',
    fallbackURL: SITE_CONFIG.fallbackURL || null,
  };
  globalThis.__siteFailure = GPU_DIAG.failure;
  document.dispatchEvent(new CustomEvent('webgpu-render-failed', { detail: GPU_DIAG.failure }));
  const target = SITE_CONFIG.fallbackURL;
  if (target) {
    try {
      sessionStorage.setItem('webgpuFailure', JSON.stringify(GPU_DIAG.failure));
    } catch {}
    location.replace(new URL(target, location.href).href);
  } else {
    const cover = document.getElementById('cover');
    document.getElementById('loading')?.remove();
    if (cover) {
      cover.textContent = '画面を表示できません。';
      cover.style.opacity = '1';
      cover.style.pointerEvents = 'auto';
    }
    console.error('Renderer stopped:', error);
  }
}
