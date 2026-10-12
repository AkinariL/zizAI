{
  const meshHandle = self.onmessage;
  self.onmessage = event => {
    const message = event.data;
    if (!message || message.type !== 'port' || meshPort) return;
    meshPort = message.port;
    meshPort.onmessage = event => {
      const message = event.data;
      if (message.type === 'init') {
        if (message.closePan != null) LAYERS[CLOSE].pan = message.closePan;
        message.meshOptions = {
          ...message.meshOptions,
          sharedMemory: SITE_CONFIG.profile === 'shared',
        };
      }
      return meshHandle(event);
    };
    meshPost({ type: 'attached' });
  };
}
