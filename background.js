// VMS+ background script.
// It opens tabs behind the current one, so the dashboard stays in front: reminder drafts in Gmail, and VMS's QR code page.
// A page cannot open a tab in the background by itself; an extension's background script can.

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // Open a VMS page (the QR code page) behind the current tab.
  if (msg && msg.type === 'vc-open' && typeof msg.url === 'string' && msg.url.startsWith('https://my.firstinspires.org/VMS/')) {
    const where = { url: msg.url, active: false };
    if (sender.tab) { where.index = sender.tab.index + 1; where.windowId = sender.tab.windowId; }
    chrome.tabs.create(where, () => respond({ ok: !chrome.runtime.lastError }));
    return true;
  }
  if (!msg || msg.type !== 'vc-draft' || typeof msg.mailto !== 'string' || !msg.mailto.startsWith('mailto:')) return false;
  // The same address Chrome uses when Gmail is set as the handler for email links.
  const url = 'https://mail.google.com/mail/?extsrc=mailto&url=' + encodeURIComponent(msg.mailto);
  const where = { url, active: false };
  // When several drafts are opened in a row, `offset` keeps their tabs in the order they were asked for.
  const offset = Number.isInteger(msg.offset) && msg.offset >= 0 ? msg.offset : 0;
  if (sender.tab) { where.index = sender.tab.index + 1 + offset; where.windowId = sender.tab.windowId; }
  chrome.tabs.create(where, () => respond({ ok: !chrome.runtime.lastError }));
  return true; // the reply is sent after the tab has been created
});
