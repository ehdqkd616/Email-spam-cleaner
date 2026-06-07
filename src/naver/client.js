const { ImapClient } = require('../imap/client');

const NAVER_CONFIG = {
  host: 'imap.naver.com',
  port: 993,
  folders: { INBOX: 'INBOX', TRASH: '휴지통', SPAM: '스팸메일함' },
};

class NaverClient extends ImapClient {
  constructor(credentials) { super(credentials, NAVER_CONFIG); }
}

module.exports = { NaverClient, FOLDERS: NAVER_CONFIG.folders };
