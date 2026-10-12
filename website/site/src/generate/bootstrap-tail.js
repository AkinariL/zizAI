    const handle = self.onmessage;
    for (const event of waiting.splice(0)) handle(event);
  }
})();
