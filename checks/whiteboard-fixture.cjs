'use strict';
const { createServer } = require('../server');
const server = createServer();
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ app: 'http://127.0.0.1:' + server.address().port })));
