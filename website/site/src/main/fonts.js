async function loadFonts() {
  await loadEmbeddedFonts();
  const L = (f, t) => document.fonts.load(f, t).catch(() => null);
  await Promise.all([
    L('400 24px "Noto Serif SC"', '竹林风过'),
    L('600 24px "Noto Serif SC"', '竹林'),
    L('400 24px "Shippori Mincho"', '花の下で'),
    L('600 24px "Shippori Mincho"', '花の'),
    L('italic 500 19px "Cormorant Garamond"', 'zhulin'),
    L('500 13px "Cormorant Garamond"', '12345'),
    L('40px "Ma Shan Zheng"', '字在输入'),
    L('40px "Yuji Syuku"', '字在で入力'),
  ]);
  if (window.__zzTest) window.__zzTest.fontsLoaded = true;
}

const timeout = ms => new Promise(res => setTimeout(res, ms));
