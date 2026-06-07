const { ImapClient } = require('../imap/client');

const NATE_CONFIG = {
  host: 'imap.nate.com',
  port: 993,
  folders: { INBOX: 'INBOX', TRASH: '휴지통', SPAM: '스팸' },
};

class NateClient extends ImapClient {
  constructor(credentials) { super(credentials, NATE_CONFIG); }
}

module.exports = { NateClient, FOLDERS: NATE_CONFIG.folders };
