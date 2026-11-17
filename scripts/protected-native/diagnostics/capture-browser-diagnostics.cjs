'use strict';
const fs = require('node:fs');
const path = require('node:path');
const platform = process.env.ALTARA_BROWSER_DIAGNOSTIC_PLATFORM;
const directory = process.env.ALTARA_BROWSER_DIAGNOSTIC_LOG_DIR;
if (directory) {
  if (!['windows', 'linux'].includes(platform) || !/^(?:[1-9]|10)$/.test(process.env.ALTARA_BROWSER_DIAGNOSTIC_ATTEMPT || '')
    || path.resolve(directory) !== path.join(process.env.RUNNER_TEMP || '', `altara-protected-178-${platform}`, 'logs')) throw new Error('Protected diagnostic context required');
  const file = path.join(directory, `browser-${platform}-${process.env.ALTARA_BROWSER_DIAGNOSTIC_ATTEMPT}-${process.pid}.log`);
  let events = 0;
  const emit = data => {
    if (++events > 5000) return;
    try { fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...data }) + '\n', { mode: 0o600 }); }
    catch { /* Observation must not change the original browser result. */ }
  };
  const { chromium } = require(process.env.ALTARA_PLAYWRIGHT_MODULE || process.env.ALTARA_PTBR_PLAYWRIGHT || 'playwright');
  const launch = chromium.launch;
  chromium.launch = async function (...args) {
    const browser = await launch.apply(this, args), newPage = browser.newPage, close = browser.close;
    const pages = new Set(); let pageSequence = 0;
    browser.newPage = async function (...pageArgs) {
      const page = await newPage.apply(this, pageArgs), id = ++pageSequence;
      pages.add(page); let wait = 0, captured = 0;
      const installClicks = () => {
        const clicks = [];
        Object.defineProperty(window, '__altaraDiagnosticClicks', { value: clicks, configurable: true });
        document.addEventListener('click', event => {
          const el = event.target instanceof Element ? event.target.closest('button,[role=button]') : null;
          if (!el) return;
          clicks.push({ time: performance.now(), id: el.id, text: el.textContent?.trim().slice(0, 120), trusted: event.isTrusted, defaultPrevented: event.defaultPrevented });
          if (clicks.length > 20) clicks.shift();
        }, { capture: true, passive: true });
      };
      await page.addInitScript(installClicks);
      await page.evaluate(installClicks);
      const setContent = page.setContent;
      page.setContent = async function (...args) {
        const result = await setContent.apply(this, args);
        await page.evaluate(installClicks);
        return result;
      };
      const press = page.keyboard.press;
      page.keyboard.press = async function (key, ...args) {
        emit({ event: 'keyboard-request', page: id, key: String(key).slice(0, 80) });
        const result = await press.call(this, key, ...args);
        emit({ event: 'keyboard-complete', page: id, key: String(key).slice(0, 80) });
        return result;
      };
      async function capture(reason, screenshot = false) {
        if (page.isClosed() || ++captured > 10) return;
        try {
          const state = await page.evaluate(kind => {
            const pin = kind === 'windows' && location.href === 'about:blank' && window.state?.user?.id === 'synthetic-owner'
              && document.getElementById('opener')?.textContent === 'Abrir conversa de exemplo';
            const widget = kind === 'linux' && location.href === 'http://localhost/' && window.actor === '11111111-1111-4111-8111-111111111111'
              && typeof window.createWidgetMarketplace === 'function' && typeof window.createWidgetLibrary === 'function';
            if (!pin && !widget) return { syntheticFixture: false };
            const input = document.getElementById('appConfirmPasswordInput'), modal = document.getElementById('appConfirmModal');
            const options = window.appConfirmPromptOptions || {};
            const snapshot = { syntheticFixture: true, kind, readyState: document.readyState, visibility: document.visibilityState,
              activeElement: document.activeElement?.id, clicks: window.__altaraDiagnosticClicks || [] };
            if (pin) Object.assign(snapshot, { title: document.getElementById('appConfirmTitle')?.textContent,
              modalState: modal?.dataset.dmCodeState, modalHidden: modal?.classList.contains('hidden'),
              modalDOM: modal?.outerHTML.slice(0, 20_000), input: input ? { type: input.type, length: input.value.length, disabled: input.disabled,
                readOnly: input.readOnly, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
                matchesExpectedSyntheticPin: input.value === '001234', matchesRejectedSyntheticPin: input.value === '002345' } : null,
              result: typeof window.result === 'string' && /^\d+$/.test(window.result) ? `[numeric:${window.result.length}]` : window.result,
              created: window.created, finishCreateType: typeof window.finishCreate, resolverType: typeof window.appConfirmPromptResolver,
              promptOptions: { dmCodePending: options.dmCodePending, dmCodeCreation: options.dmCodeCreation,
                successFeedback: options.successFeedback, dmCodeAutoChecking: options.dmCodeAutoChecking,
                dmCodeAutoVersion: options.dmCodeAutoVersion, timerPresent: !!options.dmCodeTimer, autoTimerPresent: !!options.dmCodeAutoTimer },
              feedback: document.getElementById('appConfirmDmCodeFeedback')?.textContent?.slice(0, 512),
              buttons: Object.fromEntries(['btnAppConfirmOk', 'btnAppConfirmCancel', 'btnAppConfirmClose'].map(id => [id, document.getElementById(id)?.disabled])) });
            if (widget) {
              let ids = [], states = {};
              try {
                ids = typeof window.getWidgetMarketplaceController === 'function' ? window.getWidgetMarketplaceController().ids() : [];
                const library = window.createWidgetLibrary(localStorage, 'widgets-navigation-qa');
                states = Object.fromEntries(ids.map(id => { const value = library.readState(id); return [id, { count: value?.count, keys: Object.keys(value || {}) }]; }));
              } catch (error) { snapshot.stateReadError = String(error.message); }
              Object.assign(snapshot, { ids, states,
                dialogs: Array.from(document.querySelectorAll('dialog')).map(el => el.outerHTML.slice(0, 24_000)).slice(0, 3),
                widgetDOM: Array.from(document.querySelectorAll('[data-widget-id]')).map(el => ({ id: el.dataset.widgetId,
                  className: el.className, text: el.innerText.slice(0, 1200), iframeCount: el.querySelectorAll('iframe').length })).slice(0, 8) });
            }
            return snapshot;
          }, platform);
          emit({ event: 'browser-state', page: id, reason, state });
          if (!state.syntheticFixture) return;
          if (platform === 'linux') for (const [frameIndex, frame] of page.frames().entries()) {
            if (frame === page.mainFrame()) continue;
            try {
              const detail = await frame.evaluate(() => ({ readyState: document.readyState, text: document.body?.innerText.slice(0, 2500),
                outputs: Array.from(document.querySelectorAll('output')).map(el => el.textContent).slice(0, 8),
                status: document.getElementById('status')?.textContent, clicks: window.__altaraDiagnosticClicks || [] }));
              emit({ event: 'synthetic-frame-state', page: id, reason, frame: frameIndex, detail });
            } catch (error) { emit({ event: 'synthetic-frame-unavailable', page: id, reason, frame: frameIndex, message: String(error.message).slice(0, 1200) }); }
          }
          if (screenshot) {
            const png = await page.screenshot({ type: 'png', timeout: 5000 });
            if (png.length <= 2 * 1024 ** 2) emit({ event: 'synthetic-screenshot', page: id, reason, encoding: 'base64-png', data: png.toString('base64') });
          }
        } catch (error) { emit({ event: 'capture-unavailable', page: id, reason, message: String(error.message).slice(0, 2000) }); }
      }
      const originalWait = page.waitForFunction;
      page.waitForFunction = async function (...waitArgs) {
        const number = ++wait;
        const argument = typeof waitArgs[1] === 'string' ? waitArgs[1].slice(0, 200) : typeof waitArgs[1] === 'number' ? waitArgs[1] : undefined;
        emit({ event: 'wait-start', page: id, number, predicate: String(waitArgs[0]).slice(0, 3000), argument });
        try { const result = await originalWait.apply(this, waitArgs); emit({ event: 'wait-pass', page: id, number }); return result; }
        catch (error) {
          emit({ event: 'wait-failure', page: id, number, message: String(error.message), stack: String(error.stack || '') });
          await capture(`wait-${number}-failed`, true); throw error;
        }
      };
      page.on('pageerror', error => emit({ event: 'pageerror', page: id, message: error.message, stack: error.stack }));
      page.on('crash', () => emit({ event: 'page-crash', page: id }));
      page.__altaraDiagnosticCapture = capture;
      return page;
    };
    browser.close = async function (...args) {
      for (const page of pages) await page.__altaraDiagnosticCapture('before-browser-close');
      return close.apply(this, args);
    };
    return browser;
  };
}
