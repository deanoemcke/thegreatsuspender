/*global tgs, gsFavicon, gsStorage, gsSession, gsUtils, gsIndexedDb */
// eslint-disable-next-line no-unused-vars
var gsSuspendedTab = (function() {
  'use strict';

  async function initTab(tab, tabView, { quickInit }) {
    if (!tabView) {
      gsUtils.warning(
        tab.id,
        'Could not get internalTabView for suspended tab'
      );
    }
    const suspendedUrl = tab.url;

    // Set sessionId for subsequent checks
    tabView.document.sessionId = gsSession.getSessionId();

    // Set title
    let title = gsUtils.getSuspendedTitle(suspendedUrl);
    if (title.indexOf('<') >= 0) {
      // Encode any raw html tags that might be used in the title
      title = gsUtils.htmlEncode(title);
    }
    setTitle(tabView.document, title);

    // Set faviconMeta
    const faviconMeta = await gsFavicon.getFaviconMetaData(tab);
    setFaviconMeta(tabView.document, faviconMeta);

    if (quickInit) {
      return;
    }

    gsUtils.localiseHtml(tabView.document);

    const options = gsStorage.getSettings();
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);

    // Add event listeners
    setUnloadTabHandler(tabView.window, tab);
    setUnsuspendTabHandlers(tabView.document, tab);

    // Set imagePreview
    const previewMode = options[gsStorage.SCREEN_CAPTURE];
    const previewUri = await getPreviewUri(suspendedUrl);
    await toggleImagePreviewVisibility(
      tabView.document,
      tab,
      previewMode,
      previewUri
    );

    // Set theme
    const theme = options[gsStorage.THEME];
    const isLowContrastFavicon = faviconMeta.isDark;
    setTheme(tabView.document, theme, isLowContrastFavicon);

    // Set command
    const suspensionToggleHotkey = await tgs.getSuspensionToggleHotkey();
    setCommand(tabView.document, suspensionToggleHotkey);

    // Set url
    setUrl(tabView.document, originalUrl);

    // Set reason
    const suspendReasonInt = tgs.getTabStatePropForTabId(
      tab.id,
      tgs.STATE_SUSPEND_REASON
    );
    let suspendReason = null;
    if (suspendReasonInt === 3) {
      suspendReason = chrome.i18n.getMessage('js_suspended_low_memory');
    }
    setReason(tabView.document, suspendReason);

    // Show the view
    showContents(tabView.document);

    // Set scrollPosition (must come after showing page contents)
    const scrollPosition = gsUtils.getSuspendedScrollPosition(suspendedUrl);
    setScrollPosition(tabView.document, scrollPosition, previewMode);
    tgs.setTabStatePropForTabId(tab.id, tgs.STATE_SCROLL_POS, scrollPosition);
    // const allowlisted = gsUtils.checkAllowList(originalUrl);
  }

  function showNoConnectivityMessage(tabView) {
    if (!tabView.document.getElementById('disconnectedNotice')) {
      loadToastTemplate(tabView.document);
    }
    tabView.document.getElementById('disconnectedNotice').style.display =
      'none';
    setTimeout(function() {
      tabView.document.getElementById('disconnectedNotice').style.display =
        'block';
    }, 50);
  }

  function updateCommand(tabView, suspensionToggleHotkey) {
    setCommand(tabView.document, suspensionToggleHotkey);
  }

  function updateTheme(tabView, tab, theme, isLowContrastFavicon) {
    setTheme(tabView.document, theme, isLowContrastFavicon);
  }

  async function updatePreviewMode(tabView, tab, previewMode) {
    const previewUri = await getPreviewUri(tab.url);
    await toggleImagePreviewVisibility(
      tabView.document,
      tab,
      previewMode,
      previewUri
    );

    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    setScrollPosition(tabView.document, scrollPosition, previewMode);
  }

  function showContents(_document) {
    _document.querySelector('body').classList.remove('hide-initially');
  }

  function setScrollPosition(_document, scrollPosition, previewMode) {
    const scrollPosAsInt = (scrollPosition && parseInt(scrollPosition)) || 0;
    const scrollImagePreview = previewMode === '2';
    if (scrollImagePreview && scrollPosAsInt > 15) {
      const offsetScrollPosition = scrollPosAsInt + 151;
      _document.body.scrollTop = offsetScrollPosition;
      _document.documentElement.scrollTop = offsetScrollPosition;
    } else {
      _document.body.scrollTop = 0;
      _document.documentElement.scrollTop = 0;
    }
  }

  function setTitle(_document, title) {
    _document.title = title;
    _document.getElementById('gsTitle').innerHTML = title;
    _document.getElementById('gsTopBarTitle').innerHTML = title;
    // Prevent unsuspend by parent container
    // Using mousedown event otherwise click can still be triggered if
    // mouse is released outside of this element
    _document.getElementById('gsTopBarTitle').onmousedown = function(e) {
      e.stopPropagation();
    };
  }

  function setUrl(_document, url) {
    _document.getElementById('gsTopBarUrl').innerHTML = cleanUrl(url);
    _document.getElementById('gsTopBarUrl').setAttribute('href', url);
    _document.getElementById('gsTopBarUrl').onmousedown = function(e) {
      e.stopPropagation();
    };
  }

  function setFaviconMeta(_document, faviconMeta) {
    _document
      .getElementById('gsTopBarImg')
      .setAttribute('src', faviconMeta.normalisedDataUrl);
    _document
      .getElementById('gsFavicon')
      .setAttribute('href', faviconMeta.transparentDataUrl);
  }

  function setTheme(_document, theme, isLowContrastFavicon) {
    if (theme === 'dark') {
      _document.querySelector('body').classList.add('dark');
    } else {
      _document.querySelector('body').classList.remove('dark');
    }

    if (theme === 'dark' && isLowContrastFavicon) {
      _document
        .getElementById('faviconWrap')
        .classList.add('faviconWrapLowContrast');
    } else {
      _document
        .getElementById('faviconWrap')
        .classList.remove('faviconWrapLowContrast');
    }
  }

  function setReason(_document, reason) {
    let reasonMsgEl = _document.getElementById('reasonMsg');
    if (!reasonMsgEl) {
      reasonMsgEl = _document.createElement('div');
      reasonMsgEl.setAttribute('id', 'reasonMsg');
      reasonMsgEl.classList.add('reasonMsg');
      const containerEl = _document.getElementById('suspendedMsg-instr');
      containerEl.insertBefore(reasonMsgEl, containerEl.firstChild);
    }
    reasonMsgEl.innerHTML = reason;
  }

  async function getPreviewUri(suspendedUrl) {
    const originalUrl = gsUtils.getOriginalUrl(suspendedUrl);
    const preview = await gsIndexedDb.fetchPreviewImage(originalUrl);
    let previewUri = null;
    if (
      preview &&
      preview.img &&
      preview.img !== null &&
      preview.img !== 'data:,' &&
      preview.img.length > 10000
    ) {
      previewUri = preview.img;
    }
    return previewUri;
  }

  function buildImagePreview(_document, tab, previewUri) {
    return new Promise(resolve => {
      const previewEl = _document.createElement('div');
      const bodyEl = _document.getElementsByTagName('body')[0];
      previewEl.setAttribute('id', 'gsPreviewContainer');
      previewEl.classList.add('gsPreviewContainer');
      previewEl.innerHTML = _document.getElementById(
        'previewTemplate'
      ).innerHTML;
      const unsuspendTabHandler = buildUnsuspendTabHandler(_document, tab);
      previewEl.onclick = unsuspendTabHandler;
      gsUtils.localiseHtml(previewEl);
      bodyEl.appendChild(previewEl);

      const previewImgEl = _document.getElementById('gsPreviewImg');
      const onLoadedHandler = function() {
        previewImgEl.removeEventListener('load', onLoadedHandler);
        previewImgEl.removeEventListener('error', onLoadedHandler);
        resolve();
      };
      previewImgEl.setAttribute('src', previewUri);
      previewImgEl.addEventListener('load', onLoadedHandler);
      previewImgEl.addEventListener('error', onLoadedHandler);
    });
  }

  function addWatermarkHandler(_document) {
    _document.querySelector('.watermark').onclick = () => {
      chrome.tabs.create({ url: chrome.extension.getURL('about.html') });
    };
  }

  async function toggleImagePreviewVisibility(
    _document,
    tab,
    previewMode,
    previewUri
  ) {
    const builtImagePreview =
      _document.getElementById('gsPreviewContainer') !== null;
    if (
      !builtImagePreview &&
      previewUri &&
      previewMode &&
      previewMode !== '0'
    ) {
      await buildImagePreview(_document, tab, previewUri);
    } else {
      addWatermarkHandler(_document);
    }

    if (!_document.getElementById('gsPreviewContainer')) {
      return;
    }
    const overflow = previewMode === '2' ? 'auto' : 'hidden';
    _document.body.style['overflow'] = overflow;

    if (previewMode === '0' || !previewUri) {
      _document.getElementById('gsPreviewContainer').style.display = 'none';
      _document.getElementById('suspendedMsg').style.display = 'flex';
      _document.body.classList.remove('img-preview-mode');
    } else {
      _document.getElementById('gsPreviewContainer').style.display = 'block';
      _document.getElementById('suspendedMsg').style.display = 'none';
      _document.body.classList.add('img-preview-mode');
    }
  }

  function setCommand(_document, command) {
    const hotkeyEl = _document.getElementById('hotkeyWrapper');
    if (command) {
      hotkeyEl.innerHTML =
        '<span class="hotkeyCommand">(' + command + ')</span>';
    } else {
      const reloadString = chrome.i18n.getMessage(
        'js_suspended_hotkey_to_reload'
      );
      hotkeyEl.innerHTML = `<a id="setKeyboardShortcut" href="#">${reloadString}</a>`;
    }
  }

  function setUnloadTabHandler(_window, tab) {
    // beforeunload event will get fired if: the tab is refreshed, the url is changed,
    // the tab is closed, or the tab is frozen by chrome ??
    // when this happens the STATE_UNLOADED_URL gets set with the suspended tab url
    // if the tab is refreshed, then on reload the url will match and the tab will unsuspend
    // if the url is changed then on reload the url will not match
    // if the tab is closed, the reload will never occur
    _window.addEventListener('beforeunload', function(e) {
      gsUtils.log(tab.id, 'BeforeUnload triggered: ' + tab.url);
      if (tgs.isCurrentFocusedTab(tab)) {
        tgs.setTabStatePropForTabId(tab.id, tgs.STATE_UNLOADED_URL, tab.url);
      } else {
        gsUtils.log(
          tab.id,
          'Ignoring beforeUnload as tab is not currently focused.'
        );
      }
    });
  }

  function setUnsuspendTabHandlers(_document, tab) {
    const unsuspendTabHandler = buildUnsuspendTabHandler(_document, tab);
    _document.getElementById('gsTopBarUrl').onclick = unsuspendTabHandler;
    _document.getElementById('gsTopBar').onmousedown = unsuspendTabHandler;
    _document.getElementById('suspendedMsg').onclick = unsuspendTabHandler;
  }

  function buildUnsuspendTabHandler(_document, tab) {
    return function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.id === 'setKeyboardShortcut') {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      } else if (e.which === 1) {
        showUnsuspendAnimation(_document);
        tgs.unsuspendTab(tab);
      }
    };
  }

  function showUnsuspendAnimation(_document) {
    if (_document.body.classList.contains('img-preview-mode')) {
      _document.getElementById('refreshSpinner').classList.add('spinner');
    } else {
      _document.body.classList.add('waking');
      _document.getElementById('snoozyImg').src = chrome.extension.getURL(
        'img/snoozy_tab_awake.svg'
      );
      _document.getElementById('snoozySpinner').classList.add('spinner');
    }
  }

  function loadToastTemplate(_document) {
    const toastEl = _document.createElement('div');
    toastEl.setAttribute('id', 'disconnectedNotice');
    toastEl.classList.add('toast-wrapper');
    toastEl.innerHTML = _document.getElementById('toastTemplate').innerHTML;
    gsUtils.localiseHtml(toastEl);
    _document.getElementsByTagName('body')[0].appendChild(toastEl);
  }

  function cleanUrl(urlStr) {
    // remove scheme
    if (urlStr.indexOf('//') > 0) {
      urlStr = urlStr.substring(urlStr.indexOf('//') + 2);
    }
    // remove query string
    let match = urlStr.match(/\/?[?#]+/);
    if (match) {
      urlStr = urlStr.substring(0, match.index);
    }
    // remove trailing slash
    match = urlStr.match(/\/$/);
    if (match) {
      urlStr = urlStr.substring(0, match.index);
    }
    return urlStr;
  }

  return {
    initTab,
    showNoConnectivityMessage,
    updateCommand,
    updateTheme,
    updatePreviewMode,
  };
})();
