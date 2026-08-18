/*
 * Gopeed extension for Xunlei Cloud Drive shares.
 *
 * The share API needs a short-lived captcha token. The token is generated
 * locally from a per-installation device id and is never written to disk.
 */

var API_BASE = 'https://api-pan.xunlei.com/drive/v1';
var CAPTCHA_API = 'https://xluser-ssl.xunlei.com/v1/shield/captcha/init';
var CLIENT_ID = 'Xqp0kJBXWhwaTpB6';
var CLIENT_VERSION = '1.92.89';
var DEVICE_STORAGE_KEY = 'xunlei.deviceId';
var COOKIE_STORAGE_KEY = 'xunlei.cookie';
var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var MAX_FILES = 10000;
var MAX_PAGES_PER_FOLDER = 100;
var MAX_RESTORE_POLL = 120;
var PAGE_SIZE = 100;
// The web client sends an empty parent_id for the root of "我的云盘".
// The UI displays that root as id "0", but the restore API treats "0" as
// a real file/folder id and returns file_not_found.
var RESTORE_PARENT_ID = '';
var CLEANUP_LABEL = 'xunlei.cleanup.ids';

function setting(name, fallback) {
  try {
    var value = gopeed.settings[name];
    return value === undefined || value === null || value === '' ? fallback : String(value);
  } catch (e) {
    return fallback;
  }
}

function isSettingEnabled(name) {
  return /^(1|true|yes|on)$/i.test(setting(name, ''));
}

function storageGet(key) {
  try {
    return gopeed.storage.get(key) || '';
  } catch (e) {
    return '';
  }
}

function storageSet(key, value) {
  try {
    gopeed.storage.set(key, value);
  } catch (e) {
    // Storage is only an optimization. Resolution can continue without it.
  }
}

function randomHex(length) {
  var value = '';
  var seed = String(Date.now()) + ':' + String(Math.random());
  while (value.length < length) {
    seed = seed + ':' + String(Math.random());
    var part = md5(seed);
    value += part;
  }
  return value.substring(0, length);
}

function getDeviceId() {
  var id = storageGet(DEVICE_STORAGE_KEY);
  if (/^[a-f0-9]{32}$/i.test(id)) {
    return id;
  }
  id = randomHex(32);
  storageSet(DEVICE_STORAGE_KEY, id);
  return id;
}

function parseShareUrl(rawUrl) {
  var parsed = new URL(rawUrl);
  var parts = parsed.pathname.split('/').filter(function (part) {
    return part !== '';
  });
  if (parts.length < 2 || parts[0] !== 's' || !parts[1]) {
    throw new MessageError('无法识别迅雷云盘分享链接。');
  }

  return {
    shareId: decodeURIComponent(parts[1]),
    passCode: parsed.searchParams.get('pwd') || parsed.searchParams.get('pass_code') || ''
  };
}

function encodeQuery(params) {
  var parts = [];
  Object.keys(params).forEach(function (key) {
    var value = params[key];
    if (value === undefined || value === null) {
      return;
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  });
  return parts.join('&');
}

function getErrorMessage(data, fallback) {
  if (!data) {
    return fallback;
  }
  return data.error_description || data.errmsg || data.error_message || data.message || fallback;
}

function makeApiError(status, data, fallback) {
  var error = new Error(getErrorMessage(data, fallback));
  error.status = status;
  error.code = data && (data.error_code || data.code || data.errno);
  error.errorCode = error.code;
  error.payload = data;
  return error;
}

async function requestJson(url, options) {
  var response = await fetch(url, options || {});
  var text = await response.text();
  var data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw makeApiError(response.status, null, '迅雷云盘返回了无法解析的响应。');
  }
  if (response.status < 200 || response.status >= 300) {
    throw makeApiError(response.status, data, '迅雷云盘接口请求失败。');
  }
  if (data && (data.error ||
      (data.error_code !== undefined && String(data.error_code) !== '0') ||
      (data.errno !== undefined && String(data.errno) !== '0'))) {
    throw makeApiError(response.status, data, '迅雷云盘接口返回错误。');
  }
  return data;
}

function normalizeCookie(value) {
  value = String(value || '').trim();
  value = value.replace(/^cookie\s*:\s*/i, '');
  value = value.replace(/[\r\n]+/g, '; ');
  return value.trim();
}

function cookieValue(cookie, name) {
  var source = normalizeCookie(cookie);
  var parts = source ? source.split(';') : [];
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i].trim();
    var separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    if (part.substring(0, separator).trim().toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    var value = part.substring(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }
  return '';
}

function getCookie() {
  // Prefer the visible setting so a newly pasted Cookie is not shadowed by
  // an obsolete value left by an earlier extension build.
  return normalizeCookie(setting('cookie', '') || storageGet(COOKIE_STORAGE_KEY));
}

function getAuthorization() {
  var value = setting('authorization', '').trim();
  if (!value) {
    value = cookieValue(getCookie(), 'authorization');
  }
  if (!value) {
    return '';
  }
  if (/^[A-Za-z][A-Za-z0-9_-]*\s+\S+/.test(value)) {
    return value;
  }
  return 'Bearer ' + value;
}

function requestHeaders(token, userAgent, deviceId, auth) {
  var headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': userAgent,
    'X-Client-Id': CLIENT_ID,
    'X-Client-Version': CLIENT_VERSION,
    'X-Device-Id': deviceId,
    'X-Captcha-Token': token,
    Referer: 'https://pan.xunlei.com/'
  };
  if (auth && auth.authorization) {
    headers.Authorization = auth.authorization;
  }
  if (auth && auth.cookie) {
    headers.Cookie = auth.cookie;
  }
  return headers;
}

/* The captcha signature inputs are ASCII, so this compact MD5 is sufficient. */
function md5(s) {
  function add(x, y) {
    var low = (x & 0xffff) + (y & 0xffff);
    var high = (x >>> 16) + (y >>> 16) + (low >>> 16);
    return (high << 16) | (low & 0xffff);
  }
  function rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function cmn(q, a, b, x, s, t) {
    return add(rol(add(add(a, q), add(x, t)), s), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function md5cycle(state, block) {
    var a = state[0];
    var b = state[1];
    var c = state[2];
    var d = state[3];

    a = ff(a, b, c, d, block[0], 7, -680876936);
    d = ff(d, a, b, c, block[1], 12, -389564586);
    c = ff(c, d, a, b, block[2], 17, 606105819);
    b = ff(b, c, d, a, block[3], 22, -1044525330);
    a = ff(a, b, c, d, block[4], 7, -176418897);
    d = ff(d, a, b, c, block[5], 12, 1200080426);
    c = ff(c, d, a, b, block[6], 17, -1473231341);
    b = ff(b, c, d, a, block[7], 22, -45705983);
    a = ff(a, b, c, d, block[8], 7, 1770035416);
    d = ff(d, a, b, c, block[9], 12, -1958414417);
    c = ff(c, d, a, b, block[10], 17, -42063);
    b = ff(b, c, d, a, block[11], 22, -1990404162);
    a = ff(a, b, c, d, block[12], 7, 1804603682);
    d = ff(d, a, b, c, block[13], 12, -40341101);
    c = ff(c, d, a, b, block[14], 17, -1502002290);
    b = ff(b, c, d, a, block[15], 22, 1236535329);

    a = gg(a, b, c, d, block[1], 5, -165796510);
    d = gg(d, a, b, c, block[6], 9, -1069501632);
    c = gg(c, d, a, b, block[11], 14, 643717713);
    b = gg(b, c, d, a, block[0], 20, -373897302);
    a = gg(a, b, c, d, block[5], 5, -701558691);
    d = gg(d, a, b, c, block[10], 9, 38016083);
    c = gg(c, d, a, b, block[15], 14, -660478335);
    b = gg(b, c, d, a, block[4], 20, -405537848);
    a = gg(a, b, c, d, block[9], 5, 568446438);
    d = gg(d, a, b, c, block[14], 9, -1019803690);
    c = gg(c, d, a, b, block[3], 14, -187363961);
    b = gg(b, c, d, a, block[8], 20, 1163531501);
    a = gg(a, b, c, d, block[13], 5, -1444681467);
    d = gg(d, a, b, c, block[2], 9, -51403784);
    c = gg(c, d, a, b, block[7], 14, 1735328473);
    b = gg(b, c, d, a, block[12], 20, -1926607734);

    a = hh(a, b, c, d, block[5], 4, -378558);
    d = hh(d, a, b, c, block[8], 11, -2022574463);
    c = hh(c, d, a, b, block[11], 16, 1839030562);
    b = hh(b, c, d, a, block[14], 23, -35309556);
    a = hh(a, b, c, d, block[1], 4, -1530992060);
    d = hh(d, a, b, c, block[4], 11, 1272893353);
    c = hh(c, d, a, b, block[7], 16, -155497632);
    b = hh(b, c, d, a, block[10], 23, -1094730640);
    a = hh(a, b, c, d, block[13], 4, 681279174);
    d = hh(d, a, b, c, block[0], 11, -358537222);
    c = hh(c, d, a, b, block[3], 16, -722521979);
    b = hh(b, c, d, a, block[6], 23, 76029189);
    a = hh(a, b, c, d, block[9], 4, -640364487);
    d = hh(d, a, b, c, block[12], 11, -421815835);
    c = hh(c, d, a, b, block[15], 16, 530742520);
    b = hh(b, c, d, a, block[2], 23, -995338651);

    a = ii(a, b, c, d, block[0], 6, -198630844);
    d = ii(d, a, b, c, block[7], 10, 1126891415);
    c = ii(c, d, a, b, block[14], 15, -1416354905);
    b = ii(b, c, d, a, block[5], 21, -57434055);
    a = ii(a, b, c, d, block[12], 6, 1700485571);
    d = ii(d, a, b, c, block[3], 10, -1894986606);
    c = ii(c, d, a, b, block[10], 15, -1051523);
    b = ii(b, c, d, a, block[1], 21, -2054922799);
    a = ii(a, b, c, d, block[8], 6, 1873313359);
    d = ii(d, a, b, c, block[15], 10, -30611744);
    c = ii(c, d, a, b, block[6], 15, -1560198380);
    b = ii(b, c, d, a, block[13], 21, 1309151649);
    a = ii(a, b, c, d, block[4], 6, -145523070);
    d = ii(d, a, b, c, block[11], 10, -1120210379);
    c = ii(c, d, a, b, block[2], 15, 718787259);
    b = ii(b, c, d, a, block[9], 21, -343485551);

    state[0] = add(a, state[0]);
    state[1] = add(b, state[1]);
    state[2] = add(c, state[2]);
    state[3] = add(d, state[3]);
  }

  function md5blk(str) {
    var block = [];
    for (var i = 0; i < 64; i += 4) {
      block[i >> 2] = str.charCodeAt(i) | (str.charCodeAt(i + 1) << 8) | (str.charCodeAt(i + 2) << 16) | (str.charCodeAt(i + 3) << 24);
    }
    return block;
  }

  function md51(str) {
    var length = str.length;
    var state = [1732584193, -271733879, -1732584194, 271733878];
    var i;
    for (i = 64; i <= str.length; i += 64) {
      md5cycle(state, md5blk(str.substring(i - 64, i)));
    }
    str = str.substring(i - 64);
    var tail = [];
    for (i = 0; i < str.length; i += 1) {
      tail[i >> 2] |= str.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      tail = [];
    }
    tail[14] = length * 8;
    tail[15] = 0;
    md5cycle(state, tail);
    return state;
  }

  function hex(num) {
    var table = '0123456789abcdef';
    var result = '';
    for (var i = 0; i < 4; i += 1) {
      result += table.charAt((num >> (i * 8 + 4)) & 0x0f) + table.charAt((num >> (i * 8)) & 0x0f);
    }
    return result;
  }

  var state = md51(s);
  return hex(state[0]) + hex(state[1]) + hex(state[2]) + hex(state[3]);
}

function captchaSign(timestamp, deviceId) {
  var current = CLIENT_ID + CLIENT_VERSION + 'pan.xunlei.com' + deviceId + timestamp;
  var salts = [
    'q1FLg',
    'OECaw0higFYs7qCdOWvMEe',
    '1UQvF/CWht+RATnmBnyakvJFHL1jaAb8MRYvdVHQLZ',
    'OV+xWBsbnAehPNmDEUnjcVT',
    'bbuvyCYHdJwBOtJ8Cdeg',
    '9ROgxnyRfQInpATpkchBTZW',
    'vXA2EpRk8',
    'oEd',
    'QCBQwX/',
    'P5NlYzyVtGjJUI/dIzi+SOL+mf0Wl17',
    '7GRbxu7OmpasI841c66J',
    'PEVQN9w+A4wRbGoX',
    'CJ3yz0fu1kqhPDOyL438W',
    'tD75Q'
  ];
  for (var i = 0; i < salts.length; i += 1) {
    current = md5(current + salts[i]);
  }
  return '1.' + current;
}

async function createCaptchaToken(deviceId, userAgent, auth) {
  var timestamp = String(Date.now());
  var payload = {
    client_id: CLIENT_ID,
    action: 'get:/drive/v1/share',
    device_id: deviceId,
    meta: {
      username: '',
      phone_number: '',
      email: '',
      package_name: 'pan.xunlei.com',
      client_version: CLIENT_VERSION,
      captcha_sign: captchaSign(timestamp, deviceId),
      timestamp: timestamp,
      user_id: '0'
    }
  };
  var data = await requestJson(CAPTCHA_API, {
    method: 'POST',
    headers: Object.assign({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      'X-Client-Id': CLIENT_ID,
      'X-Client-Version': CLIENT_VERSION,
      'X-Device-Id': deviceId
    }, auth && auth.cookie ? { Cookie: auth.cookie } : {}),
    body: JSON.stringify(payload)
  });
  if (!data.captcha_token) {
    throw makeApiError(200, data, '获取迅雷云盘验证码令牌失败。');
  }
  return data.captcha_token;
}

function unwrap(data) {
  if (data && data.data && typeof data.data === 'object' && !data.share_status && !data.files && !data.file_list) {
    return data.data;
  }
  return data || {};
}

function arrayValue(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value.list)) {
    return value.list;
  }
  if (Array.isArray(value.files)) {
    return value.files;
  }
  return [];
}

function isAvailableItem(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  return !!getItemId(item) && !!getItemName(item);
}

function getItems(data) {
  var payload = unwrap(data);
  // The current share and drive APIs expose the authoritative list as `files`.
  // Do not fall back to recommendation/resource arrays: those can be unrelated
  // to the share and are still shaped enough to look like files.
  return arrayValue(payload.files).filter(isAvailableItem);
}

function getNextPageToken(data) {
  var payload = unwrap(data);
  return payload.next_page_token || payload.page_token_next || '';
}

function getPassCodeToken(data) {
  var payload = unwrap(data);
  return payload.pass_code_token || (payload.share_info && payload.share_info.pass_code_token) || '';
}

function getShareTitle(data, fallback) {
  var payload = unwrap(data);
  var info = payload.share_info || payload.info || {};
  return info.name || info.title || payload.name || payload.title || fallback;
}

function getItemId(item) {
  return item.id || item.file_id || item.fileId || '';
}

function getItemName(item) {
  return item.name || item.file_name || item.fileName || '未命名文件';
}

function getItemSize(item) {
  return Number(item.size || item.file_size || item.fileSize || 0);
}

function isFolder(item) {
  return item.kind === 'drive#folder' || item.kind === 'folder' || item.type === 'folder' || item.file_category === 'FOLDER' || item.is_dir === true || item.isDir === true || item.is_folder === true;
}

function getInlineDownloadUrl(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  var direct = item.web_content_link || item.download_url || item.downloadUrl || item.play_url || item.playUrl || '';
  if (direct) {
    return direct;
  }
  var links = item.links;
  if (!links || typeof links !== 'object') {
    return '';
  }
  var preferredNames = ['download', 'download_url', 'downloadUrl', 'web_content_link', 'url', 'play_url', 'playUrl'];
  for (var i = 0; i < preferredNames.length; i += 1) {
    var value = links[preferredNames[i]];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      return value;
    }
    if (value && typeof value === 'object') {
      var nested = getInlineDownloadUrl(value);
      if (nested) {
        return nested;
      }
    }
  }
  return '';
}

function shareRequestUrl(params) {
  return API_BASE + '/share?' + encodeQuery(params);
}

function shareDetailRequestUrl(params) {
  return API_BASE + '/share/detail?' + encodeQuery(params);
}

function fileInfoRequestUrl(params) {
  return API_BASE + '/share/file_info?' + encodeQuery(params);
}

function userFilesRequestUrl(params) {
  return API_BASE + '/files?' + encodeQuery(params);
}

function userFileInfoRequestUrl(fileId) {
  return API_BASE + '/files/' + encodeURIComponent(fileId) + '?' + encodeQuery({
    space: '',
    // CONSUME asks the drive API for the usable content URL. DISPLAY only
    // returns metadata and leaves web_content_link empty.
    usage: 'CONSUME'
  });
}

function userFileRawInfoRequestUrl(fileId) {
  return API_BASE + '/files/' + encodeURIComponent(fileId);
}

async function batchDeleteUserFiles(fileIds, token, deviceId, userAgent, auth) {
  if (!fileIds.length) {
    return;
  }
  await requestJson(API_BASE + '/files:batchDelete', {
    method: 'POST',
    headers: Object.assign({}, requestHeaders(token, userAgent, deviceId, auth), {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ ids: fileIds, space: '' })
  });
}

function getField(data, names) {
  var payload = unwrap(data);
  var containers = [payload, payload.params, payload.task, payload.result, payload.data];
  if (payload.task && typeof payload.task === 'object') {
    containers.push(payload.task.params, payload.task.result);
  }
  if (payload.result && typeof payload.result === 'object') {
    containers.push(payload.result.params, payload.result.result);
  }
  for (var i = 0; i < containers.length; i += 1) {
    var container = containers[i];
    if (!container || typeof container !== 'object') {
      continue;
    }
    for (var j = 0; j < names.length; j += 1) {
      if (container[names[j]] !== undefined && container[names[j]] !== null) {
        return container[names[j]];
      }
    }
  }
  return '';
}

async function getShare(data, share, token, deviceId, userAgent, auth, parentId, pageToken) {
  var params = {
    share_id: share.shareId,
    limit: PAGE_SIZE,
    space: '',
    thumbnail_size: 'SIZE_MEDIUM',
    scene: 'NORMAL'
  };
  var url;
  if (parentId) {
    params.parent_id = parentId;
    params.pass_code_token = data.passCodeToken;
    if (pageToken) {
      params.page_token = pageToken;
    }
    url = shareDetailRequestUrl(params);
  } else {
    params.pass_code = share.passCode;
    if (pageToken) {
      params.page_token = pageToken;
    }
    if (data.passCodeToken) {
      params.pass_code_token = data.passCodeToken;
    }
    url = shareRequestUrl(params);
  }
  return requestJson(url, {
    headers: requestHeaders(token, userAgent, deviceId, auth)
  });
}

async function getFileInfo(data, share, item, folderId, token, deviceId, userAgent, auth) {
  var inlineUrl = getInlineDownloadUrl(item);
  if (inlineUrl) {
    return { url: inlineUrl, size: getItemSize(item) };
  }

  var params = {
    share_id: share.shareId,
    file_id: getItemId(item),
    pass_code: share.passCode,
    pass_code_token: data.passCodeToken,
    folder_id: folderId || '',
    space: '',
    scene: 'NORMAL'
  };
  var response = await requestJson(fileInfoRequestUrl(params), {
    headers: requestHeaders(token, userAgent, deviceId, auth)
  });
  var payload = unwrap(response);
  var info = payload.file_info || payload.info || payload;
  var url = getInlineDownloadUrl(info);
  return { url: url, size: getItemSize(info) || getItemSize(item) };
}

async function listUserFiles(parentId, token, deviceId, userAgent, auth) {
  var items = [];
  var pageToken = '';
  for (var page = 0; page < MAX_PAGES_PER_FOLDER; page += 1) {
    var params = {
      parent_id: parentId,
      limit: PAGE_SIZE,
      space: ''
    };
    if (pageToken) {
      params.page_token = pageToken;
    }
    var response = await requestJson(userFilesRequestUrl(params), {
      headers: requestHeaders(token, userAgent, deviceId, auth)
    });
    items = items.concat(getItems(response));
    var next = getNextPageToken(response);
    if (!next || next === pageToken) {
      break;
    }
    pageToken = next;
  }
  return items;
}

async function collectRestoredFolderFiles(parentId, path, token, deviceId, userAgent, auth, seenFolders, result) {
  var items = await listUserFiles(parentId, token, deviceId, userAgent, auth);
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var itemId = getItemId(item);
    if (!itemId) {
      continue;
    }
    if (isFolder(item)) {
      if (!seenFolders[itemId]) {
        seenFolders[itemId] = true;
        await collectRestoredFolderFiles(itemId, path + getItemName(item) + '/', token, deviceId, userAgent, auth, seenFolders, result);
      }
    } else {
      if (result.length >= MAX_FILES) {
        throw new Error('转存后的文件数量超过 ' + MAX_FILES + ' 个，已停止解析。');
      }
      result.push({ item: item, path: path });
    }
  }
}

async function collectRestoredFiles(rootId, path, token, deviceId, userAgent, auth, result) {
  // Never list an arbitrary parent_id before checking what the restore API
  // returned. If it is a file ID, /files?parent_id=... may otherwise fall back
  // to the user's root and produce unrelated files.
  var root = await getUserFileRecord(rootId, token, deviceId, userAgent, auth);
  if (!root || !getItemId(root)) {
    throw new Error('迅雷云盘转存结果无效，无法确认转存文件范围。');
  }
  if (isFolder(root)) {
    var seenFolders = {};
    seenFolders[rootId] = true;
    await collectRestoredFolderFiles(rootId, path, token, deviceId, userAgent, auth, seenFolders, result);
    return;
  }
  result.push({ item: root, path: path });
}

function normalizePath(path) {
  return String(path || '').replace(/^\/+|\/+$/g, '');
}

function findRestoredFile(records, original) {
  var wantedPath = normalizePath(original.path + getItemName(original.item));
  var matches = [];
  for (var i = 0; i < records.length; i += 1) {
    var record = records[i];
    var currentPath = normalizePath(record.path + getItemName(record.item));
    if (currentPath !== wantedPath) {
      continue;
    }
    if (getItemSize(original.item) && getItemSize(record.item) && getItemSize(original.item) !== getItemSize(record.item)) {
      continue;
    }
    matches.push(record);
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}

async function getUserFileRecord(fileId, token, deviceId, userAgent, auth) {
  var response = await requestJson(userFileInfoRequestUrl(fileId), {
    headers: requestHeaders(token, userAgent, deviceId, auth)
  });
  var payload = unwrap(response);
  var info = payload.file_info || payload.info || payload.file || payload;
  if (!info || typeof info !== 'object') {
    return null;
  }
  if (!getItemId(info)) {
    info = Object.assign({}, info, { id: fileId });
  }
  return info;
}

async function getUserFileInfo(fileId, token, deviceId, userAgent, auth) {
  var info = await getUserFileRecord(fileId, token, deviceId, userAgent, auth);
  if (!getInlineDownloadUrl(info)) {
    var response = await requestJson(userFileRawInfoRequestUrl(fileId), {
      headers: requestHeaders(token, userAgent, deviceId, auth)
    });
    var payload = unwrap(response);
    info = payload.file_info || payload.info || payload.file || payload;
  }
  return {
    url: getInlineDownloadUrl(info),
    size: getItemSize(info)
  };
}

function delay(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

function isRestoreComplete(status) {
  return status === 'RESTORE_COMPLETE' || status === 'PHASE_TYPE_COMPLETE' || status === 'COMPLETE';
}

function isRestoreError(status) {
  return status === 'RESTORE_ERROR' || status === 'PHASE_TYPE_ERROR' || status === 'ERROR' || status === 'FAILED';
}

function getRestoreStatus(data) {
  return String(getField(data, ['restore_status', 'phase_type', 'task_status', 'status', 'phase']) || '').toUpperCase();
}

function firstRestoreFileId(value) {
  if (!value) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.length ? firstRestoreFileId(value[0]) : '';
  }
  if (typeof value === 'object') {
    var values = Object.keys(value).map(function (key) {
      return value[key];
    });
    return values.length ? firstRestoreFileId(values[0]) : '';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  var text = value.trim();
  if (!text) {
    return '';
  }
  if (text.charAt(0) === '{' || text.charAt(0) === '[') {
    try {
      return firstRestoreFileId(JSON.parse(text));
    } catch (e) {
      return '';
    }
  }
  return text;
}

function parseRestoreFileMap(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    var text = value.trim();
    if (!text || text.charAt(0) !== '{') {
      return {};
    }
    try {
      return parseRestoreFileMap(JSON.parse(text));
    } catch (e) {
      return {};
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  var result = {};
  Object.keys(value).forEach(function (sourceId) {
    var restoredId = firstRestoreFileId(value[sourceId]);
    if (restoredId) {
      result[sourceId] = restoredId;
    }
  });
  return result;
}

function getRestoreFileMap(data, rootIds) {
  var result = parseRestoreFileMap(getField(data, ['trace_file_ids', 'restore_file_ids']));
  var direct = firstRestoreFileId(getField(data, ['file_id', 'restore_file_id']));
  if (direct && rootIds.length === 1 && !result[rootIds[0]]) {
    result[rootIds[0]] = direct;
  }
  return result;
}

function mergeRestoreFileMap(target, source) {
  Object.keys(source || {}).forEach(function (sourceId) {
    if (source[sourceId]) {
      target[sourceId] = source[sourceId];
    }
  });
  return target;
}

function hasAllRestoreRoots(fileMap, rootIds) {
  return rootIds.every(function (sourceId) {
    return !!fileMap[sourceId];
  });
}

function getRestoreTaskId(data) {
  return getField(data, ['restore_task_id', 'task_id', 'id']);
}

async function waitRestoreTask(taskId, rootIds, fileMap, token, deviceId, userAgent, auth) {
  for (var attempt = 0; attempt < MAX_RESTORE_POLL; attempt += 1) {
    var response = await requestJson(API_BASE + '/tasks/' + encodeURIComponent(taskId), {
      headers: requestHeaders(token, userAgent, deviceId, auth)
    });
    var status = getRestoreStatus(response);
    mergeRestoreFileMap(fileMap, getRestoreFileMap(response, rootIds));
    if (isRestoreComplete(status) && hasAllRestoreRoots(fileMap, rootIds)) {
      return fileMap;
    }
    if (isRestoreError(status)) {
      throw new Error(getErrorMessage(unwrap(response), '迅雷云盘转存失败。'));
    }
    await delay(1000);
  }
  throw new Error('迅雷云盘转存超时，请稍后重试。');
}

async function restoreShare(state, share, token, deviceId, userAgent, auth) {
  var rootIds = state.rootItems.map(function (item) {
    return getItemId(item);
  }).filter(function (id) {
    return !!id;
  });
  if (!rootIds.length) {
    rootIds = state.fileItems.map(function (entry) {
      return getItemId(entry.item);
    });
  }
  var response;
  try {
    response = await requestJson(API_BASE + '/share/restore', {
      method: 'POST',
      headers: Object.assign({}, requestHeaders(token, userAgent, deviceId, auth), {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({
        parent_id: RESTORE_PARENT_ID,
        share_id: share.shareId,
        pass_code_token: state.passCodeToken,
        ancestor_ids: [],
        file_ids: rootIds,
        specify_parent_id: true
      })
    });
  } catch (error) {
    error.requiresAuthorization = true;
    throw error;
  }
  var status = getRestoreStatus(response);
  var fileMap = getRestoreFileMap(response, rootIds);
  if (isRestoreComplete(status) && hasAllRestoreRoots(fileMap, rootIds)) {
    return fileMap;
  }
  if (isRestoreError(status)) {
    throw new Error(getErrorMessage(unwrap(response), '迅雷云盘转存失败。'));
  }
  var taskId = getRestoreTaskId(response);
  if (taskId) {
    return waitRestoreTask(taskId, rootIds, fileMap, token, deviceId, userAgent, auth);
  }
  if (hasAllRestoreRoots(fileMap, rootIds)) {
    return fileMap;
  }
  throw new Error('迅雷云盘转存接口没有返回任务信息。');
}

async function resolveRestoredFiles(state, share, token, deviceId, userAgent, auth) {
  var restoreFileMap = await restoreShare(state, share, token, deviceId, userAgent, auth);
  var records = [];
  var roots = state.rootItems.length ? state.rootItems : state.fileItems.map(function (entry) {
    return entry.item;
  });
  for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    var root = roots[rootIndex];
    var sourceRootId = getItemId(root);
    var restoreRootId = restoreFileMap[sourceRootId];
    if (!restoreRootId) {
      throw new Error('迅雷云盘转存完成，但没有返回完整的文件映射。');
    }
    if (state.cleanupIds.indexOf(restoreRootId) < 0) {
      state.cleanupIds.push(restoreRootId);
    }
    var rootPath = isFolder(root) ? getItemName(root) + '/' : '';
    await collectRestoredFiles(restoreRootId, rootPath, token, deviceId, userAgent, auth, records);
  }
  for (var i = 0; i < state.fileItems.length; i += 1) {
    var entry = state.fileItems[i];
    if (entry.info && entry.info.url) {
      continue;
    }
    var restored = findRestoredFile(records, entry);
    if (!restored) {
      throw new Error('转存结果与分享文件不一致，已停止，未提交无关文件。');
    }
    var info = getInlineDownloadUrl(restored.item) ? {
      url: getInlineDownloadUrl(restored.item),
      size: getItemSize(restored.item)
    } : await getUserFileInfo(getItemId(restored.item), token, deviceId, userAgent, auth);
    if (info.url) {
      entry.info = {
        url: info.url,
        size: info.size || getItemSize(entry.item)
      };
    }
  }
}

async function resolveFiles(share, token, deviceId, userAgent, auth) {
  var state = {
    files: [],
    fileItems: [],
    rootItems: [],
    rootItemIds: {},
    folders: {},
    cleanupIds: [],
    passCodeToken: '',
    title: '迅雷云盘分享'
  };

  async function listFolder(parentId) {
    var items = [];
    var pageToken = '';
    for (var page = 0; page < MAX_PAGES_PER_FOLDER; page += 1) {
      var response = await getShare(state, share, token, deviceId, userAgent, auth, parentId, pageToken);
      state.passCodeToken = getPassCodeToken(response) || state.passCodeToken;
      state.title = getShareTitle(response, state.title);
      items = items.concat(getItems(response));
      var next = getNextPageToken(response);
      if (!next || next === pageToken) {
        break;
      }
      pageToken = next;
    }
    return items;
  }

  async function walk(parentId, path) {
    var items = await listFolder(parentId);

    for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        var itemId = getItemId(item);
        if (!itemId) {
          continue;
        }
      if (!parentId && !state.rootItemIds[itemId]) {
        state.rootItemIds[itemId] = true;
        state.rootItems.push(item);
      }
      if (isFolder(item)) {
        if (!state.folders[itemId]) {
          state.folders[itemId] = true;
          await walk(itemId, path + getItemName(item) + '/');
        }
      } else {
        if (state.fileItems.length >= MAX_FILES) {
          throw new Error('分享文件数量超过 ' + MAX_FILES + ' 个，已停止解析。');
        }
        state.fileItems.push({ item: item, path: path, parentId: parentId, info: null });
      }
    }
  }

  await walk('', '');
  for (var start = 0; start < state.fileItems.length; start += 10) {
    var batch = state.fileItems.slice(start, start + 10);
    await Promise.all(batch.map(function (entry) {
      return getFileInfo(state, share, entry.item, entry.parentId, token, deviceId, userAgent, auth).then(function (info) {
        entry.info = info;
      });
    }));
  }

  var missing = state.fileItems.some(function (entry) {
    return !entry.info || !entry.info.url;
  });
  if (missing) {
    if (!getAuthorization()) {
      if (getCookie()) {
        throw new Error('当前 Cookie 可以读取分享内容，但迅雷普通分享转存需要 OAuth 登录凭证。请在扩展设置中填写 Authorization。');
      }
      throw new Error('迅雷普通分享文件需要登录后转存到云盘，才能获取下载地址。请在扩展设置中填写 Cookie 和 OAuth 登录凭证。');
    }
    await resolveRestoredFiles(state, share, token, deviceId, userAgent, auth);
  }

  for (var i = 0; i < state.fileItems.length; i += 1) {
    var entry = state.fileItems[i];
    if (!entry.info || !entry.info.url) {
      throw new Error('文件“' + getItemName(entry.item) + '”转存后仍没有返回可下载地址。');
    }
    state.files.push({
      name: getItemName(entry.item),
      path: entry.path,
      size: entry.info.size || getItemSize(entry.item),
      req: {
        url: entry.info.url,
        headers: {
          'User-Agent': userAgent,
          Referer: 'https://pan.xunlei.com/'
        }
      }
    });
  }
  return state;
}

function isCaptchaError(error) {
  return error && (error.code === 9 || error.errorCode === 9 || /captcha|验证码|令牌/i.test(error.message || ''));
}

function formatResolveError(error) {
  if (error && error.requiresAuthorization) {
    if (error.code === 16 || error.status === 401) {
      if (getAuthorization()) {
        return '迅雷 OAuth 登录凭证无效或已过期，请从迅雷网页端重新复制 Authorization。';
      }
      return '当前 Cookie 可以读取分享内容，但不能执行迅雷普通分享转存；请在扩展设置中填写 Authorization。';
    }
  }
  if (error && (error.status === 401 || error.status === 403)) {
    return '迅雷登录凭证无效或已过期，请重新填写 Cookie 或 Authorization。';
  }
  return error && error.message ? error.message : String(error);
}

async function resolve(ctx) {
  var share = parseShareUrl(ctx.req.url);
  var userAgent = setting('userAgent', DEFAULT_USER_AGENT);
  var auth = {
    authorization: getAuthorization(),
    cookie: getCookie()
  };
  var deviceId = getDeviceId();
  var token = await createCaptchaToken(deviceId, userAgent, auth);
  var state;
  try {
    state = await resolveFiles(share, token, deviceId, userAgent, auth);
  } catch (error) {
    if (error && (error.requiresAuthorization || error.status === 401 || error.status === 403)) {
      throw new Error(formatResolveError(error));
    }
    if (!isCaptchaError(error)) {
      throw error;
    }
    token = await createCaptchaToken(deviceId, userAgent, auth);
    try {
      state = await resolveFiles(share, token, deviceId, userAgent, auth);
    } catch (retryError) {
      if (retryError && (retryError.requiresAuthorization || retryError.status === 401 || retryError.status === 403)) {
        throw new Error(formatResolveError(retryError));
      }
      throw retryError;
    }
  }

  if (!state.files.length) {
    throw new Error('没有找到可下载文件。若分享需要提取码，请使用 ?pwd=xxxx 的完整链接。');
  }
  if (isSettingEnabled('autoCleanup') && state.cleanupIds.length) {
    var cleanupValue = state.cleanupIds.join(',');
    // Keep the marker on both the root request and each generated file
    // request. Gopeed versions differ in which request is persisted for a
    // resolved multi-file resource.
    ctx.req.labels = ctx.req.labels || {};
    ctx.req.labels[CLEANUP_LABEL] = cleanupValue;
    state.files.forEach(function (file) {
      file.req.labels = file.req.labels || {};
      file.req.labels[CLEANUP_LABEL] = cleanupValue;
    });
    // There is no onCancel event in Gopeed. Delete after every download URL
    // is ready, before the resource is handed back to Gopeed, so cancelling
    // before task start cannot leave the temporary restore behind.
    await cleanupIdsNow(state.cleanupIds);
  }
  ctx.res = {
    name: state.title || share.shareId,
    range: true,
    files: state.files
  };
}

gopeed.events.onResolve(resolve);

async function cleanupIdsNow(inputIds) {
  if (!isSettingEnabled('autoCleanup')) {
    return;
  }
  var ids = (inputIds || []).map(function (id) {
    return String(id);
  }).filter(function (id) {
    return !!id;
  });
  if (!ids.length) {
    return;
  }
  ids.sort();
  var cleanupStorageKey = 'xunlei.cleanup.' + md5(ids.join(','));
  if (storageGet(cleanupStorageKey)) {
    return;
  }
  storageSet(cleanupStorageKey, 'running');
  try {
    var userAgent = setting('userAgent', DEFAULT_USER_AGENT);
    var auth = {
      authorization: getAuthorization(),
      cookie: getCookie()
    };
    var deviceId = getDeviceId();
    var token = await createCaptchaToken(deviceId, userAgent, auth);
    await batchDeleteUserFiles(ids, token, deviceId, userAgent, auth);
    storageSet(cleanupStorageKey, 'done');
    gopeed.logger.info('迅雷云盘转存文件已自动清理');
  } catch (error) {
    storageSet(cleanupStorageKey, '');
    gopeed.logger.warn('迅雷云盘转存文件自动清理失败：' + (error.message || error));
  }
}

async function cleanupFromContext(ctx) {
  var labels = ctx.task && ctx.task.meta && ctx.task.meta.req && ctx.task.meta.req.labels;
  var rootLabels = ctx.req && ctx.req.labels;
  var rawIds = String(labels && labels[CLEANUP_LABEL] || '');
  if (!rawIds && rootLabels) {
    rawIds = String(rootLabels[CLEANUP_LABEL] || '');
  }
  await cleanupIdsNow(rawIds.split(',').filter(function (id) {
    return !!id;
  }));
}

// These events retry cleanup if the immediate resolve-time request failed.
gopeed.events.onStart(cleanupFromContext);
gopeed.events.onDone(cleanupFromContext);
