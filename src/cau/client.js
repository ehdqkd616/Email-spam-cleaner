const https = require('https');

// Graph API 요청 헬퍼 (native https 사용 — 추가 의존성 없음)
function graphRequest(accessToken, urlOrPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const urlStr = urlOrPath.startsWith('https://')
      ? urlOrPath
      : `https://graph.microsoft.com/v1.0${urlOrPath}`;
    const url = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 204) return resolve(null);
          if (res.statusCode >= 400)
            return reject(new Error(`Graph API ${res.statusCode}: ${data}`));
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON 파싱 오류: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class CauGraphClient {
  constructor(accessToken) {
    this._token = accessToken;
    this._email = null;
    this._folderIdCache = {}; // displayName → Graph folder ID
    this._msgCache = new Map(); // messageId → meta object
  }

  async connect()    { /* OAuth2는 연결/해제 불필요 */ }
  async disconnect() { /* OAuth2는 연결/해제 불필요 */ }

  async getProfile() {
    if (!this._email) {
      const me = await graphRequest(this._token, '/me?$select=mail,userPrincipalName');
      this._email = me.mail || me.userPrincipalName;
    }
    return { emailAddress: this._email };
  }

  // 폴더 이름 → Graph 폴더 ID 변환
  async _getFolderId(folderName) {
    const lower = folderName.toLowerCase();
    const wellKnown = {
      'inbox': 'inbox', 'received': 'inbox',
      '받은편지함': 'inbox', '받은 편지함': 'inbox',
      'deleteditems': 'deleteditems',
      '지운 편지함': 'deleteditems', '삭제된 항목': 'deleteditems',
      'junkemail': 'junkemail',
      '정크 메일': 'junkemail', '정크메일': 'junkemail',
    };
    if (wellKnown[lower]) return wellKnown[lower];
    if (this._folderIdCache[folderName]) return this._folderIdCache[folderName];

    // 전체 폴더 목록에서 이름으로 검색
    await this._loadFolderCache();
    if (this._folderIdCache[folderName]) return this._folderIdCache[folderName];
    throw new Error(`폴더를 찾을 수 없습니다: ${folderName}`);
  }

  async _loadFolderCache() {
    const res = await graphRequest(this._token, '/me/mailFolders?$top=100&$select=id,displayName');
    for (const f of (res.value || [])) {
      this._folderIdCache[f.displayName] = f.id;
    }
  }

  // 페이지네이션으로 폴더 내 전체 메시지 조회
  async _fetchMessages(folderId, filter = '', limit = 5000) {
    const messages = [];
    let url = `/me/mailFolders/${folderId}/messages?$select=id,subject,from,receivedDateTime,isRead&$top=100`;
    if (filter) url += `&$filter=${encodeURIComponent(filter)}`;

    while (url && messages.length < limit) {
      const data = await graphRequest(this._token, url);
      if (!data || !data.value) break;
      messages.push(...data.value);
      url = data['@odata.nextLink'] || null;
    }
    return messages.slice(0, limit);
  }

  // Graph 메시지 → 공통 메타데이터 형식 변환
  _toMeta(msg) {
    const fromObj = msg.from?.emailAddress;
    const fromStr = fromObj
      ? (fromObj.name ? `${fromObj.name} <${fromObj.address}>` : fromObj.address)
      : '';
    return {
      id: msg.id,
      payload: {
        headers: [
          { name: 'Subject', value: msg.subject || '' },
          { name: 'From',    value: fromStr },
          { name: 'Date',    value: msg.receivedDateTime || '' },
        ],
      },
    };
  }

  // 폴더 전체 메타데이터 조회 (categorizer용)
  async fetchAllMetadata(folderName) {
    const folderId = await this._getFolderId(folderName);
    const msgs = await this._fetchMessages(folderId, '', 5000);
    return msgs.map((m) => {
      const meta = this._toMeta(m);
      this._msgCache.set(m.id, meta);
      return meta;
    });
  }

  // 조건 기반 메시지 검색 (cleaner/spammer용)
  async searchInFolder(folderName, criteria, limit = 5000) {
    const folderId = await this._getFolderId(folderName);
    const filterParts = [];

    if (criteria.seen === false) filterParts.push('isRead eq false');
    if (criteria.seen === true)  filterParts.push('isRead eq true');
    if (criteria.before) {
      filterParts.push(`receivedDateTime le ${criteria.before.toISOString()}`);
    }

    const msgs = await this._fetchMessages(folderId, filterParts.join(' and '), limit);

    // 키워드는 클라이언트 측 필터링
    let filtered = msgs;
    if (criteria._keywords && criteria._keywords.length > 0) {
      filtered = msgs.filter((m) => {
        const subject  = (m.subject || '').toLowerCase();
        const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
        const fromName = (m.from?.emailAddress?.name || '').toLowerCase();
        return criteria._keywords.some(
          (kw) => subject.includes(kw.toLowerCase())
               || fromAddr.includes(kw.toLowerCase())
               || fromName.includes(kw.toLowerCase())
        );
      });
    }

    return filtered.map((m) => {
      const meta = this._toMeta(m);
      this._msgCache.set(m.id, meta);
      return { id: m.id, folder: folderId };
    });
  }

  // 메시지 메타데이터 일괄 조회
  async getMetadata(ids) {
    if (!ids.length) return [];

    const missing = ids.filter((id) => !this._msgCache.has(id));
    if (missing.length) {
      const BATCH = 20;
      for (let i = 0; i < missing.length; i += BATCH) {
        await Promise.all(
          missing.slice(i, i + BATCH).map(async (id) => {
            try {
              const msg = await graphRequest(
                this._token,
                `/me/messages/${id}?$select=id,subject,from,receivedDateTime`
              );
              this._msgCache.set(id, this._toMeta(msg));
            } catch (_) { /* 개별 실패 무시 */ }
          })
        );
      }
    }

    return ids.map((id) => this._msgCache.get(id)).filter(Boolean);
  }

  // 메시지 이동 공통 헬퍼
  async _moveMessages(ids, targetFolderId) {
    const BATCH = 10;
    let count = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(
        ids.slice(i, i + BATCH).map(async (id) => {
          await graphRequest(this._token, `/me/messages/${id}/move`, 'POST', {
            destinationId: targetFolderId,
          });
          count++;
        })
      );
    }
    return count;
  }

  async trashMessages(ids)  { return this._moveMessages(ids, 'deleteditems'); }
  async markAsSpam(ids)     { return this._moveMessages(ids, 'junkemail'); }

  async moveTo(ids, folderName) {
    const folderId = await this._getFolderId(folderName);
    return this._moveMessages(ids, folderId);
  }

  // 영구 삭제 (Graph permanentDelete API 사용)
  async deleteMessages(ids) {
    const BATCH = 10;
    let count = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(
        ids.slice(i, i + BATCH).map(async (id) => {
          await graphRequest(this._token, `/me/messages/${id}/permanentDelete`, 'POST');
          count++;
        })
      );
    }
    return count;
  }

  // 폴더 목록 조회 (cleanupOldFolders용)
  async listFolders() {
    await this._loadFolderCache();
    return Object.keys(this._folderIdCache);
  }

  async createFolder(name) {
    if (this._folderIdCache[name]) return;
    try {
      const res = await graphRequest(this._token, '/me/mailFolders', 'POST', {
        displayName: name,
      });
      if (res && res.id) this._folderIdCache[name] = res.id;
    } catch (err) {
      if (err.message.includes('ErrorFolderExists') || err.message.includes('exists')) {
        await this._loadFolderCache();
      } else {
        throw err;
      }
    }
  }

  async deleteFolder(name) {
    try {
      const folderId = await this._getFolderId(name);
      await graphRequest(this._token, `/me/mailFolders/${folderId}`, 'DELETE');
      delete this._folderIdCache[name];
    } catch (err) {
      if (!err.message.includes('404') && !err.message.includes('not found')) throw err;
    }
  }

  async createBlockFilter() {
    throw new Error(
      'Microsoft Graph 서버 사이드 차단 필터는 지원되지 않습니다.\n' +
      'Outlook 웹(outlook.office.com)에서 직접 수신차단 설정을 해주세요.'
    );
  }
}

module.exports = { CauGraphClient };
