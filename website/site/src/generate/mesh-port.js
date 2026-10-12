let meshPort = null;
const meshPost = (message, transfer) => meshPort.postMessage(message, transfer || []);
