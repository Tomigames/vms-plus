// VMS+ background script.
// It opens tabs behind the current one, so the dashboard stays in front: email drafts (Gmail or Outlook on the web),
// and VMS's QR code page. A page cannot open a tab in the background by itself; an extension's background script can.

// The only places a draft may open: Gmail and Outlook on the web, at their compose pages.
const COMPOSE = [
  /^https:\/\/mail\.google\.com\/mail\/u\/\d+\/\?view=cm&/,
  /^https:\/\/mail\.google\.com\/mail\/\?authuser=[^&#]+&view=cm&/,
  /^https:\/\/outlook\.office\.com\/mail\/deeplink\/compose\?/,
  /^https:\/\/outlook\.live\.com\/mail\/0\/deeplink\/compose\?/,
];

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // Open a VMS page (the QR code page) behind the current tab.
  if (msg && msg.type === 'vc-open' && typeof msg.url === 'string' && msg.url.startsWith('https://my.firstinspires.org/VMS/')) {
    const where = { url: msg.url, active: false };
    if (sender.tab) { where.index = sender.tab.index + 1; where.windowId = sender.tab.windowId; }
    chrome.tabs.create(where, () => respond({ ok: !chrome.runtime.lastError }));
    return true;
  }
  if (!msg || msg.type !== 'vc-draft') return false;
  let url = '';
  if (typeof msg.url === 'string' && COMPOSE.some((re) => re.test(msg.url))) url = msg.url;
  // Older dashboards send a mailto: link; open it in Gmail as before.
  else if (typeof msg.mailto === 'string' && msg.mailto.startsWith('mailto:')) url = 'https://mail.google.com/mail/?extsrc=mailto&url=' + encodeURIComponent(msg.mailto);
  if (!url) return false;
  const where = { url, active: false };
  // When several drafts are opened in a row, `offset` keeps their tabs in the order they were asked for.
  const offset = Number.isInteger(msg.offset) && msg.offset >= 0 ? msg.offset : 0;
  if (sender.tab) { where.index = sender.tab.index + 1 + offset; where.windowId = sender.tab.windowId; }
  chrome.tabs.create(where, () => respond({ ok: !chrome.runtime.lastError }));
  return true; // the reply is sent after the tab has been created
});
