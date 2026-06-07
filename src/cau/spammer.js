const { QUERIES, buildCriteria } = require('./queries');
const { createSpammer }          = require('../imap/spammer');
module.exports = createSpammer({ QUERIES, buildCriteria });
