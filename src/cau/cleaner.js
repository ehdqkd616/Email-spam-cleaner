const { QUERIES, buildCriteria } = require('./queries');
const { createCleaner }          = require('../imap/cleaner');
module.exports = createCleaner({ QUERIES, buildCriteria });
