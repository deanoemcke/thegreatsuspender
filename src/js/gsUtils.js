/*global chrome, localStorage, gsStorage, gsChrome, gsMessages, gsSession, gsTabSuspendManager, gsTabDiscardManager, gsSuspendedTab, gsFavicon, tgs */
'use strict';

var debugInfo = false;
var debugError = false;

var gsUtils = {
  STATUS_NORMAL: 'normal',
  STATUS_LOADING: 'loading',
  STATUS_SPECIAL: 'special',
  STATUS_BLOCKED_FILE: 'blockedFile',
  STATUS_SUSPENDED: 'suspended',
  STATUS_DISCARDED: 'discarded',
  STATUS_NEVER: 'never',
  STATUS_FORMINPUT: 'formInput',
  STATUS_AUDIBLE: 'audible',
  STATUS_ACTIVE: 'active',
  STATUS_TEMPALLOWLIST: 'tempAllowlist',
  STATUS_PINNED: 'pinned',
  STATUS_ALLOWLISTED: 'allowlisted',
  STATUS_CHARGING: 'charging',
  STATUS_NOCONNECTIVITY: 'noConnectivity',
  STATUS_UNKNOWN: 'unknown',

  // eslint-disable-line no-unused-vars
  contains: function(array, value) {
    for (var i = 0; i < array.length; i++) {
      if (array[i] === value) return true;
    }
    return false;
  },

  dir: function(object) {
    if (debugInfo) {
      console.dir(object);
    }
  },
  log: function(id, text, ...args) {
    if (debugInfo) {
      args = args || [];
      console.log(id, (new Date() + '').split(' ')[4], text, ...args);
    }
  },
  warning: function(id, text, ...args) {
    if (debugError) {
      args = args || [];
      const ignores = ['Error', 'gsUtils', 'gsMessages'];
      const errorLine = gsUtils
        .getStackTrace()
        .split('\n')
        .filter(o => !ignores.find(p => o.indexOf(p) >= 0))
        .join('\n');
      args.push(`\n${errorLine}`);
      console.log(
        'WARNING:',
        id,
        (new Date() + '').split(' ')[4],
        text,
        ...args
      );
    }
  },
  errorIfInitialised: function(id, errorObj, ...args) {
    args = args || [];
    if (gsSession.isInitialising()) {
      gsUtils.warning(id, errorObj, args);
    } else {
      gsUtils.error(id, errorObj, args);
    }
  },
  error: function(id, errorObj, ...args) {
    if (errorObj === undefined) {
      errorObj = id;
      id = '?';
    }
    //NOTE: errorObj may be just a string :/
    if (debugError) {
      const stackTrace = errorObj.hasOwnProperty('stack')
        ? errorObj.stack
        : gsUtils.getStackTrace();
      const errorMessage = errorObj.hasOwnProperty('message')
        ? errorObj.message
        : typeof errorObj === 'string'
          ? errorObj
          : JSON.stringify(errorObj, null, 2);
      errorObj = errorObj || {};
      console.log(id, (new Date() + '').split(' ')[4], 'Error:');
      console.error(
        gsUtils.getPrintableError(errorMessage, stackTrace, ...args)
      );
    } else {
      // const logString = errorObj.hasOwnProperty('stack')
      //   ? errorObj.stack
      //   : `${JSON.stringify(errorObj)}\n${gsUtils.getStackTrace()}`;
      // gsAnalytics.reportException(logString, false);
    }
  },
  // Puts all the error args into a single printable string so that all the info
  // is displayed in chrome://extensions error console
  getPrintableError(errorMessage, stackTrace, ...args) {
    let errorString = errorMessage;
    errorString += `\n${args.map(o => JSON.stringify(o, null, 2)).join('\n')}`;
    errorString += `\n${stackTrace}`;
    return errorString;
  },
  getStackTrace: function() {
    var obj = {};
    Error.captureStackTrace(obj, gsUtils.getStackTrace);
    return obj.stack;
  },

  isDebugInfo: function() {
    return debugInfo;
  },

  isDebugError: function() {
    return debugError;
  },

  setDebugInfo: function(value) {
    debugInfo = value;
  },

  setDebugError: function(value) {
    debugError = value;
  },

  isDiscardedTab: function(tab) {
    return tab.discarded;
  },

  //tests for non-standard web pages. does not check for suspended pages!
  isSpecialTab: function(tab) {
    const url = tab.url || tab.pendingUrl;
    if (gsUtils.isSuspendedTab(tab, true)) {
      return false;
    }
    // Careful, suspended urls start with "chrome-extension://"
    if (
      url.indexOf('about') === 0 ||
      url.indexOf('chrome') === 0 ||
      // webstore urls no longer seem to crash the extension :D
      // url.indexOf('chrome.google.com/webstore') >= 0 ||
      gsUtils.isBlockedFileTab(tab)
    ) {
      return true;
    }
    return false;
  },

  isFileTab: function(tab) {
    const url = tab.url || tab.pendingUrl;
    if (url.indexOf('file') === 0) {
      return true;
    }
    return false;
  },

  //tests if the page is a file:// page AND the user has not enabled access to
  //file URLs in extension settings
  isBlockedFileTab: function(tab) {
    if (gsUtils.isFileTab(tab) && !gsSession.isFileUrlsAccessAllowed()) {
      return true;
    }
    return false;
  },

  //does not include suspended pages!
  isInternalTab: function(tab) {
    const url = tab.url || tab.pendingUrl;
    var isLocalExtensionPage =
      url.indexOf('chrome-extension://' + chrome.runtime.id) === 0;
    return isLocalExtensionPage && !gsUtils.isSuspendedTab(tab);
  },

  isProtectedPinnedTab: function(tab) {
    var dontSuspendPinned = gsStorage.getOption(gsStorage.IGNORE_PINNED);
    return dontSuspendPinned && tab.pinned;
  },

  isProtectedAudibleTab: function(tab) {
    var dontSuspendAudible = gsStorage.getOption(gsStorage.IGNORE_AUDIO);
    return dontSuspendAudible && tab.audible;
  },

  isProtectedActiveTab: function(tab) {
    var dontSuspendActiveTabs = gsStorage.getOption(
      gsStorage.IGNORE_ACTIVE_TABS
    );
    return (
      tgs.isCurrentFocusedTab(tab) || (dontSuspendActiveTabs && tab.active)
    );
  },

  // Note: Normal tabs may be in a discarded state
  isNormalTab: function(tab, excludeDiscarded) {
    excludeDiscarded = excludeDiscarded || false;
    return (
      !gsUtils.isSpecialTab(tab) &&
      !gsUtils.isSuspendedTab(tab, true) &&
      (!excludeDiscarded || !gsUtils.isDiscardedTab(tab))
    );
  },

  isSuspendedTab: function(tab, looseMatching) {
    const url = tab.url || tab.pendingUrl;
    return gsUtils.isSuspendedUrl(url, looseMatching);
  },

  isSuspendedUrl: function(url, looseMatching) {
    if (!url) {
      return false;
    } else if (looseMatching) {
      return url.indexOf('suspended.html') > 0;
    } else {
      return url.indexOf(chrome.extension.getURL('suspended.html')) === 0;
    }
  },

  shouldSuspendDiscardedTabs: function() {
    var suspendInPlaceOfDiscard = gsStorage.getOption(
      gsStorage.SUSPEND_IN_PLACE_OF_DISCARD
    );
    var discardInPlaceOfSuspend = gsStorage.getOption(
      gsStorage.DISCARD_IN_PLACE_OF_SUSPEND
    );
    return suspendInPlaceOfDiscard && !discardInPlaceOfSuspend;
  },

  removeTabsByUrlAsPromised: function(url) {
    return new Promise(async resolve => {
      const tabs = await gsChrome.tabsQuery({ url });
      chrome.tabs.remove(tabs.map(o => o.id), () => {
        resolve();
      });
    });
  },

  createTabAndWaitForFinishLoading: function(url, maxWaitTimeInMs) {
    return new Promise(async resolve => {
      let tab = await gsChrome.tabsCreate(url);
      maxWaitTimeInMs = maxWaitTimeInMs || 1000;
      const retryUntil = Date.now() + maxWaitTimeInMs;
      let loaded = false;
      while (!loaded && Date.now() < retryUntil) {
        tab = await gsChrome.tabsGet(tab.id);
        loaded = tab.status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
        }
      }
      resolve(tab);
    });
  },

  createWindowAndWaitForFinishLoading: function(createData, maxWaitTimeInMs) {
    return new Promise(async resolve => {
      let window = await gsChrome.windowsCreate(createData);
      maxWaitTimeInMs = maxWaitTimeInMs || 1000;
      const retryUntil = Date.now() + maxWaitTimeInMs;
      let loaded = false;
      while (!loaded && Date.now() < retryUntil) {
        window = await gsChrome.windowsGet(window.id);
        loaded = window.tabs.length > 0 && window.tabs[0].status === 'complete';
        if (!loaded) {
          await gsUtils.setTimeout(200);
        }
      }
      resolve(window);
    });
  },

  checkAllowList: function(url) {
    return gsUtils.checkSpecificAllowList(
      url,
      gsStorage.getOption(gsStorage.ALLOWLIST)
    );
  },

  checkSpecificAllowList: function(url, allowlistString) {
    var allowlistItems = allowlistString
        ? allowlistString.split(/[\s\n]+/)
        : [],
      allowlisted;

    allowlisted = allowlistItems.some(function(item) {
      return gsUtils.testForMatch(item, url);
    }, this);
    return allowlisted;
  },

  removeFromAllowlist: function(url) {
    var oldAllowlistString = gsStorage.getOption(gsStorage.ALLOWLIST) || '',
      allowlistItems = oldAllowlistString.split(/[\s\n]+/).sort(),
      i;

    for (i = allowlistItems.length - 1; i >= 0; i--) {
      if (gsUtils.testForMatch(allowlistItems[i], url)) {
        allowlistItems.splice(i, 1);
      }
    }
    var allowlistString = allowlistItems.join('\n');
    gsStorage.setOptionAndSync(gsStorage.ALLOWLIST, allowlistString);

    var key = gsStorage.ALLOWLIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldAllowlistString },
      { [key]: allowlistString }
    );
  },

  testForMatch: function(allowlistItem, word) {
    if (allowlistItem.length < 1) {
      return false;

      //test for regex ( must be of the form /foobar/ )
    } else if (
      allowlistItem.length > 2 &&
      allowlistItem.indexOf('/') === 0 &&
      allowlistItem.indexOf('/', allowlistItem.length - 1) !== -1
    ) {
      allowlistItem = allowlistItem.substring(1, allowlistItem.length - 1);
      try {
        new RegExp(allowlistItem); // eslint-disable-line no-new
      } catch (e) {
        return false;
      }
      return new RegExp(allowlistItem).test(word);

      // test as substring
    } else {
      return word.indexOf(allowlistItem) >= 0;
    }
  },

  saveToAllowlist: function(newString) {
    var oldAllowlistString = gsStorage.getOption(gsStorage.ALLOWLIST) || '';
    var newAllowlistString = oldAllowlistString + '\n' + newString;
    newAllowlistString = gsUtils.cleanupAllowlist(newAllowlistString);
    gsStorage.setOptionAndSync(gsStorage.ALLOWLIST, newAllowlistString);

    var key = gsStorage.ALLOWLIST;
    gsUtils.performPostSaveUpdates(
      [key],
      { [key]: oldAllowlistString },
      { [key]: newAllowlistString }
    );
  },

  cleanupAllowlist: function(allowlist) {
    var allowlistItems = allowlist ? allowlist.split(/[\s\n]+/).sort() : '',
      i,
      j;

    for (i = allowlistItems.length - 1; i >= 0; i--) {
      j = allowlistItems.lastIndexOf(allowlistItems[i]);
      if (j !== i) {
        allowlistItems.splice(i + 1, j - i);
      }
      if (!allowlistItems[i] || allowlistItems[i] === '') {
        allowlistItems.splice(i, 1);
      }
    }
    if (allowlistItems.length) {
      return allowlistItems.join('\n');
    } else {
      return allowlistItems;
    }
  },

  documentReadyAsPromsied: function(doc) {
    return new Promise(function(resolve) {
      if (doc.readyState !== 'loading') {
        resolve();
      } else {
        doc.addEventListener('DOMContentLoaded', function() {
          resolve();
        });
      }
    });
  },

  localiseHtml: function(parentEl) {
    var replaceTagFunc = function(match, p1) {
      return p1 ? chrome.i18n.getMessage(p1) : '';
    };
    for (let el of parentEl.getElementsByTagName('*')) {
      if (el.hasAttribute('data-i18n')) {
        el.innerHTML = el
          .getAttribute('data-i18n')
          .replace(/__MSG_(\w+)__/g, replaceTagFunc)
          .replace(/\n/g, '<br />');
      }
      if (el.hasAttribute('data-i18n-tooltip')) {
        el.setAttribute(
          'data-i18n-tooltip',
          el
            .getAttribute('data-i18n-tooltip')
            .replace(/__MSG_(\w+)__/g, replaceTagFunc)
        );
      }
    }
  },

  documentReadyAndLocalisedAsPromsied: async function(doc) {
    await gsUtils.documentReadyAsPromsied(doc);
    gsUtils.localiseHtml(doc);
    if (doc.body && doc.body.hidden) {
      doc.body.hidden = false;
    }
  },

  generateSuspendedUrl: function(url, title, scrollPos) {
    let encodedTitle = gsUtils.encodeString(title);
    var args =
      '#' +
      'ttl=' +
      encodedTitle +
      '&' +
      'pos=' +
      (scrollPos || '0') +
      '&' +
      'uri=' +
      url;

    return chrome.extension.getURL('suspended.html' + args);
  },

  getRootUrl: function(url, includePath, includeScheme) {
    let rootUrlStr = url;
    let scheme;

    // temporarily remove scheme
    if (rootUrlStr.indexOf('//') > 0) {
      scheme = rootUrlStr.substring(0, rootUrlStr.indexOf('//') + 2);
      rootUrlStr = rootUrlStr.substring(rootUrlStr.indexOf('//') + 2);
    }

    // remove path
    if (!includePath) {
      if (scheme === 'file://') {
        rootUrlStr = rootUrlStr.replace(new RegExp('/[^/]*$', 'g'), '');
      } else {
        const pathStartIndex =
          rootUrlStr.indexOf('/') > 0
            ? rootUrlStr.indexOf('/')
            : rootUrlStr.length;
        rootUrlStr = rootUrlStr.substring(0, pathStartIndex);
      }
    } else {
      // remove query string
      var match = rootUrlStr.match(/\/?[?#]+/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
      // remove trailing slash
      match = rootUrlStr.match(/\/$/);
      if (match) {
        rootUrlStr = rootUrlStr.substring(0, match.index);
      }
    }

    // readd scheme
    if (scheme && includeScheme) {
      rootUrlStr = scheme + rootUrlStr;
    }
    return rootUrlStr;
  },

  getHashVariable: function(key, urlStr) {
    var valuesByKey = {},
      keyPairRegEx = /^(.+)=(.+)/,
      hashStr;

    if (!urlStr || urlStr.length === 0 || urlStr.indexOf('#') === -1) {
      return false;
    }

    //extract hash component from url
    hashStr = urlStr.replace(/^[^#]+#+(.*)/, '$1');

    if (hashStr.length === 0) {
      return false;
    }

    //handle possible unencoded final var called 'uri'
    let uriIndex = hashStr.indexOf('uri=');
    if (uriIndex >= 0) {
      valuesByKey.uri = hashStr.substr(uriIndex + 4);
      hashStr = hashStr.substr(0, uriIndex);
    }

    hashStr.split('&').forEach(function(keyPair) {
      if (keyPair && keyPair.match(keyPairRegEx)) {
        valuesByKey[keyPair.replace(keyPairRegEx, '$1')] = keyPair.replace(
          keyPairRegEx,
          '$2'
        );
      }
    });
    return valuesByKey[key] || false;
  },
  getSuspendedTitle: function(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('ttl', urlStr) || '');
  },
  getSuspendedScrollPosition: function(urlStr) {
    return gsUtils.decodeString(gsUtils.getHashVariable('pos', urlStr) || '');
  },
  getOriginalUrl: function(urlStr) {
    return (
      gsUtils.getHashVariable('uri', urlStr) ||
      gsUtils.decodeString(gsUtils.getHashVariable('url', urlStr) || '')
    );
  },
  getCleanTabTitle: function(tab) {
    let cleanedTitle = gsUtils.decodeString(tab.title);
    if (
      !cleanedTitle ||
      cleanedTitle === '' ||
      cleanedTitle === gsUtils.decodeString(tab.url) ||
      cleanedTitle === 'Suspended Tab'
    ) {
      if (gsUtils.isSuspendedTab(tab)) {
        cleanedTitle =
          gsUtils.getSuspendedTitle(tab.url) || gsUtils.getOriginalUrl(tab.url);
      } else {
        cleanedTitle = tab.url;
      }
    }
    return cleanedTitle;
  },
  decodeString: function(string) {
    try {
      return decodeURIComponent(string);
    } catch (e) {
      return string;
    }
  },
  encodeString: function(string) {
    try {
      return encodeURIComponent(string);
    } catch (e) {
      return string;
    }
  },

  formatHotkeyString: function(hotkeyString) {
    return hotkeyString
      .replace(/Command/, '⌘')
      .replace(/[⌘\u2318]/, ' ⌘ ')
      .replace(/[⇧\u21E7]/, ' Shift ')
      .replace(/[⌃\u8963]/, ' Ctrl ')
      .replace(/[⌥\u8997]/, ' Option ')
      .replace(/\+/g, ' ')
      .replace(/ +/g, ' ')
      .trim()
      .replace(/[ ]/g, ' \u00B7 ');
  },

  getSuspendedTabCount: async function() {
    const currentTabs = await gsChrome.tabsQuery();
    const currentSuspendedTabs = currentTabs.filter(tab =>
      gsUtils.isSuspendedTab(tab)
    );
    return currentSuspendedTabs.length;
  },

  htmlEncode: function(text) {
    return document
      .createElement('pre')
      .appendChild(document.createTextNode(text)).parentNode.innerHTML;
  },

  getChromeVersion: function() {
    var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
    return raw ? parseInt(raw[2], 10) : false;
  },

  generateHashCode: function(text) {
    var hash = 0,
      i,
      chr,
      len;
    if (!text) return hash;
    for (i = 0, len = text.length; i < len; i++) {
      chr = text.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  },

  getAllExpiredTabs: function(callback) {
    var expiredTabs = [];
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        const timerDetails = tgs.getTabStatePropForTabId(
          tab.id,
          tgs.STATE_TIMER_DETAILS
        );
        if (
          timerDetails &&
          timerDetails.suspendDateTime &&
          new Date(timerDetails.suspendDateTime) < new Date()
        ) {
          expiredTabs.push(tab);
        }
      }
      callback(expiredTabs);
    });
  },

  performPostSaveUpdates: function(
    changedSettingKeys,
    oldValueBySettingKey,
    newValueBySettingKey
  ) {
    chrome.tabs.query({}, function(tabs) {
      tabs.forEach(function(tab) {
        if (gsUtils.isSpecialTab(tab)) {
          return;
        }

        if (gsUtils.isSuspendedTab(tab)) {
          //If toggling IGNORE_PINNED or IGNORE_ACTIVE_TABS to TRUE, then unsuspend any suspended pinned/active tabs
          if (
            (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) &&
              gsUtils.isProtectedPinnedTab(tab)) ||
            (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) &&
              gsUtils.isProtectedActiveTab(tab))
          ) {
            tgs.unsuspendTab(tab);
            return;
          }

          //if theme or screenshot preferences have changed then refresh suspended tabs
          const updateTheme = changedSettingKeys.includes(gsStorage.THEME);
          const updatePreviewMode = changedSettingKeys.includes(
            gsStorage.SCREEN_CAPTURE
          );
          if (updateTheme || updatePreviewMode) {
            const suspendedView = tgs.getInternalViewByTabId(tab.id);
            if (suspendedView) {
              if (updateTheme) {
                const theme = gsStorage.getOption(gsStorage.THEME);
                gsFavicon.getFaviconMetaData(tab).then(faviconMeta => {
                  const isLowContrastFavicon = faviconMeta.isDark || false;
                  gsSuspendedTab.updateTheme(
                    suspendedView,
                    tab,
                    theme,
                    isLowContrastFavicon
                  );
                });
              }
              if (updatePreviewMode) {
                const previewMode = gsStorage.getOption(
                  gsStorage.SCREEN_CAPTURE
                );
                gsSuspendedTab.updatePreviewMode(
                  suspendedView,
                  tab,
                  previewMode
                ); // async. unhandled promise.
              }
            }
          }

          //if discardAfterSuspend has changed then updated discarded tabs
          const updateDiscardAfterSuspend = changedSettingKeys.includes(
            gsStorage.DISCARD_AFTER_SUSPEND
          );
          if (
            updateDiscardAfterSuspend &&
            gsStorage.getOption(gsStorage.DISCARD_AFTER_SUSPEND) &&
            gsUtils.isSuspendedTab(tab) &&
            !gsUtils.isDiscardedTab(tab)
          ) {
            gsTabDiscardManager.queueTabForDiscard(tab);
          }
          return;
        }

        if (!gsUtils.isNormalTab(tab, true)) {
          return;
        }

        //update content scripts of normal tabs
        const updateIgnoreForms = changedSettingKeys.includes(
          gsStorage.IGNORE_FORMS
        );
        if (updateIgnoreForms) {
          gsMessages.sendUpdateToContentScriptOfTab(tab); //async. unhandled error
        }

        //update suspend timers
        const updateSuspendTime =
          changedSettingKeys.includes(gsStorage.SUSPEND_TIME) ||
          (changedSettingKeys.includes(gsStorage.IGNORE_ACTIVE_TABS) &&
            tab.active) ||
          (changedSettingKeys.includes(gsStorage.IGNORE_PINNED) &&
            !gsStorage.getOption(gsStorage.IGNORE_PINNED) &&
            tab.pinned) ||
          (changedSettingKeys.includes(gsStorage.IGNORE_AUDIO) &&
            !gsStorage.getOption(gsStorage.IGNORE_AUDIO) &&
            tab.audible) ||
          (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_OFFLINE) &&
            !gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) &&
            !navigator.onLine) ||
          (changedSettingKeys.includes(gsStorage.IGNORE_WHEN_CHARGING) &&
            !gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) &&
            tgs.isCharging()) ||
          (changedSettingKeys.includes(gsStorage.ALLOWLIST) &&
            (gsUtils.checkSpecificAllowList(
              tab.url,
              oldValueBySettingKey[gsStorage.ALLOWLIST]
            ) &&
              !gsUtils.checkSpecificAllowList(
                tab.url,
                newValueBySettingKey[gsStorage.ALLOWLIST]
              )));
        if (updateSuspendTime) {
          tgs.resetAutoSuspendTimerForTab(tab);
        }

        //if SuspendInPlaceOfDiscard has changed then updated discarded tabs
        const updateSuspendInPlaceOfDiscard = changedSettingKeys.includes(
          gsStorage.SUSPEND_IN_PLACE_OF_DISCARD
        );
        if (updateSuspendInPlaceOfDiscard && gsUtils.isDiscardedTab(tab)) {
          gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.
          //note: this may cause the tab to suspend
        }

        //if we aren't resetting the timer on this tab, then check to make sure it does not have an expired timer
        //should always be caught by tests above, but we'll check all tabs anyway just in case
        // if (!updateSuspendTime) {
        //     gsMessages.sendRequestInfoToContentScript(tab.id, function (err, tabInfo) { // unhandled error
        //         tgs.calculateTabStatus(tab, tabInfo, function (tabStatus) {
        //             if (tabStatus === STATUS_NORMAL && tabInfo && tabInfo.timerUp && (new Date(tabInfo.timerUp)) < new Date()) {
        //                 gsUtils.error(tab.id, 'Tab has an expired timer!', tabInfo);
        //                 gsMessages.sendUpdateToContentScriptOfTab(tab, true, false); // async. unhandled error
        //             }
        //         });
        //     });
        // }
      });
    });

    //if context menu has been disabled then remove from chrome
    if (gsUtils.contains(changedSettingKeys, gsStorage.ADD_CONTEXT)) {
      var addContextMenu = gsStorage.getOption(gsStorage.ADD_CONTEXT);
      tgs.buildContextMenu(addContextMenu);
    }

    //if screenshot preferences have changed then update the queue parameters
    if (
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE) ||
      gsUtils.contains(changedSettingKeys, gsStorage.SCREEN_CAPTURE_FORCE)
    ) {
      gsTabSuspendManager.initAsPromised(); //async. unhandled promise
    }
  },

  getWindowFromSession: function(windowId, session) {
    var window = false;
    session.windows.some(function(curWindow) {
      //leave this as a loose matching as sometimes it is comparing strings. other times ints
      if (curWindow.id == windowId) {
        // eslint-disable-line eqeqeq
        window = curWindow;
        return true;
      }
    });
    return window;
  },

  removeInternalUrlsFromSession: function(session) {
    if (!session || !session.windows) {
      return;
    }
    for (var i = session.windows.length - 1; i >= 0; i--) {
      var curWindow = session.windows[i];
      for (var j = curWindow.tabs.length - 1; j >= 0; j--) {
        var curTab = curWindow.tabs[j];
        if (gsUtils.isInternalTab(curTab)) {
          curWindow.tabs.splice(j, 1);
        }
      }
      if (curWindow.tabs.length === 0) {
        session.windows.splice(i, 1);
      }
    }
  },

  getSimpleDate: function(date) {
    var d = new Date(date);
    return (
      ('0' + d.getDate()).slice(-2) +
      '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) +
      '-' +
      d.getFullYear() +
      ' ' +
      ('0' + d.getHours()).slice(-2) +
      ':' +
      ('0' + d.getMinutes()).slice(-2)
    );
  },

  getHumanDate: function(date) {
    var monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ],
      d = new Date(date),
      currentDate = d.getDate(),
      currentMonth = d.getMonth(),
      currentYear = d.getFullYear(),
      currentHours = d.getHours(),
      currentMinutes = d.getMinutes();

    // var suffix;
    // if (currentDate === 1 || currentDate === 21 || currentDate === 31) {
    //     suffix = 'st';
    // } else if (currentDate === 2 || currentDate === 22) {
    //     suffix = 'nd';
    // } else if (currentDate === 3 || currentDate === 23) {
    //     suffix = 'rd';
    // } else {
    //     suffix = 'th';
    // }

    var ampm = currentHours >= 12 ? 'pm' : 'am';
    var hoursString = currentHours % 12 || 12;
    var minutesString = ('0' + currentMinutes).slice(-2);

    return (
      currentDate +
      ' ' +
      monthNames[currentMonth] +
      ' ' +
      currentYear +
      ' ' +
      hoursString +
      ':' +
      minutesString +
      ampm
    );
  },

  debounce: function(func, wait) {
    var timeout;
    return function() {
      var context = this,
        args = arguments;
      var later = function() {
        timeout = null;
        func.apply(context, args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  setTimeout: async function(timeout) {
    return new Promise(resolve => {
      window.setTimeout(resolve, timeout);
    });
  },

  executeWithRetries: async function(
    promiseFn,
    fnArgsArray,
    maxRetries,
    retryWaitTime
  ) {
    const retryFn = async retries => {
      try {
        return await promiseFn(...fnArgsArray);
      } catch (e) {
        if (retries >= maxRetries) {
          gsUtils.warning('gsUtils', 'Max retries exceeded');
          return Promise.reject(e);
        }
        retries += 1;
        await gsUtils.setTimeout(retryWaitTime);
        return await retryFn(retries);
      }
    };
    const result = await retryFn(0);
    return result;
  },
};
