/*global html2canvas, domtoimage, tgs, gsFavicon, gsMessages, gsStorage, gsUtils, gsChrome, gsIndexedDb, gsTabDiscardManager, gsTabCheckManager, GsTabQueue */
// eslint-disable-next-line no-unused-vars
var gsTabSuspendManager = (function() {
  'use strict';

  const DEFAULT_CONCURRENT_SUSPENSIONS = 3;
  const DEFAULT_SUSPENSION_TIMEOUT = 60 * 1000;

  const QUEUE_ID = 'suspendQueue';

  let _suspensionQueue;

  function initAsPromised() {
    return new Promise(async function(resolve) {
      const screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
      const forceScreenCapture = gsStorage.getOption(
        gsStorage.SCREEN_CAPTURE_FORCE
      );
      //TODO: This should probably update when the screencapture mode changes
      const concurrentSuspensions =
        screenCaptureMode === '0' ? 5 : DEFAULT_CONCURRENT_SUSPENSIONS;
      const suspensionTimeout = forceScreenCapture
        ? 5 * 60 * 1000
        : DEFAULT_SUSPENSION_TIMEOUT;
      const queueProps = {
        concurrentExecutors: concurrentSuspensions,
        jobTimeout: suspensionTimeout,
        executorFn: performSuspension,
        exceptionFn: handleSuspensionException,
      };
      _suspensionQueue = GsTabQueue('suspensionQueue', queueProps);
      gsUtils.log(QUEUE_ID, 'init successful');
      resolve();
    });
  }

  function queueTabForSuspension(tab, forceLevel) {
    queueTabForSuspensionAsPromise(tab, forceLevel).catch(e => {
      gsUtils.log(tab.id, QUEUE_ID, e);
    });
  }

  function queueTabForSuspensionAsPromise(tab, forceLevel) {
    if (typeof tab === 'undefined') return Promise.resolve();

    if (!checkTabEligibilityForSuspension(tab, forceLevel)) {
      gsUtils.log(tab.id, QUEUE_ID, 'Tab not eligible for suspension.');
      return Promise.resolve();
    }

    gsUtils.log(tab.id, QUEUE_ID, 'Queueing tab for suspension.');
    return _suspensionQueue.queueTabAsPromise(tab, { forceLevel });
  }

  function unqueueTabForSuspension(tab) {
    const removed = _suspensionQueue.unqueueTab(tab);
    if (removed) {
      gsUtils.log(tab.id, QUEUE_ID, 'Removed tab from suspension queue.');
    }
  }

  async function performSuspension(
    tab,
    executionProps,
    resolve,
    reject,
    requeue
  ) {
    if (executionProps.refetchTab || gsUtils.isSuspendedTab(tab)) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab refetch required. Getting updated tab..'
      );
      const _tab = await gsChrome.tabsGet(tab.id);
      if (!_tab) {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Could not find tab with id. Will ignore suspension request'
        );
        resolve(false);
        return;
      }
      tab = _tab;
    }

    if (gsUtils.isSuspendedTab(tab)) {
      if (!executionProps.refetchTab) {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Tab is already suspended. Will check again in 3 seconds'
        );
        requeue(3000, { refetchTab: true });
      } else {
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Tab still suspended after 3 seconds. Will ignore tab suspension request'
        );
        resolve(false);
      }
      return;
    }

    // If tab is in loading state, try to suspend early if possible
    // Note: doing so will bypass a few checks below. Namely:
    // - Any temporary pause flag that has been set up on the tab
    // - It may lose any scrollPos value
    // Although if the tab is still loading then pause and scroll pos should
    // not be set?
    // Do not bypass loading state if screen capture is required
    let screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    if (tab.status === 'loading') {
      const savedTabInfo = await gsIndexedDb.fetchTabInfo(tab.url);
      if (screenCaptureMode === '0' && savedTabInfo) {
        const suspendedUrl = gsUtils.generateSuspendedUrl(
          tab.url,
          savedTabInfo.title,
          0
        );
        gsUtils.log(
          tab.id,
          QUEUE_ID,
          'Interrupting tab loading to resuspend tab'
        );
        const success = await executeTabSuspension(tab, suspendedUrl);
        resolve(success);
      } else {
        requeue(3000, { refetchTab: true });
      }
      return;
    }

    const discardInPlaceOfSuspend = gsStorage.getOption(
      gsStorage.DISCARD_IN_PLACE_OF_SUSPEND
    );
    if (discardInPlaceOfSuspend) {
      screenCaptureMode = '0';
    }

    let tabInfo = await getContentScriptTabInfo(tab);

    // If tabInfo is null this is usually due to tab loading, being discarded or 'parked' on chrome restart
    // If we need to make a screen capture and tab is not responding then reload it
    // TODO: This doesn't actually seem to work
    // Tabs that have just been reloaded usually fail to run the screen capture script :(
    if (!tabInfo && screenCaptureMode !== '0' && !executionProps.reloaded) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab is not responding. Will reload for screen capture.'
      );
      await gsChrome.tabsUpdate(tab.id, { url: tab.url });
      // allow up to 30 seconds for tab to reload and trigger its subsequent suspension request
      // note that this will not reset the DEFAULT_SUSPENSION_TIMEOUT of 60 seconds
      requeue(30000, { reloaded: true });
      return;
    }

    tabInfo = tabInfo || {
      status: 'unknown',
      scrollPos: '0',
    };

    const isEligible = checkContentScriptEligibilityForSuspension(
      tabInfo.status,
      executionProps.forceLevel
    );
    if (!isEligible) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        `Content script status of ${
          tabInfo.status
        } not eligible for suspension. Removing tab from suspensionQueue.`
      );
      resolve(false);
      return;
    }

    // Temporarily change tab.url to append youtube timestamp
    const timestampedUrl = await generateUrlWithYouTubeTimestamp(tab);
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;
    await saveSuspendData(tab);

    const suspendedUrl = gsUtils.generateSuspendedUrl(
      tab.url,
      tab.title,
      tabInfo.scrollPos
    );
    executionProps.suspendedUrl = suspendedUrl;

    if (screenCaptureMode === '0') {
      const success = await executeTabSuspension(tab, suspendedUrl);
      resolve(success);
      return;
    }

    // Hack. Save handle to resolve function so we can call it later
    executionProps.resolveFn = resolve;
    requestGeneratePreviewImage(tab); //async
    gsUtils.log(
      tab.id,
      QUEUE_ID,
      'Preview generation script started successfully.'
    );
    // handlePreviewImageResponse is called on the 'savePreviewData' message response
    // this will refetch the queued tabDetails and call executionProps.resolveFn(true)
  }

  async function handlePreviewImageResponse(tab, previewUrl, errorMsg) {
    const queuedTabDetails = getQueuedTabDetails(tab);
    if (!queuedTabDetails) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab missing from suspensionQueue. Assuming suspension cancelled for this tab.'
      );
      return;
    }

    const suspensionForceLevel = queuedTabDetails.executionProps.forceLevel;
    if (!checkTabEligibilityForSuspension(tab, suspensionForceLevel)) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        'Tab is no longer eligible for suspension. Removing tab from suspensionQueue.'
      );
      return;
    }

    // Temporarily change tab.url with that from the generated suspended url
    // This is because for youtube tabs we manually change the url to persist timestamp
    const timestampedUrl = gsUtils.getOriginalUrl(
      queuedTabDetails.executionProps.suspendedUrl
    );
    // NOTE: This does not actually change the tab url, just the current tab object
    tab.url = timestampedUrl;

    if (!previewUrl) {
      gsUtils.warning(
        tab.id,
        QUEUE_ID,
        'savePreviewData reported an error: ',
        errorMsg
      );
    } else {
      await gsIndexedDb.addPreviewImage(tab.url, previewUrl);
    }

    const success = await executeTabSuspension(
      tab,
      queuedTabDetails.executionProps.suspendedUrl
    );
    queuedTabDetails.executionProps.resolveFn(success);
  }

  function getQueuedTabDetails(tab) {
    return _suspensionQueue.getQueuedTabDetails(tab);
  }

  async function handleSuspensionException(
    tab,
    executionProps,
    exceptionType,
    resolve,
    reject,
    requeue
  ) {
    if (exceptionType === _suspensionQueue.EXCEPTION_TIMEOUT) {
      gsUtils.log(
        tab.id,
        QUEUE_ID,
        `Tab took more than ${
          _suspensionQueue.getQueueProperties().jobTimeout
        }ms to suspend. Will force suspension.`
      );
      const success = await executeTabSuspension(
        tab,
        executionProps.suspendedUrl
      );
      resolve(success);
    } else {
      gsUtils.warning(
        tab.id,
        QUEUE_ID,
        `Failed to suspend tab: ${exceptionType}`
      );
      resolve(false);
    }
  }

  function executeTabSuspension(tab, suspendedUrl) {
    return new Promise(resolve => {
      // Remove any existing queued tab checks (this can happen if we try to suspend
      // a tab immediately after it gains focus)
      gsTabCheckManager.unqueueTabCheck(tab);

      // If we want tabs to be discarded instead of suspending them
      let discardInPlaceOfSuspend = gsStorage.getOption(
        gsStorage.DISCARD_IN_PLACE_OF_SUSPEND
      );
      if (discardInPlaceOfSuspend) {
        tgs.clearAutoSuspendTimerForTabId(tab.id);
        gsTabDiscardManager.queueTabForDiscard(tab);
        resolve(true);
        return;
      }

      if (gsUtils.isSuspendedTab(tab, true)) {
        gsUtils.log(tab.id, 'Tab already suspended');
        resolve(false);
        return;
      }

      if (!suspendedUrl) {
        gsUtils.log(tab.id, 'executionProps.suspendedUrl not set!');
        suspendedUrl = gsUtils.generateSuspendedUrl(tab.url, tab.title, 0);
      }

      gsUtils.log(tab.id, 'Suspending tab');
      tgs.setTabStatePropForTabId(
        tab.id,
        tgs.STATE_INITIALISE_SUSPENDED_TAB,
        true
      );
      gsChrome.tabsUpdate(tab.id, { url: suspendedUrl }).then(updatedTab => {
        resolve(updatedTab !== null);
      });
    });
  }

  // forceLevel indicates which users preferences to respect when attempting to suspend the tab
  // 1: Suspend if at all possible
  // 2: Respect allowlist, temporary allowlist, form input, pinned tabs, audible preferences, and exclude current active tab
  // 3: Same as above (2), plus also respect internet connectivity, running on battery, and time to suspend=never preferences.
  function checkTabEligibilityForSuspension(tab, forceLevel) {
    if (forceLevel >= 1) {
      // if (gsUtils.isSuspendedTab(tab, true) || gsUtils.isSpecialTab(tab)) {
      // actually allow suspended tabs to attempt suspension in case they are
      // in the process of being reloaded and we have changed our mind and
      // want to suspend them again.
      if (gsUtils.isSpecialTab(tab)) {
        return false;
      }
    }
    if (forceLevel >= 2) {
      if (
        gsUtils.isProtectedActiveTab(tab) ||
        gsUtils.checkAllowList(tab.url) ||
        gsUtils.isProtectedPinnedTab(tab) ||
        gsUtils.isProtectedAudibleTab(tab)
      ) {
        return false;
      }
    }
    if (forceLevel >= 3) {
      if (
        gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) &&
        !navigator.onLine
      ) {
        return false;
      }
      if (
        gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) &&
        tgs.isCharging()
      ) {
        return false;
      }
      if (gsStorage.getOption(gsStorage.SUSPEND_TIME) === '0') {
        return false;
      }
    }
    return true;
  }

  function checkContentScriptEligibilityForSuspension(
    contentScriptStatus,
    forceLevel
  ) {
    if (
      forceLevel >= 2 &&
      (contentScriptStatus === gsUtils.STATUS_FORMINPUT ||
        contentScriptStatus === gsUtils.STATUS_TEMPALLOWLIST)
    ) {
      return false;
    }
    return true;
  }

  function getContentScriptTabInfo(tab) {
    return new Promise(resolve => {
      gsMessages.sendRequestInfoToContentScript(tab.id, (error, tabInfo) => {
        //TODO: Should we wait here for the tab to load? Doesnt seem to matter..
        if (error) {
          gsUtils.warning(
            tab.id,
            QUEUE_ID,
            'Failed to get content script info',
            error
          );
          // continue here but will lose information about scroll position,
          // temp allowlist, and form input
        }
        resolve(tabInfo);
      });
    });
  }

  function generateUrlWithYouTubeTimestamp(tab) {
    return new Promise(resolve => {
      if (tab.url.indexOf('https://www.youtube.com/watch') < 0) {
        resolve(tab.url);
        return;
      }

      gsMessages.executeCodeOnTab(
        tab.id,
        `(${fetchYouTubeTimestampContentScript})();`,
        (error, response) => {
          if (error) {
            gsUtils.warning(
              tab.id,
              QUEUE_ID,
              'Failed to fetch YouTube timestamp',
              error
            );
          }
          if (!response) {
            resolve(tab.url);
            return;
          }

          const timestamp = response;
          const youTubeUrl = new URL(tab.url);
          youTubeUrl.searchParams.set('t', timestamp + 's');
          resolve(youTubeUrl.href);
        }
      );
    });
  }

  function fetchYouTubeTimestampContentScript() {
    const videoEl = document.querySelector(
      'video.video-stream.html5-main-video'
    );
    const timestamp = videoEl ? videoEl.currentTime >> 0 : 0;
    return timestamp;
  }

  async function saveSuspendData(tab) {
    const tabProperties = {
      date: new Date(),
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned,
      index: tab.index,
      windowId: tab.windowId,
    };
    await gsIndexedDb.addSuspendedTabInfo(tabProperties);

    const faviconMeta = await gsFavicon.buildFaviconMetaFromChromeFaviconCache(
      tab.url
    );
    if (faviconMeta) {
      await gsFavicon.saveFaviconMetaDataToCache(tab.url, faviconMeta);
    }
  }

  function requestGeneratePreviewImage(tab) {
    // Will not implement this for now as it does not actually capture the whole
    // screen, just the visible area
    // NOTE: It also requires the <all_urls> manifest permission
    // if (tab.active) {
    //   chrome.tabs.captureVisibleTab(
    //     tab.windowId,
    //     { format: 'png' },
    //     dataUrl => {
    //       handlePreviewImageResponse(tab, dataUrl, chrome.runtime.lastError);
    //     }
    //   ); //async. unhandled promise.
    //   return;
    // }

    const screenCaptureMode = gsStorage.getOption(gsStorage.SCREEN_CAPTURE);
    const forceScreenCapture = gsStorage.getOption(
      gsStorage.SCREEN_CAPTURE_FORCE
    );
    const useAlternateScreenCaptureLib = gsStorage.getOption(
      gsStorage.USE_ALT_SCREEN_CAPTURE_LIB
    );
    const screenCaptureLib = useAlternateScreenCaptureLib
      ? 'js/dom-to-image.js'
      : 'js/html2canvas.min.js';
    gsUtils.log(
      tab.id,
      QUEUE_ID,
      `Injecting ${screenCaptureLib} into content script`
    );
    gsMessages.executeScriptOnTab(tab.id, screenCaptureLib, error => {
      if (error) {
        handlePreviewImageResponse(tab, null, 'Failed to executeScriptOnTab'); //async. unhandled promise.
        return;
      }
      gsMessages.executeCodeOnTab(
        tab.id,
        `(${generatePreviewImageCanvasViaContentScript})("${screenCaptureMode}", ${forceScreenCapture}, ${useAlternateScreenCaptureLib});`,
        error => {
          if (error) {
            handlePreviewImageResponse(
              tab,
              null,
              'Failed to executeCodeOnTab: generatePreviewImgContentScript'
            ); //async. unhandled promise.
            return;
          }
        }
      );
    });
  }

  // NOTE: This function below is run within the content script scope
  // Therefore it must be self contained and not refer to any external functions
  // such as references to gsUtils etc.
  // eslint-disable-next-line no-unused-vars
  async function generatePreviewImageCanvasViaContentScript(
    screenCaptureMode,
    forceScreenCapture,
    useAlternateScreenCaptureLib
  ) {
    const MAX_CANVAS_HEIGHT = forceScreenCapture ? 10000 : 5000;
    const IMAGE_TYPE = 'image/webp';
    const IMAGE_QUALITY = forceScreenCapture ? 0.92 : 0.5;

    let height = 0;
    let width = 0;

    //check where we need to capture the whole screen
    if (screenCaptureMode === '2') {
      height = Math.max(
        window.innerHeight,
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
      );
      // cap the max height otherwise it fails to convert to a data url
      height = Math.min(height, MAX_CANVAS_HEIGHT);
    } else {
      height = window.innerHeight;
    }
    width = document.body.clientWidth;

    let generateCanvas;
    if (useAlternateScreenCaptureLib) {
      // console.log('Generating via dom-to-image..');
      generateCanvas = () => {
        return domtoimage.toCanvas(document.body, {width: width, height: height}).then(canvas => {
          const croppedCanvas = document.createElement('canvas');
          const context = croppedCanvas.getContext('2d');
          croppedCanvas.width = width;
          croppedCanvas.height = height;
          context.drawImage(canvas, 0, 0);
          return croppedCanvas;
        });
      };
    } else {
      // console.log('Generating via html2canvas..');
      generateCanvas = () => {
        return html2canvas(document.body, {
          height: height,
          width: width,
          logging: false,
          imageTimeout: 10000,
          removeContainer: false,
          async: true,
        });
      };
    }

    const isCanvasVisible = canvas => {
      var ctx = canvas.getContext('2d');
      var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < imageData.data.length; i += 4) {
        const isTransparent = imageData.data[i + 3] === 0;
        const isWhite =
          imageData.data[i] === 255 &&
          imageData.data[i + 1] === 255 &&
          imageData.data[i + 2] === 255;
        if (!isTransparent && !isWhite) {
          return true;
        }
      }
      return false;
    };

    const generateDataUrl = canvas => {
      let dataUrl = canvas.toDataURL(IMAGE_TYPE, IMAGE_QUALITY);
      if (!dataUrl || dataUrl === 'data:,') {
        dataUrl = canvas.toDataURL();
      }
      if (dataUrl === 'data:,') {
        dataUrl = null;
      }
      return dataUrl;
    };

    let dataUrl;
    let errorMsg;
    try {
      const canvas = await generateCanvas();
      if (!isCanvasVisible(canvas)) {
        errorMsg = 'Canvas contains no visible pixels';
      } else {
        dataUrl = generateDataUrl(canvas);
      }
    } catch (err) {
      errorMsg = err.message;
    }
    if (!dataUrl && !errorMsg) {
      errorMsg = 'Failed to generate dataUrl';
    }
    // console.log('saving previewData..');
    chrome.runtime.sendMessage({
      action: 'savePreviewData',
      previewUrl: dataUrl,
      errorMsg: errorMsg,
    });
  }

  return {
    initAsPromised,
    queueTabForSuspension,
    queueTabForSuspensionAsPromise,
    unqueueTabForSuspension,
    handlePreviewImageResponse,
    saveSuspendData,
    checkTabEligibilityForSuspension,
    executeTabSuspension,
    getQueuedTabDetails,
  };
})();
