const GPU_STARTUP = (() => {
  const sheets = new Map(),
    metadata = { fontSheets: 0, fontFaces: 0, embeddedFontFaces: 0, embeddedFontBytes: 0, closed: false };
  return {
    metadata,
    recordFontFaces(key, faces) {
      if (metadata.closed || sheets.has(key)) return;
      sheets.set(key, Promise.resolve(faces));
      metadata.fontSheets++;
      metadata.embeddedFontFaces += faces.length;
      metadata.embeddedFontBytes += [...new Set(faces.map(face => face.bytes).filter(Boolean))].reduce(
        (sum, bytes) => sum + bytes.byteLength,
        0,
      );
    },
    async fontManifest() {
      const all = (await Promise.all([...sheets.values()])).flat();
      metadata.fontFaces = all.length;
      return all;
    },
    dispose() {
      metadata.closed = true;
      sheets.clear();
    },
  };
})();
