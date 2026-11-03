// Thin promise wrapper over runtime messaging, shared by the popup and dashboard.

export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from background worker'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response.data);
    });
  });
}

/** Human-readable gap, e.g. "23 days ago". */
export function ago(timestamp) {
  if (!timestamp) return 'never';
  return duration(Date.now() - timestamp) + ' ago';
}

export function duration(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = (days / 365).toFixed(1);
  return `${years} years`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Build a DOM element. Text is always set via textContent — never innerHTML. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export const KIND_LABELS = {
  endpoint: 'endpoint',
  route: 'route',
  flag: 'flag',
  role: 'role',
  gqlop: 'graphql',
};
