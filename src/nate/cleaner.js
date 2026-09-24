const { QUERIES, buildCriteria, BAYES_TRAIN } = require('./queries');
const { createCleaner } = require('../imap/cleaner');
module.exports = createCleaner({ QUERIES, buildCriteria, BAYES_TRAIN });
