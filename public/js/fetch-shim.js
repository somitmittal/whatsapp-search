const _origFetch = window.fetch.bind(window);

export function initFetchShim() {
  window.fetch = async function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url);
    urlStr = urlStr != null ? String(urlStr) : '';
    const isOurApi = urlStr.startsWith('/api/') || (urlStr.includes('://') && urlStr.includes('/api/'));
    if (isOurApi) {
      init = init ? { ...init, credentials: init.credentials || 'include' } : { credentials: 'include' };
    }
    return _origFetch(input, init);
  };
}
