const { google } = require('googleapis');

const USER_ID          = 'me';
const SEARCH_PAGE_SIZE = 500;
const BATCH_LIMIT      = 1000;
const CONCURRENCY      = 8;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class GmailClient {
  constructor(auth) {
    this.api = google.gmail({ version: 'v1', auth });
  }

  async searchMessages(query, limit = 5000) {
    const ids = [];
    let pageToken;
    do {
      const res = await this.api.users.messages.list({
        userId: USER_ID,
        q: query,
        maxResults: Math.min(SEARCH_PAGE_SIZE, limit - ids.length),
        pageToken,
      });
      ids.push(...(res.data.messages || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken && ids.length < limit);
    return ids;
  }

  // 다른 프로바이더(searchInFolder(folder, criteria))와 동일한 시그니처를 맞추기 위한 어댑터.
  // Gmail은 폴더 개념이 없어 folder 인자는 쓰지 않고, criteria 자리에 온 Gmail 검색 쿼리 문자열을 그대로 사용
  async searchInFolder(_folder, query, limit = 5000) {
    return this.searchMessages(query, limit);
  }

  // 받은편지함 전체를 matcher.js의 detectAd() 스코어링 엔진으로 판별 (Naver·Nate와 동일 기준)
  async scanInboxForAds(readFilter, limit = 2000) {
    const { detectAd } = require('../matcher');
    const readQ = readFilter === 'is:unread' ? 'is:unread ' : readFilter === 'is:read' ? 'is:read ' : '';
    const ids   = await this.searchMessages(`in:inbox ${readQ}`.trim(), limit);
    if (!ids.length) return [];
    const metas = await this.getMetadata(ids.map((m) => m.id));
    return metas
      .filter((m) => {
        const subject = m.payload?.headers?.find((h) => h.name === 'Subject')?.value || '';
        const from    = m.payload?.headers?.find((h) => h.name === 'From')?.value || '';
        return detectAd(subject, from).isAd;
      })
      .map((m) => ({ id: m.id }));
  }

  async getMetadata(messageIds) {
    const results = [];
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
      const chunk = messageIds.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((id) => this.api.users.messages.get({
          userId: USER_ID, id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        }))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') results.push(r.value.data);
      }
      if (i + CONCURRENCY < messageIds.length) await sleep(80);
    }
    return results;
  }

  async trashMessages(ids) {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      await this.api.users.messages.batchModify({
        userId: USER_ID,
        requestBody: { ids: ids.slice(i, i + BATCH_LIMIT), addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] },
      });
      if (i + BATCH_LIMIT < ids.length) await sleep(200);
    }
    return ids.length;
  }

  async deleteMessages(ids) {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      await this.api.users.messages.batchDelete({
        userId: USER_ID,
        requestBody: { ids: ids.slice(i, i + BATCH_LIMIT) },
      });
      if (i + BATCH_LIMIT < ids.length) await sleep(200);
    }
    return ids.length;
  }

  async markAsSpam(ids) {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      await this.api.users.messages.batchModify({
        userId: USER_ID,
        requestBody: { ids: ids.slice(i, i + BATCH_LIMIT), addLabelIds: ['SPAM'], removeLabelIds: ['INBOX', 'UNREAD'] },
      });
      if (i + BATCH_LIMIT < ids.length) await sleep(200);
    }
    return ids.length;
  }

  async createBlockFilter(fromAddress) {
    await this.api.users.settings.filters.create({
      userId: USER_ID,
      requestBody: { criteria: { from: fromAddress }, action: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } },
    });
  }

  async createFilter(criteria, action) {
    await this.api.users.settings.filters.create({ userId: USER_ID, requestBody: { criteria, action } });
  }

  async listFilters() {
    const res = await this.api.users.settings.filters.list({ userId: USER_ID });
    return res.data.filter || [];
  }

  async listLabels() {
    const res = await this.api.users.labels.list({ userId: USER_ID });
    return res.data.labels || [];
  }

  async getOrCreateLabel(name) {
    const labels = await this.listLabels();
    const existing = labels.find((l) => l.name === name);
    if (existing) return existing.id;
    const res = await this.api.users.labels.create({
      userId: USER_ID,
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return res.data.id;
  }

  async applyLabel(messageIds, labelId) {
    for (let i = 0; i < messageIds.length; i += BATCH_LIMIT) {
      await this.api.users.messages.batchModify({
        userId: USER_ID,
        requestBody: { ids: messageIds.slice(i, i + BATCH_LIMIT), addLabelIds: [labelId] },
      });
      if (i + BATCH_LIMIT < messageIds.length) await sleep(200);
    }
  }

  async getMessagesInLabel(labelId, limit = 10000) {
    const ids = [];
    let pageToken;
    do {
      const res = await this.api.users.messages.list({
        userId: USER_ID,
        labelIds: [labelId],
        maxResults: Math.min(SEARCH_PAGE_SIZE, limit - ids.length),
        pageToken,
      });
      ids.push(...(res.data.messages || []).map((m) => m.id));
      pageToken = res.data.nextPageToken;
    } while (pageToken && ids.length < limit);
    return ids;
  }

  async removeLabelsFromMessages(ids, labelId) {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      await this.api.users.messages.batchModify({
        userId: USER_ID,
        requestBody: { ids: ids.slice(i, i + BATCH_LIMIT), removeLabelIds: [labelId] },
      });
      if (i + BATCH_LIMIT < ids.length) await sleep(200);
    }
  }

  async deleteLabel(labelId) {
    await this.api.users.labels.delete({ userId: USER_ID, id: labelId });
  }

  async getProfile() {
    const res = await this.api.users.getProfile({ userId: USER_ID });
    return res.data;
  }
}

module.exports = { GmailClient };
